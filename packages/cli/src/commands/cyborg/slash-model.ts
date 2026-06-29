import type { Command } from "commander";
import type { OutputSchema, SingleResult } from "../../output/index.js";
import { connectCyborgClient, toCyborgError, type CyborgCommandOptions } from "./shared.js";

interface SlashModelResult {
  status: string;
  provider: string;
  model: string;
}

const slashModelSchema: OutputSchema<SlashModelResult> = {
  idField: "model",
  columns: [
    { header: "STATUS", field: "status", width: 12 },
    { header: "PROVIDER", field: "provider", width: 16 },
    { header: "MODEL", field: "model", width: 40 },
  ],
};

interface SlashModelOptions extends CyborgCommandOptions {
  clear?: boolean;
}

interface SetSlashModelAck {
  model: { provider: string; model: string } | null;
}

// Set (or clear) the model the user's channel AI commands (/summarize, etc.)
// should prefer. Mirrors the cyborg:set_slash_command_model RPC the Agents tab
// sends. Default (cleared) = auto-resolve (haiku-first, then fallbacks).
export async function runSlashModelCommand(
  _workspaceId: string,
  provider: string | undefined,
  model: string | undefined,
  options: SlashModelOptions,
  _command: Command,
): Promise<SingleResult<SlashModelResult>> {
  const clearing = options.clear === true;
  if (!clearing && (!provider || !model)) {
    throw {
      code: "SLASH_MODEL_ARGS",
      message: "Provide both <provider> and <model>, or pass --clear to reset to auto-resolve.",
    };
  }

  const client = await connectCyborgClient(options);
  try {
    const selection = clearing ? null : { provider: provider as string, model: model as string };
    const ack = await client.request<SetSlashModelAck>("cyborg:set_slash_command_model", {
      model: selection,
    });
    return {
      type: "single",
      data: {
        status: ack.model ? "set" : "cleared (auto)",
        provider: ack.model?.provider ?? "",
        model: ack.model?.model ?? "",
      },
      schema: slashModelSchema,
    };
  } catch (err) {
    throw toCyborgError("SLASH_MODEL_FAILED", "set slash-command model", err);
  } finally {
    client.close();
  }
}
