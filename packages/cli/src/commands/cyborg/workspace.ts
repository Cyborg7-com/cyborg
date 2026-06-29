import type { Command } from "commander";
import type { ListResult, OutputSchema, SingleResult } from "../../output/index.js";
import { connectCyborgClient, toCyborgError, type CyborgCommandOptions } from "./shared.js";

interface WorkspaceRow {
  id: string;
  name: string;
  ownerId: string;
  role: string;
  createdAt: number;
}

const workspaceSchema: OutputSchema<WorkspaceRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 20 },
    { header: "NAME", field: "name", width: 20 },
    { header: "OWNER", field: "ownerId", width: 20 },
    { header: "ROLE", field: "role", width: 10 },
  ],
};

export async function runWsListCommand(
  options: CyborgCommandOptions,
  _command: Command,
): Promise<ListResult<WorkspaceRow>> {
  const client = await connectCyborgClient(options);
  try {
    const resp = await client.request<{ workspaces: WorkspaceRow[] }>(
      "cyborg:fetch_workspaces",
      {},
    );
    return {
      type: "list",
      data: resp.workspaces,
      schema: workspaceSchema,
    };
  } catch (err) {
    throw toCyborgError("WS_LIST_FAILED", "list workspaces", err);
  } finally {
    client.close();
  }
}

export async function runWsCreateCommand(
  name: string,
  options: CyborgCommandOptions,
  _command: Command,
): Promise<SingleResult<WorkspaceRow>> {
  const client = await connectCyborgClient(options);
  try {
    const resp = await client.request<{ workspace: WorkspaceRow }>("cyborg:create_workspace", {
      name,
    });
    return {
      type: "single",
      data: resp.workspace,
      schema: workspaceSchema,
    };
  } catch (err) {
    throw toCyborgError("WS_CREATE_FAILED", "create workspace", err);
  } finally {
    client.close();
  }
}
