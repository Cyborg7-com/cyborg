import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildWorkspaceMcpServer, type McpAuthContext, type McpDeps } from "./server.js";
import type { PgSync } from "../db/pg-sync.js";
import { PageCycleError, isPageDescendant } from "../page-access.js";

// Verifies the MCP Page tools, and specifically that an agent uploading MARKDOWN
// gets it stored as HTML (the TipTap Page editor renders HTML — raw markdown would
// show as one plain paragraph). A read-only PAT must not see the write page tools.

interface PageRow {
  id: string;
  project_id: string;
  workspace_id: string;
  title: string;
  content: string | null;
  visibility: string;
  parent_id: string | null;
  sort_order: number;
  owned_by: string | null;
}

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

function makeDeps() {
  const pages: PageRow[] = [];
  const pg = {
    async getMemberRole() {
      return "member";
    },
    async assertProjectVisible() {
      return true;
    },
    async insertPage(o: {
      projectId: string;
      title?: string;
      ownedBy?: string | null;
      parentId?: string | null;
    }) {
      // Mirror PgSync.insertPage: a parent must live in the SAME project.
      if (o.parentId) {
        const parent = pages.find((x) => x.id === o.parentId);
        if (!parent || parent.project_id !== o.projectId) {
          throw new Error("parent page not found in this project");
        }
      }
      const row: PageRow = {
        id: `page_${pages.length + 1}`,
        project_id: o.projectId,
        workspace_id: "ws_1",
        title: o.title ?? "Untitled",
        content: null,
        visibility: "private",
        parent_id: o.parentId ?? null,
        sort_order: 0,
        owned_by: o.ownedBy ?? null,
      };
      pages.push(row);
      return row;
    },
    async updatePage(
      id: string,
      u: { title?: string; content?: string; parentId?: string | null; sortOrder?: number },
    ) {
      const p = pages.find((x) => x.id === id);
      if (!p) return null;
      if (u.parentId !== undefined && u.parentId !== null) {
        // Exercise the REAL shared guard (isPageDescendant) so the test proves the
        // production algorithm, not a re-implementation.
        if (u.parentId === id) throw new PageCycleError(id, u.parentId);
        const flat = pages
          .filter((x) => x.project_id === p.project_id)
          .map((x) => ({ id: x.id, parentId: x.parent_id }));
        if (!flat.some((x) => x.id === u.parentId)) {
          throw new Error("parent page not found in this project");
        }
        if (isPageDescendant(flat, id, u.parentId)) throw new PageCycleError(id, u.parentId);
      }
      if (u.title !== undefined) p.title = u.title;
      if (u.content !== undefined) p.content = u.content;
      if (u.parentId !== undefined) p.parent_id = u.parentId;
      if (u.sortOrder !== undefined) p.sort_order = u.sortOrder;
      return p;
    },
    async getPageById(id: string) {
      return pages.find((x) => x.id === id) ?? null;
    },
    async getPageProjectId(id: string) {
      return pages.find((x) => x.id === id)?.project_id ?? null;
    },
    async getProjectPages() {
      return pages;
    },
    async audit() {},
  } as unknown as PgSync;
  const deps: McpDeps = { pg, relay: { injectMessage: () => 1 } };
  return { deps, pages };
}

async function connect(deps: McpDeps, scopes: string[]): Promise<Client> {
  const server = buildWorkspaceMcpServer(ctx(scopes), deps);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (r: any) => JSON.parse(r.content.map((c: any) => c.text).join(""));

describe("mcp page tools", () => {
  it("create_page converts markdown body to HTML (headings + lists)", async () => {
    const { deps, pages } = makeDeps();
    const c = await connect(deps, ["read", "write"]);
    const md = "# Title\n\nSome **bold** text.\n\n- one\n- two\n";
    const r = body(
      await c.callTool({
        name: "create_page",
        arguments: { projectId: "proj_1", title: "Doc", content: md },
      }),
    );
    expect(r.ok).toBe(true);
    const stored = pages[0].content ?? "";
    // Stored as HTML the TipTap editor can render — NOT the raw markdown.
    expect(stored).toMatch(/<h1>/);
    expect(stored).toMatch(/<ul>/);
    expect(stored).toMatch(/<strong>/);
    expect(stored).not.toContain("# Title");
  });

  it("create_page nests a page under a parent in the same project", async () => {
    const { deps, pages } = makeDeps();
    const c = await connect(deps, ["read", "write"]);
    const root = body(
      await c.callTool({ name: "create_page", arguments: { projectId: "proj_1", title: "Root" } }),
    );
    expect(root.ok).toBe(true);
    const rootId = root.page.id;
    const child = body(
      await c.callTool({
        name: "create_page",
        arguments: { projectId: "proj_1", title: "Child", parentId: rootId },
      }),
    );
    expect(child.ok).toBe(true);
    expect(child.page.parent_id).toBe(rootId);
    // The stored child row carries the parent link.
    expect(pages.find((p) => p.id === child.page.id)?.parent_id).toBe(rootId);
  });

  it("update_page rejects nesting a page under itself or a descendant (cycle guard)", async () => {
    const { deps } = makeDeps();
    const c = await connect(deps, ["read", "write"]);
    const a = body(
      await c.callTool({ name: "create_page", arguments: { projectId: "proj_1", title: "A" } }),
    );
    const b = body(
      await c.callTool({
        name: "create_page",
        arguments: { projectId: "proj_1", title: "B", parentId: a.page.id },
      }),
    );
    // Self-parent is rejected.
    const selfMove = body(
      await c.callTool({
        name: "update_page",
        arguments: { pageId: a.page.id, parentId: a.page.id },
      }),
    );
    expect(selfMove.error).toMatch(/itself or one of its descendants/);
    // Parenting A under its own descendant B is rejected.
    const descMove = body(
      await c.callTool({
        name: "update_page",
        arguments: { pageId: a.page.id, parentId: b.page.id },
      }),
    );
    expect(descMove.error).toMatch(/itself or one of its descendants/);
    // A legal move (B → root) still succeeds.
    const ok = body(
      await c.callTool({
        name: "update_page",
        arguments: { pageId: b.page.id, parentId: null },
      }),
    );
    expect(ok.ok).toBe(true);
    expect(ok.page.parent_id).toBe(null);
  });

  it("a read-only PAT sees read page tools but NOT the write ones", async () => {
    const { deps } = makeDeps();
    const c = await connect(deps, ["read"]);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("list_pages");
    expect(names).toContain("read_page");
    expect(names).not.toContain("create_page");
    expect(names).not.toContain("update_page");
    expect(names).not.toContain("delete_page");
  });
});
