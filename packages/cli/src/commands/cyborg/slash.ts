import type { Command } from "commander";
import type { OutputSchema, SingleResult } from "../../output/index.js";
import { connectCyborgClient, toCyborgError, type CyborgCommandOptions } from "./shared.js";

interface SlashResult {
  status: string;
  trigger: string;
  channelId: string;
  result: string;
}

const slashSchema: OutputSchema<SlashResult> = {
  idField: "trigger",
  columns: [
    { header: "STATUS", field: "status", width: 10 },
    { header: "TRIGGER", field: "trigger", width: 12 },
    { header: "CHANNEL", field: "channelId", width: 20 },
    { header: "RESULT", field: "result", width: 60 },
  ],
};

interface SlashOptions extends CyborgCommandOptions {
  daemon?: string;
  wait?: boolean;
  timeout?: string;
}

interface SlashAck {
  ok: boolean;
  trigger: string;
  dispatched: string[];
  error?: string;
  // Ephemeral notices about clamped/ignored args (absent from older daemons).
  warnings?: string[];
}

// Run a channel slash command (e.g. /summarize) — the same cyborg:slash_command
// RPC the channel composer sends. The ack confirms DISPATCH; the result posts
// asynchronously as a channel message, so by default we stay connected and wait
// for the next agent-authored message in the channel.
export async function runSlashCommand(
  workspaceId: string,
  channelId: string,
  trigger: string,
  argTokens: string[],
  options: SlashOptions,
  _command: Command,
): Promise<SingleResult<SlashResult>> {
  const client = await connectCyborgClient(options);
  const cleanTrigger = trigger.replace(/^\//, "").toLowerCase();
  const args = argTokens.join(" ").trim();

  try {
    // Subscribe BEFORE dispatching so a fast result can't slip past us — but
    // only accept messages that arrive AFTER the ack. The server acks on
    // dispatch BEFORE starting the background work, and the WS delivers
    // messages in order, so the command's result always arrives post-ack;
    // gating on the ack discards any pre-existing agent message (e.g. an
    // earlier /summarize result already in the channel). Remaining limitation:
    // an unrelated agent message posted concurrently in the same channel could
    // still be picked up — precise matching needs a server-side correlation id.
    let ackReceived = false;
    let resolveResult: (text: string) => void = () => {};
    const resultPromise = new Promise<string>((resolve) => {
      resolveResult = resolve;
    });
    const unsubscribe = client.onBroadcast((type, payload) => {
      if (!ackReceived || type !== "cyborg:channel_message_broadcast") return;
      const p = payload as { channelId?: string; fromType?: string; text?: string };
      if (p.channelId === channelId && p.fromType === "agent" && p.text) {
        resolveResult(p.text);
      }
    });

    const ack = await client.request<SlashAck>("cyborg:slash_command", {
      workspaceId,
      channelId,
      trigger: cleanTrigger,
      ...(args ? { args } : {}),
      ...(options.daemon ? { daemonId: options.daemon } : {}),
    });
    ackReceived = true;

    // Arg warnings from the dispatch ack ("count clamped", "text ignored") —
    // print to stderr so table/JSON output on stdout stays clean.
    for (const warning of ack.warnings ?? []) {
      console.error(`warning: ${warning}`);
    }

    if (!ack.ok) {
      unsubscribe();
      throw {
        code: "SLASH_FAILED",
        message: `/${cleanTrigger} failed: ${ack.error ?? "unknown error"}`,
      };
    }

    if (options.wait === false) {
      unsubscribe();
      return {
        type: "single",
        data: { status: "dispatched", trigger: cleanTrigger, channelId, result: "" },
        schema: slashSchema,
      };
    }

    // Keep the timer handle and clear it once the result wins — a dangling
    // setTimeout would otherwise hold the Node process open for the full
    // timeout after a fast result, making a successful command look hung.
    const timeoutSec = Number.parseInt(options.timeout ?? "120", 10);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      resultPromise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutSec * 1000);
      }),
    ]);
    clearTimeout(timer);
    unsubscribe();

    if (result === null) {
      throw {
        code: "SLASH_TIMEOUT",
        message: `/${cleanTrigger} was dispatched but no result arrived within ${timeoutSec}s`,
        details:
          "The result may still post to the channel later. Re-run with --no-wait to only dispatch.",
      };
    }

    return {
      type: "single",
      data: { status: "completed", trigger: cleanTrigger, channelId, result },
      schema: slashSchema,
    };
  } catch (err) {
    throw toCyborgError("SLASH_FAILED", `run /${cleanTrigger}`, err);
  } finally {
    client.close();
  }
}
