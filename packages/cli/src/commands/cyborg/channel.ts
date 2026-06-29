import type { Command } from "commander";
import type { ListResult, OutputSchema, SingleResult } from "../../output/index.js";
import { connectCyborgClient, toCyborgError, type CyborgCommandOptions } from "./shared.js";

interface ChannelRow {
  id: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  createdBy: string;
  createdAt: number;
}

const channelSchema: OutputSchema<ChannelRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 20 },
    { header: "NAME", field: "name", width: 20 },
    { header: "DESCRIPTION", field: "description", width: 30 },
    {
      header: "PRIVATE",
      field: (c) => (c.isPrivate ? "yes" : "no"),
      width: 7,
    },
    { header: "CREATED BY", field: "createdBy", width: 20 },
  ],
};

interface ChCreateOptions extends CyborgCommandOptions {
  description?: string;
  private?: boolean;
}

export async function runChListCommand(
  workspaceId: string,
  options: CyborgCommandOptions,
  _command: Command,
): Promise<ListResult<ChannelRow>> {
  const client = await connectCyborgClient(options);
  try {
    const resp = await client.request<{ channels: ChannelRow[] }>("cyborg:fetch_channels", {
      workspaceId,
    });
    return {
      type: "list",
      data: resp.channels,
      schema: channelSchema,
    };
  } catch (err) {
    throw toCyborgError("CH_LIST_FAILED", "list channels", err);
  } finally {
    client.close();
  }
}

export async function runChCreateCommand(
  workspaceId: string,
  name: string,
  options: ChCreateOptions,
  _command: Command,
): Promise<SingleResult<ChannelRow>> {
  const client = await connectCyborgClient(options);
  try {
    const resp = await client.request<{ channel: ChannelRow }>("cyborg:create_channel", {
      workspaceId,
      name,
      description: options.description,
      isPrivate: options.private ?? false,
    });
    return {
      type: "single",
      data: resp.channel,
      schema: channelSchema,
    };
  } catch (err) {
    throw toCyborgError("CH_CREATE_FAILED", "create channel", err);
  } finally {
    client.close();
  }
}
