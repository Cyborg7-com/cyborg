import type { Command } from "commander";
import type { OutputSchema, SingleResult } from "../../output/index.js";
import { connectCyborgClient, toCyborgError, type CyborgCommandOptions } from "./shared.js";

interface ChannelModelResult {
  status: string;
  channelId: string;
  provider: string;
  model: string;
}

const channelModelSchema: OutputSchema<ChannelModelResult> = {
  idField: "channelId",
  columns: [
    { header: "STATUS", field: "status", width: 12 },
    { header: "CHANNEL", field: "channelId", width: 20 },
    { header: "PROVIDER", field: "provider", width: 16 },
    { header: "MODEL", field: "model", width: 40 },
  ],
};

interface ChannelModelOptions extends CyborgCommandOptions {
  clear?: boolean;
}

interface SetChannelModelAck {
  channelId: string;
  model: { provider: string; model: string } | null;
}

// Set (or clear) the per-CHANNEL model override for channel AI commands. Wins
// over the user's default; cleared = inherit (user default → auto-resolve).
// Mirrors `cyborg slash:model` (user-level) but scoped to one channel.
export async function runChannelModelCommand(
  workspaceId: string,
  channelId: string,
  provider: string | undefined,
  model: string | undefined,
  options: ChannelModelOptions,
  _command: Command,
): Promise<SingleResult<ChannelModelResult>> {
  const clearing = options.clear === true;
  if (!clearing && (!provider || !model)) {
    throw {
      code: "CHANNEL_MODEL_ARGS",
      message: "Provide both <provider> and <model>, or pass --clear to inherit the default.",
    };
  }

  const client = await connectCyborgClient(options);
  try {
    const selection = clearing ? null : { provider: provider as string, model: model as string };
    const ack = await client.request<SetChannelModelAck>("cyborg:set_channel_slash_command_model", {
      workspaceId,
      channelId,
      model: selection,
    });
    return {
      type: "single",
      data: {
        status: ack.model ? "set" : "cleared (inherit)",
        channelId: ack.channelId,
        provider: ack.model?.provider ?? "",
        model: ack.model?.model ?? "",
      },
      schema: channelModelSchema,
    };
  } catch (err) {
    throw toCyborgError("CHANNEL_MODEL_FAILED", "set channel AI model", err);
  } finally {
    client.close();
  }
}
