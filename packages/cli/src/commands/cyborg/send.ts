import type { Command } from "commander";
import type { OutputSchema, SingleResult } from "../../output/index.js";
import { connectCyborgClient, toCyborgError, type CyborgCommandOptions } from "./shared.js";

interface SendResult {
  status: string;
  workspaceId: string;
  channelId: string;
  text: string;
}

const sendSchema: OutputSchema<SendResult> = {
  idField: "status",
  columns: [
    { header: "STATUS", field: "status", width: 8 },
    { header: "WORKSPACE", field: "workspaceId", width: 20 },
    { header: "CHANNEL", field: "channelId", width: 20 },
    { header: "TEXT", field: "text", width: 40 },
  ],
};

interface SendOptions extends CyborgCommandOptions {
  mention?: string[];
}

export async function runSendCommand(
  workspaceId: string,
  channelId: string,
  text: string,
  options: SendOptions,
  _command: Command,
): Promise<SingleResult<SendResult>> {
  const client = await connectCyborgClient(options);
  try {
    client.fire("cyborg:channel_message", {
      workspaceId,
      channelId,
      text,
      mentions: options.mention?.length ? options.mention : undefined,
    });
    // fire-and-forget, give server a moment to process
    await new Promise((r) => setTimeout(r, 200));
    return {
      type: "single",
      data: { status: "sent", workspaceId, channelId, text },
      schema: sendSchema,
    };
  } catch (err) {
    throw toCyborgError("SEND_FAILED", "send message", err);
  } finally {
    client.close();
  }
}
