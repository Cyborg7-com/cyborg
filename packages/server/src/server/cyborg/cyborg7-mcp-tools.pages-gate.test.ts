import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createCyborg7McpServer,
  type Cyborg7McpContext,
  type Cyborg7McpDeps,
} from "./cyborg7-mcp-tools.js";

// The internal (cybo-facing) MCP server's Tasks feature gate + the new READ-ONLY
// Page tools. When the workspace has no Tasks provisioned (tasksEnabled:false) the
// task tools AND the Page read tools are withheld; the channel/roster/docs tools
// stay. When enabled, cyborg7_list_pages / cyborg7_read_page surface exactly the
// owner-visibility-gated rows the relay returns (the cybo never fabricates pages).

type CyboRead = NonNullable<Cyborg7McpDeps["cyboRead"]>;

function makeDeps(cyboRead?: CyboRead): Cyborg7McpDeps {
  // listTools never invokes a handler; the page handlers only touch cyboRead. The
  // other deps are unused on these paths, so a structural stub is enough.
  return {
    storage: {} as Cyborg7McpDeps["storage"],
    messageRouter: {} as Cyborg7McpDeps["messageRouter"],
    workspaceManager: {} as Cyborg7McpDeps["workspaceManager"],
    cyboRead,
  } as Cyborg7McpDeps;
}

async function connect(deps: Cyborg7McpDeps, ctx: Cyborg7McpContext): Promise<Client> {
  const server = createCyborg7McpServer(deps, ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  return client;
}

async function toolNames(deps: Cyborg7McpDeps, ctx: Cyborg7McpContext): Promise<string[]> {
  const c = await connect(deps, ctx);
  try {
    return (await c.listTools()).tools.map((t) => t.name);
  } finally {
    await c.close();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const text = (r: any) => r.content.map((c: any) => c.text).join("");

const baseCtx = (over: Partial<Cyborg7McpContext> = {}): Cyborg7McpContext => ({
  workspaceId: "ws_1",
  agentId: "ag_1",
  cyboId: "cybo_1",
  ...over,
});

const TASK_TOOLS = [
  "cyborg7_list_tasks",
  "cyborg7_list_projects",
  "cyborg7_create_task",
  "cyborg7_update_task",
  "cyborg7_archive_task",
  "cyborg7_delete_task",
  "cyborg7_bulk_update_tasks",
];
const PAGE_TOOLS = ["cyborg7_list_pages", "cyborg7_read_page"];

describe("cyborg7 mcp — Tasks feature gate", () => {
  it("Tasks DISABLED withholds every task + page tool, keeps channel/roster/docs", async () => {
    const names = await toolNames(makeDeps(), baseCtx({ tasksEnabled: false }));
    for (const t of [...TASK_TOOLS, ...PAGE_TOOLS]) expect(names).not.toContain(t);
    expect(names).toContain("cyborg7_list_channels");
    expect(names).toContain("cyborg7_get_workspace_roster");
    expect(names).toContain("cyborg7_read_docs");
  });

  it("Tasks ENABLED exposes the task + page read tools", async () => {
    const names = await toolNames(makeDeps(), baseCtx({ tasksEnabled: true }));
    for (const t of [...TASK_TOOLS, ...PAGE_TOOLS]) expect(names).toContain(t);
  });

  it("omitting tasksEnabled defaults to ENABLED (page tools present)", async () => {
    const names = await toolNames(makeDeps(), baseCtx());
    for (const t of PAGE_TOOLS) expect(names).toContain(t);
  });
});

describe("cyborg7 mcp — Page read tools surface the owner-gated relay result", () => {
  // A fake relay round-trip standing in for the owner-visibility gate applied in
  // workspace-relay.handleCyboRead: it returns pages only for a project the owner
  // can see, and a single page WITH content; a hidden project / page fails.
  const cyboRead: CyboRead = async (req) => {
    if (req.kind === "pages") {
      if (req.projectId === "proj_hidden") return { ok: false, error: "project not found" };
      return {
        ok: true,
        pages: [
          { id: "page_root", title: "Spec", parentId: null, icon: null },
          { id: "page_child", title: "Details", parentId: "page_root", icon: "📄" },
        ],
      };
    }
    if (req.kind === "page") {
      if (req.pageId === "page_root") {
        return {
          ok: true,
          page: {
            id: "page_root",
            title: "Spec",
            content: "<h1>Spec</h1>",
            parentId: null,
            icon: null,
          },
        };
      }
      return { ok: false, error: "page not found in this workspace" };
    }
    return { ok: true };
  };

  it("list_pages returns the project's visible page hierarchy", async () => {
    const c = await connect(makeDeps(cyboRead), baseCtx({ tasksEnabled: true }));
    const out = JSON.parse(
      text(await c.callTool({ name: "cyborg7_list_pages", arguments: { projectId: "proj_1" } })),
    );
    expect(out).toEqual([
      { id: "page_root", title: "Spec", parentId: null, icon: null },
      { id: "page_child", title: "Details", parentId: "page_root", icon: "📄" },
    ]);
    await c.close();
  });

  it("list_pages surfaces the relay's authz failure for a project the owner can't see", async () => {
    const c = await connect(makeDeps(cyboRead), baseCtx({ tasksEnabled: true }));
    const out = text(
      await c.callTool({ name: "cyborg7_list_pages", arguments: { projectId: "proj_hidden" } }),
    );
    expect(out).toMatch(/project not found/);
    await c.close();
  });

  it("read_page returns a visible page WITH its body content", async () => {
    const c = await connect(makeDeps(cyboRead), baseCtx({ tasksEnabled: true }));
    const out = JSON.parse(
      text(await c.callTool({ name: "cyborg7_read_page", arguments: { pageId: "page_root" } })),
    );
    expect(out).toMatchObject({ id: "page_root", title: "Spec", content: "<h1>Spec</h1>" });
    await c.close();
  });

  it("read_page surfaces not-found for a page outside the owner's visibility", async () => {
    const c = await connect(makeDeps(cyboRead), baseCtx({ tasksEnabled: true }));
    const out = text(
      await c.callTool({ name: "cyborg7_read_page", arguments: { pageId: "page_private" } }),
    );
    expect(out).toMatch(/not found/);
    await c.close();
  });
});
