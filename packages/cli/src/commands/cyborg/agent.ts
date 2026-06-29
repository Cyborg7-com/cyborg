import type { Command } from "commander";
import type { ListResult, OutputSchema, SingleResult } from "../../output/index.js";
import { connectCyborgClient, toCyborgError, type CyborgCommandOptions } from "./shared.js";

interface AgentRow {
  agentId: string;
  provider: string;
  channelId: string | null;
  lifecycle?: string;
  createdAt?: number;
}

const agentSchema: OutputSchema<AgentRow> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId", width: 24 },
    { header: "PROVIDER", field: "provider", width: 12 },
    { header: "CHANNEL", field: (a) => a.channelId ?? "-", width: 20 },
    {
      header: "STATUS",
      field: (a) => a.lifecycle ?? "-",
      width: 10,
      color: (v) => {
        if (v === "running") return "green";
        if (v === "stopped" || v === "error") return "red";
        return "dim";
      },
    },
  ],
};

interface AgentCreateOptions extends CyborgCommandOptions {
  provider?: string;
  model?: string;
  channel?: string;
  systemPrompt?: string;
  cwd?: string;
}

export async function runAgentCreateCommand(
  workspaceId: string,
  options: AgentCreateOptions,
  _command: Command,
): Promise<SingleResult<AgentRow>> {
  const client = await connectCyborgClient(options);
  try {
    const resp = await client.request<{ agent: AgentRow }>("cyborg:create_agent", {
      workspaceId,
      ...(options.daemon ? { daemonId: options.daemon } : {}),
      provider: options.provider ?? "claude",
      model: options.model,
      channelId: options.channel,
      systemPrompt: options.systemPrompt,
      cwd: options.cwd ?? process.cwd(),
    });
    return {
      type: "single",
      data: resp.agent,
      schema: agentSchema,
    };
  } catch (err) {
    throw toCyborgError("AGENT_CREATE_FAILED", "create agent", err);
  } finally {
    client.close();
  }
}

export async function runAgentListCommand(
  workspaceId: string,
  options: CyborgCommandOptions,
  _command: Command,
): Promise<ListResult<AgentRow>> {
  const client = await connectCyborgClient(options);
  try {
    const resp = await client.request<{ agents: AgentRow[] }>("cyborg:list_agents", {
      workspaceId,
      ...(options.daemon ? { daemonId: options.daemon } : {}),
    });
    return {
      type: "list",
      data: resp.agents,
      schema: agentSchema,
    };
  } catch (err) {
    throw toCyborgError("AGENT_LIST_FAILED", "list agents", err);
  } finally {
    client.close();
  }
}

interface AgentPromptOptions extends CyborgCommandOptions {
  noStream?: boolean;
}

interface AgentPromptResult {
  status: string;
  agentId: string;
}

const promptSchema: OutputSchema<AgentPromptResult> = {
  idField: "agentId",
  columns: [
    { header: "STATUS", field: "status", width: 10 },
    { header: "AGENT ID", field: "agentId", width: 24 },
  ],
};

export async function runAgentPromptCommand(
  workspaceId: string,
  agentId: string,
  prompt: string,
  options: AgentPromptOptions,
  _command: Command,
): Promise<SingleResult<AgentPromptResult>> {
  const client = await connectCyborgClient(options);

  if (options.noStream) {
    try {
      const resp = await client.request<{ status: string }>("cyborg:send_agent_prompt", {
        workspaceId,
        ...(options.daemon ? { daemonId: options.daemon } : {}),
        agentId,
        prompt,
      });
      return {
        type: "single",
        data: { status: resp.status, agentId },
        schema: promptSchema,
      };
    } catch (err) {
      throw toCyborgError("AGENT_PROMPT_FAILED", "prompt agent", err);
    } finally {
      client.close();
    }
  }

  try {
    await streamAgentPrompt(client, workspaceId, agentId, prompt);
  } catch (err) {
    throw toCyborgError("AGENT_PROMPT_FAILED", "prompt agent", err);
  } finally {
    client.close();
  }

  return {
    type: "single",
    data: { status: "completed", agentId },
    schema: promptSchema,
  };
}

async function streamAgentPrompt(
  client: Awaited<ReturnType<typeof connectCyborgClient>>,
  workspaceId: string,
  agentId: string,
  prompt: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let resolved = false;
    let hasOutput = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        unsub();
        if (!hasOutput) {
          reject(new Error("Agent did not respond within 120s"));
        } else {
          process.stdout.write("\n");
          resolve();
        }
      }
    }, 120_000);

    // oxlint-disable-next-line eslint/complexity -- event handler with multiple stream event types
    const unsub = client.onBroadcast((type, payload) => {
      if (resolved) return;

      const payloadAgentId = payload.agentId as string | undefined;
      if (payloadAgentId !== agentId) return;

      if (type === "cyborg:agent_stream") {
        const event = payload.event as Record<string, unknown> | undefined;
        if (!event) return;

        switch (event.type) {
          case "assistant_message": {
            hasOutput = true;
            process.stdout.write(event.text as string);
            break;
          }
          case "timeline": {
            const item = event.item as Record<string, unknown> | undefined;
            if (item?.type === "assistant_message" && item.text) {
              hasOutput = true;
              process.stdout.write(item.text as string);
            }
            if (item?.type === "tool_use") {
              const name = item.name as string;
              process.stderr.write(`\x1b[2m[tool: ${name}]\x1b[0m\n`);
            }
            if (item?.type === "tool_result") {
              const status = (item as { is_error?: boolean }).is_error ? "error" : "ok";
              process.stderr.write(`\x1b[2m[tool result: ${status}]\x1b[0m\n`);
            }
            break;
          }
          case "turn_completed": {
            resolved = true;
            clearTimeout(timeout);
            unsub();
            if (hasOutput) process.stdout.write("\n");
            resolve();
            break;
          }
          case "turn_failed": {
            resolved = true;
            clearTimeout(timeout);
            unsub();
            if (hasOutput) process.stdout.write("\n");
            const error = event.error as string | undefined;
            reject(new Error(error ?? "Agent turn failed"));
            break;
          }
        }
      }

      if (type === "cyborg:agent_status") {
        const status = payload.status as string;
        if (status === "idle" && hasOutput && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          unsub();
          process.stdout.write("\n");
          resolve();
        }
        if (status === "error" && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          unsub();
          if (hasOutput) process.stdout.write("\n");
          reject(new Error("Agent entered error state"));
        }
      }
    });

    client
      .request<{ status: string }>("cyborg:send_agent_prompt", {
        workspaceId,
        agentId,
        prompt,
      })
      .catch((err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          unsub();
          reject(err);
        }
      });
  });
}

interface AgentControlResult {
  agentId: string;
  status: string;
}

const controlSchema: OutputSchema<AgentControlResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId", width: 24 },
    { header: "STATUS", field: "status", width: 16 },
  ],
};

export async function runAgentStopCommand(
  workspaceId: string,
  agentId: string,
  options: CyborgCommandOptions,
  _command: Command,
): Promise<SingleResult<AgentControlResult>> {
  const client = await connectCyborgClient(options);
  try {
    const resp = await client.request<{ status: string }>("cyborg:cancel_agent", {
      workspaceId,
      agentId,
    });
    return {
      type: "single",
      data: { agentId, status: resp.status ?? "canceling" },
      schema: controlSchema,
    };
  } catch (err) {
    throw toCyborgError("AGENT_STOP_FAILED", "stop agent", err);
  } finally {
    client.close();
  }
}

export async function runAgentModeCommand(
  workspaceId: string,
  agentId: string,
  mode: string,
  options: CyborgCommandOptions,
  _command: Command,
): Promise<SingleResult<AgentControlResult>> {
  const client = await connectCyborgClient(options);
  try {
    const resp = await client.request<{ status: string }>("cyborg:set_agent_mode", {
      workspaceId,
      agentId,
      modeId: mode,
    });
    return {
      type: "single",
      data: { agentId, status: resp.status ?? "ok" },
      schema: controlSchema,
    };
  } catch (err) {
    throw toCyborgError("AGENT_MODE_FAILED", "set agent mode", err);
  } finally {
    client.close();
  }
}

export async function runAgentModelCommand(
  workspaceId: string,
  agentId: string,
  model: string,
  options: CyborgCommandOptions,
  _command: Command,
): Promise<SingleResult<AgentControlResult>> {
  const client = await connectCyborgClient(options);
  try {
    const resp = await client.request<{ status: string }>("cyborg:set_agent_model", {
      workspaceId,
      agentId,
      // "default" clears the per-agent override back to the provider default.
      modelId: model === "default" ? null : model,
    });
    return {
      type: "single",
      data: { agentId, status: resp.status ?? "ok" },
      schema: controlSchema,
    };
  } catch (err) {
    throw toCyborgError("AGENT_MODEL_FAILED", "set agent model", err);
  } finally {
    client.close();
  }
}
