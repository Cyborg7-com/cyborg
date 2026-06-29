import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildWorkspaceMcpServer, type McpAuthContext, type McpDeps } from "./server.js";
import type { PgSync } from "../db/pg-sync.js";

// Exercises the MCP task-management plane (list/create/update/delete_task) through
// a real MCP client over an in-memory transport, with typed fakes for the pg/relay
// boundary. Proves: a write-scoped PAT can create/update/delete and it persists +
// broadcasts + audits; a read-only PAT sees list_tasks but NOT the write tools; and
// a viewer user identity is refused before any write.

interface TaskRow {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  status: string;
  assignee_id: string | null;
  created_by: string;
  priority: string | null;
  project_id: string | null;
  due_at: number | null;
}

function ctx(scopes: string[], overrides: Partial<McpAuthContext> = {}): McpAuthContext {
  return {
    tokenId: "mcp_t",
    workspaceId: "ws_1",
    identityType: "cybo",
    identityId: "cybo_1",
    displayName: "Researcher",
    scopes,
    ...overrides,
  };
}

function makeDeps(opts: { role?: string | null } = {}) {
  const tasks: TaskRow[] = [];
  const audits: Record<string, unknown>[] = [];
  const broadcasts: Array<{ workspaceId: string; payload: unknown }> = [];
  const pg = {
    async getMemberRole() {
      return opts.role === undefined ? "member" : opts.role;
    },
    async assertProjectVisible() {
      return true;
    },
    async getTasks(_ws: string, filter?: { status?: string; limit?: number }) {
      let rows = tasks.toReversed();
      if (filter?.status) rows = rows.filter((t) => t.status === filter.status);
      return rows;
    },
    async createTask(o: {
      id: string;
      workspaceId: string;
      title: string;
      createdBy: string;
      description?: string;
      assigneeId?: string;
      priority?: string;
      projectId?: string;
      dueAt?: number;
    }) {
      tasks.push({
        id: o.id,
        workspace_id: o.workspaceId,
        title: o.title,
        description: o.description ?? null,
        status: "pending",
        assignee_id: o.assigneeId ?? null,
        created_by: o.createdBy,
        priority: o.priority ?? null,
        project_id: o.projectId ?? null,
        due_at: o.dueAt ?? null,
      });
    },
    async updateTask(id: string, u: { status?: string; title?: string }) {
      const t = tasks.find((x) => x.id === id);
      if (!t) return;
      if (typeof u.status === "string") t.status = u.status;
      if (typeof u.title === "string") t.title = u.title;
    },
    async deleteTask(id: string) {
      const i = tasks.findIndex((x) => x.id === id);
      if (i >= 0) tasks.splice(i, 1);
    },
    async audit(o: Record<string, unknown>) {
      audits.push(o);
    },
  } as unknown as PgSync;
  const deps: McpDeps = {
    pg,
    relay: {
      injectMessage() {
        return 1;
      },
    },
    broadcastTasksChanged: (workspaceId, payload) => broadcasts.push({ workspaceId, payload }),
  };
  return { deps, tasks, audits, broadcasts };
}

async function connect(
  deps: McpDeps,
  scopes: string[],
  over: Partial<McpAuthContext> = {},
): Promise<Client> {
  const server = buildWorkspaceMcpServer(ctx(scopes, over), deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0.0.0" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  return client;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (r: any) => JSON.parse(r.content.map((c: any) => c.text).join(""));

describe("mcp task tools", () => {
  it("a write PAT: create_task persists, broadcasts, and audits — owned by the identity", async () => {
    const { deps, tasks, audits, broadcasts } = makeDeps();
    const c = await connect(deps, ["read", "write"]);
    const r = body(
      await c.callTool({ name: "create_task", arguments: { title: "Fix bug", priority: "high" } }),
    );
    expect(r.ok).toBe(true);
    expect(r.task.title).toBe("Fix bug");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].created_by).toBe("cybo_1");
    expect(broadcasts).toHaveLength(1);
    expect((broadcasts[0].payload as { op: string }).op).toBe("created");
    expect(audits[0].action).toBe("create_task");
    expect((audits[0].details as { via: string }).via).toBe("mcp");
  });

  it("list_tasks returns workspace tasks (read scope), filterable by status", async () => {
    const { deps } = makeDeps();
    const w = await connect(deps, ["read", "write"]);
    await w.callTool({ name: "create_task", arguments: { title: "A" } });
    const c = await connect(deps, ["read"]);
    const list = body(await c.callTool({ name: "list_tasks", arguments: {} }));
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("A");
    const none = body(await c.callTool({ name: "list_tasks", arguments: { status: "done" } }));
    expect(none).toHaveLength(0);
  });

  it("update_task and delete_task mutate through pg + broadcast", async () => {
    const { deps, tasks, broadcasts } = makeDeps();
    const c = await connect(deps, ["read", "write"]);
    const created = body(await c.callTool({ name: "create_task", arguments: { title: "X" } }));
    await c.callTool({
      name: "update_task",
      arguments: { taskId: created.task.id, status: "done" },
    });
    expect(tasks[0].status).toBe("done");
    const del = body(
      await c.callTool({ name: "delete_task", arguments: { taskId: created.task.id } }),
    );
    expect(del.deleted).toBe(true);
    expect(tasks).toHaveLength(0);
    expect(broadcasts.map((b) => (b.payload as { op: string }).op)).toEqual([
      "created",
      "updated",
      "deleted",
    ]);
  });

  it("a read-only PAT sees list_tasks but NOT the write task tools", async () => {
    const { deps } = makeDeps();
    const c = await connect(deps, ["read"]);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("list_tasks");
    expect(names).not.toContain("create_task");
    expect(names).not.toContain("update_task");
    expect(names).not.toContain("delete_task");
  });

  it("a viewer user identity cannot create tasks", async () => {
    const { deps, tasks } = makeDeps({ role: "viewer" });
    const c = await connect(deps, ["read", "write"], { identityType: "user", identityId: "u_1" });
    const r = body(await c.callTool({ name: "create_task", arguments: { title: "nope" } }));
    expect(r.error).toMatch(/cannot manage tasks/);
    expect(tasks).toHaveLength(0);
  });
});
