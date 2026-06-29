import type { Command } from "commander";
import type { ListResult, OutputSchema } from "../../output/index.js";
import { connectCyborgClient, toCyborgError, type CyborgCommandOptions } from "./shared.js";

// Task project (the `tp_` id namespace). `id` (or `chatProjectId`) is what you
// pass as `projectId` to task:create / task:list. The Inbox is isInbox=true.
interface ProjectRow {
  id: string;
  identifier: string;
  name: string;
  color: string;
  isInbox: boolean;
  chatProjectId: string | null;
}

const projectSchema: OutputSchema<ProjectRow> = {
  idField: "id",
  columns: [
    { header: "IDENTIFIER", field: "identifier", width: 14 },
    { header: "NAME", field: "name", width: 24 },
    { header: "ID", field: "id", width: 20 },
    { header: "INBOX", field: (p) => (p.isInbox ? "yes" : "no"), width: 6 },
  ],
};

export async function runProjectListCommand(
  workspaceId: string,
  options: CyborgCommandOptions,
  _command: Command,
): Promise<ListResult<ProjectRow>> {
  const client = await connectCyborgClient(options);
  try {
    const resp = await client.request<{ projects: ProjectRow[] }>("cyborg:fetch_tasks_projects", {
      workspaceId,
    });
    return {
      type: "list",
      data: resp.projects,
      schema: projectSchema,
    };
  } catch (err) {
    throw toCyborgError("PROJECT_LIST_FAILED", "list projects", err);
  } finally {
    client.close();
  }
}
