import type { Command } from "commander";
import type { CommandError, ListResult, OutputSchema, SingleResult } from "../../output/index.js";
import { connectCyborgClient, toCyborgError, type CyborgCommandOptions } from "./shared.js";

// Task READ rows come back snake_case from the server (see the wire contract).
// camelCase fields (workspaceId, assigneeId, createdBy, dueAt, …) and snake_case
// fields (project_id, parent_id, …) are kept verbatim as the server emits them.
interface TaskRow {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  status: string;
  assigneeId: string | null;
  createdBy: string;
  dueAt: number | null;
  createdAt: number;
  updatedAt: number;
  priority?: string | null;
  project_id?: string | null;
  parent_id?: string | null;
  state_id?: string | null;
  sequence_id?: string | null;
  cycle_id?: string | null;
  label_ids?: string[] | null;
  module_ids?: string[] | null;
}

const taskSchema: OutputSchema<TaskRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 20 },
    { header: "TITLE", field: "title", width: 30 },
    { header: "STATUS", field: "status", width: 12 },
    { header: "PRIORITY", field: (t) => t.priority ?? "-", width: 10 },
    { header: "PROJECT", field: (t) => t.project_id ?? "-", width: 20 },
    { header: "ASSIGNEE", field: (t) => t.assigneeId ?? "-", width: 20 },
  ],
};

// ISO 8601 string -> epoch ms (the server expects numbers). Surfaces a clear
// CommandError on an unparseable date so the user fixes the input, not the wire.
function parseIsoToMs(value: string, optionName: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    const error: CommandError = {
      code: "INVALID_DATE",
      message: `Invalid date for ${optionName}: "${value}". Use an ISO 8601 date (e.g. 2026-06-30T17:00:00Z).`,
    };
    throw error;
  }
  return ms;
}

function parsePositiveInt(value: string, optionName: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    const error: CommandError = {
      code: "INVALID_NUMBER",
      message: `Invalid value for ${optionName}: "${value}". Expected a positive integer.`,
    };
    throw error;
  }
  return n;
}

interface TaskCreateOptions extends CyborgCommandOptions {
  description?: string;
  assignee?: string;
  due?: string;
  channel?: string;
  priority?: string;
  project?: string;
  parent?: string;
  state?: string;
  start?: string;
  label?: string[];
  cycle?: string;
  module?: string[];
}

export async function runTaskCreateCommand(
  workspaceId: string,
  title: string,
  options: TaskCreateOptions,
  _command: Command,
): Promise<SingleResult<TaskRow>> {
  // Validate/convert inputs before opening a connection.
  const dueAt = options.due !== undefined ? parseIsoToMs(options.due, "--due") : undefined;
  const startDate =
    options.start !== undefined ? parseIsoToMs(options.start, "--start") : undefined;
  const labels = options.label && options.label.length > 0 ? options.label : undefined;
  const moduleIds = options.module && options.module.length > 0 ? options.module : undefined;

  const client = await connectCyborgClient(options);
  try {
    // SERVER requires one of projectId|channelId|parentId — let it error if missing.
    const resp = await client.request<{ task: TaskRow }>("cyborg:create_task", {
      workspaceId,
      title,
      description: options.description,
      assigneeId: options.assignee,
      dueAt,
      channelId: options.channel,
      priority: options.priority,
      projectId: options.project,
      parentId: options.parent,
      stateId: options.state,
      startDate,
      labels,
      cycleId: options.cycle,
      moduleIds,
    });
    return {
      type: "single",
      data: resp.task,
      schema: taskSchema,
    };
  } catch (err) {
    throw toCyborgError("TASK_CREATE_FAILED", "create task", err);
  } finally {
    client.close();
  }
}

interface TaskListOptions extends CyborgCommandOptions {
  status?: string;
  assignee?: string;
  project?: string;
  limit?: string;
  cursor?: string;
}

export async function runTaskListCommand(
  workspaceId: string,
  options: TaskListOptions,
  _command: Command,
): Promise<ListResult<TaskRow>> {
  const limit =
    options.limit !== undefined ? parsePositiveInt(options.limit, "--limit") : undefined;

  const client = await connectCyborgClient(options);
  try {
    const resp = await client.request<{ tasks: TaskRow[]; nextCursor?: string }>(
      "cyborg:fetch_tasks",
      {
        workspaceId,
        status: options.status,
        assigneeId: options.assignee,
        projectId: options.project,
        limit,
        cursor: options.cursor,
      },
    );
    return {
      type: "list",
      data: resp.tasks,
      schema: taskSchema,
    };
  } catch (err) {
    throw toCyborgError("TASK_LIST_FAILED", "list tasks", err);
  } finally {
    client.close();
  }
}

interface TaskUpdateOptions extends CyborgCommandOptions {
  status?: string;
  title?: string;
  description?: string;
  assignee?: string;
  result?: string;
  due?: string;
  priority?: string;
  project?: string;
  parent?: string;
  state?: string;
  start?: string;
  label?: string[];
  cycle?: string;
  module?: string[];
}

export async function runTaskUpdateCommand(
  workspaceId: string,
  taskId: string,
  options: TaskUpdateOptions,
  _command: Command,
): Promise<SingleResult<TaskRow>> {
  const dueAt = options.due !== undefined ? parseIsoToMs(options.due, "--due") : undefined;
  const startDate =
    options.start !== undefined ? parseIsoToMs(options.start, "--start") : undefined;
  const labels = options.label && options.label.length > 0 ? options.label : undefined;
  const moduleIds = options.module && options.module.length > 0 ? options.module : undefined;

  const client = await connectCyborgClient(options);
  try {
    const resp = await client.request<{ task: TaskRow }>("cyborg:update_task", {
      workspaceId,
      taskId,
      status: options.status,
      title: options.title,
      description: options.description,
      assigneeId: options.assignee,
      result: options.result,
      dueAt,
      priority: options.priority,
      projectId: options.project,
      parentId: options.parent,
      stateId: options.state,
      startDate,
      labels,
      cycleId: options.cycle,
      moduleIds,
    });
    return {
      type: "single",
      data: resp.task,
      schema: taskSchema,
    };
  } catch (err) {
    throw toCyborgError("TASK_UPDATE_FAILED", "update task", err);
  } finally {
    client.close();
  }
}

interface TaskArchiveOptions extends CyborgCommandOptions {
  unarchive?: boolean;
}

export async function runTaskArchiveCommand(
  workspaceId: string,
  taskId: string,
  options: TaskArchiveOptions,
  _command: Command,
): Promise<SingleResult<TaskRow>> {
  const client = await connectCyborgClient(options);
  try {
    const resp = await client.request<{ task: TaskRow }>("cyborg:archive_task", {
      workspaceId,
      taskId,
      // Default archives; --unarchive flips it to restore.
      archived: !options.unarchive,
    });
    return {
      type: "single",
      data: resp.task,
      schema: taskSchema,
    };
  } catch (err) {
    throw toCyborgError("TASK_ARCHIVE_FAILED", "archive task", err);
  } finally {
    client.close();
  }
}

interface TaskDeleteResult {
  taskId: string;
  deleted: boolean;
}

const taskDeleteSchema: OutputSchema<TaskDeleteResult> = {
  idField: "taskId",
  columns: [
    { header: "TASK ID", field: "taskId", width: 24 },
    { header: "DELETED", field: (t) => (t.deleted ? "yes" : "no"), width: 8 },
  ],
};

export async function runTaskDeleteCommand(
  workspaceId: string,
  taskId: string,
  options: CyborgCommandOptions,
  _command: Command,
): Promise<SingleResult<TaskDeleteResult>> {
  const client = await connectCyborgClient(options);
  try {
    const resp = await client.request<{ taskId: string; deleted: boolean }>("cyborg:delete_task", {
      workspaceId,
      taskId,
    });
    return {
      type: "single",
      data: { taskId: resp.taskId, deleted: resp.deleted },
      schema: taskDeleteSchema,
    };
  } catch (err) {
    throw toCyborgError("TASK_DELETE_FAILED", "delete task", err);
  } finally {
    client.close();
  }
}

interface TaskBulkUpdateOptions extends CyborgCommandOptions {
  status?: string;
  priority?: string;
  assignee?: string;
  due?: string;
  archived?: boolean;
  unarchive?: boolean;
}

export async function runTaskBulkUpdateCommand(
  workspaceId: string,
  taskIds: string[],
  options: TaskBulkUpdateOptions,
  _command: Command,
): Promise<ListResult<TaskRow>> {
  const dueAt = options.due !== undefined ? parseIsoToMs(options.due, "--due") : undefined;

  // --archived sets archivedAt to now; --unarchive clears it (null). Absent -> undefined.
  let archivedAt: number | null | undefined;
  if (options.archived) {
    archivedAt = Date.now();
  } else if (options.unarchive) {
    archivedAt = null;
  }

  const client = await connectCyborgClient(options);
  try {
    const resp = await client.request<{ tasks: TaskRow[] }>("cyborg:bulk_update_tasks", {
      workspaceId,
      taskIds,
      updates: {
        status: options.status,
        priority: options.priority,
        assigneeId: options.assignee,
        dueAt,
        archivedAt,
      },
    });
    return {
      type: "list",
      data: resp.tasks,
      schema: taskSchema,
    };
  } catch (err) {
    throw toCyborgError("TASK_BULK_UPDATE_FAILED", "bulk update tasks", err);
  } finally {
    client.close();
  }
}
