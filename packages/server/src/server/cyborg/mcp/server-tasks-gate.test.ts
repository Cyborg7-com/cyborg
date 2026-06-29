import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildWorkspaceMcpServer, type McpAuthContext, type McpDeps } from "./server.js";
import type { PgSync } from "../db/pg-sync.js";

// The Tasks feature gate (McpDeps.tasksEnabled): when the workspace has NO Tasks
// provisioned, the external PAT server must not advertise the task-management OR
// page tools (pages are part of Tasks). The non-task tools (whoami, channels,
// post_message, …) stay available regardless of the gate.

function ctx(scopes: string[]): McpAuthContext {
  return {
    tokenId: "mcp_t",
    workspaceId: "ws_1",
    identityType: "user",
    identityId: "u_1",
    displayName: "R",
    scopes,
  };
}

async function names(tasksEnabled: boolean, scopes: string[]): Promise<string[]> {
  // listTools never invokes a handler, so a bare pg stub is enough here.
  const deps: McpDeps = {
    pg: {} as unknown as PgSync,
    relay: { injectMessage: () => 1 },
    tasksEnabled,
  };
  const server = buildWorkspaceMcpServer(ctx(scopes), deps);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

const TASK_TOOLS = ["list_tasks", "create_task", "update_task", "delete_task"];
const PAGE_TOOLS = ["list_pages", "read_page", "create_page", "update_page", "delete_page"];

describe("mcp external server — Tasks feature gate", () => {
  it("Tasks DISABLED: no task or page tools, but the non-task tools remain", async () => {
    const n = await names(false, ["read", "write"]);
    for (const t of [...TASK_TOOLS, ...PAGE_TOOLS]) expect(n).not.toContain(t);
    // The collaboration tools are unaffected by the Tasks gate.
    expect(n).toContain("whoami");
    expect(n).toContain("list_channels");
    expect(n).toContain("read_channel");
    expect(n).toContain("post_message");
    expect(n).toContain("reply_in_thread");
  });

  it("Tasks ENABLED: the task + page tools appear (scoped by read/write)", async () => {
    const n = await names(true, ["read", "write"]);
    for (const t of [...TASK_TOOLS, ...PAGE_TOOLS]) expect(n).toContain(t);
  });

  it("Tasks ENABLED, read-only token: read task/page tools only, no writes", async () => {
    const n = await names(true, ["read"]);
    expect(n).toContain("list_tasks");
    expect(n).toContain("list_pages");
    expect(n).toContain("read_page");
    expect(n).not.toContain("create_task");
    expect(n).not.toContain("create_page");
  });

  it("Tasks DISABLED with a read-only token still withholds the read task/page tools", async () => {
    const n = await names(false, ["read"]);
    expect(n).not.toContain("list_tasks");
    expect(n).not.toContain("list_pages");
    expect(n).not.toContain("read_page");
    // whoami + the channel reads stay.
    expect(n).toContain("whoami");
    expect(n).toContain("list_channels");
  });
});
