import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCyborg7McpServer, type Cyborg7McpDeps } from "./cyborg7-mcp-tools.js";
import { getDoc, getNav, listDocs, searchDocs } from "./docs-index.js";

// These exercise the REAL seed how-to docs shipped in packages/docs — the same
// files cyborg7_read_docs serves at runtime (resolved relative to this module,
// so cwd-independent). Real deps over mocks.
describe("docs-index — runtime access to the how-to guides", () => {
  it("list returns the seed docs (slug + title + summary)", () => {
    const docs = listDocs();
    expect(docs.length).toBeGreaterThanOrEqual(5);
    const slugs = docs.map((d) => d.slug);
    expect(slugs).toContain("how-to/create-and-track-tasks");
    expect(slugs).toContain("how-to/schedule-a-recurring-job");
    const tasks = docs.find((d) => d.slug === "how-to/create-and-track-tasks");
    expect(tasks?.title).toBe("Create & track tasks");
    expect(tasks?.summary.length ?? 0).toBeGreaterThan(0);
  });

  it("get-by-slug returns the full markdown body", () => {
    const doc = getDoc("how-to/schedule-a-recurring-job");
    expect(doc).not.toBeNull();
    expect(doc?.title).toBe("Schedule a recurring job");
    expect(doc?.markdown).toContain("cyborg7_schedule_create");
    // a bare slug (no "how-to/" prefix) resolves the same doc
    expect(getDoc("schedule-a-recurring-job")?.slug).toBe("how-to/schedule-a-recurring-job");
    // trailing slashes (as in internal doc links) are normalized
    expect(getDoc("how-to/schedule-a-recurring-job/")?.slug).toBe(
      "how-to/schedule-a-recurring-job",
    );
  });

  it("search finds a known doc by keyword", () => {
    expect(searchDocs("cron").map((d) => d.slug)).toContain("how-to/schedule-a-recurring-job");
    expect(searchDocs("mention").map((d) => d.slug)).toContain("how-to/mention-a-teammate");
  });

  it("unknown slug returns null gracefully (no throw)", () => {
    expect(() => getDoc("how-to/does-not-exist")).not.toThrow();
    expect(getDoc("how-to/does-not-exist")).toBeNull();
    expect(searchDocs("zzz-no-such-keyword-xyz")).toEqual([]);
  });

  it("covers the WHOLE corpus (not just how-to) and the integration guides", () => {
    const slugs = listDocs().map((d) => d.slug);
    expect(slugs).toContain("getting-started/introduction");
    expect(slugs).toContain("cybos/overview");
    for (const id of ["composio", "slack", "gmail", "jira", "clickup"]) {
      expect(slugs).toContain(`integrations/${id}`);
    }
    // nav exposes the Integrations section
    expect(getNav().map((s) => s.label)).toContain("Integrations");
  });
});

describe("cyborg7_read_docs MCP tool", () => {
  async function call(args: Record<string, unknown>): Promise<string> {
    const server = createCyborg7McpServer({} as unknown as Cyborg7McpDeps, {
      workspaceId: "ws_1",
      agentId: "ag_1",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      const res = (await client.callTool({ name: "cyborg7_read_docs", arguments: args })) as {
        content: Array<{ text: string }>;
      };
      return res.content.map((c) => c.text).join("\n");
    } finally {
      await client.close();
    }
  }

  it("is registered even in strict mode with no grants (read tools always available)", async () => {
    const server = createCyborg7McpServer({} as unknown as Cyborg7McpDeps, {
      workspaceId: "ws_1",
      agentId: "ag_1",
      platformPermissions: [],
      strictPermissions: true,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(ct);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("cyborg7_read_docs");
    } finally {
      await client.close();
    }
  });

  it("list mode returns the seed docs", async () => {
    const out = JSON.parse(await call({ mode: "list" })) as { docs: Array<{ slug: string }> };
    expect(out.docs.map((d) => d.slug)).toContain("how-to/create-and-track-tasks");
  });

  it("nav mode returns the ordered section tree incl. Integrations", async () => {
    const out = JSON.parse(await call({ mode: "nav" })) as {
      nav: Array<{ label: string; items: Array<{ slug: string }> }>;
    };
    const labels = out.nav.map((s) => s.label);
    expect(labels).toContain("Guides");
    expect(labels).toContain("Integrations");
    const integrations = out.nav.find((s) => s.label === "Integrations");
    expect(integrations?.items.map((i) => i.slug)).toContain("integrations/composio");
  });

  it("get resolves an 'integration:<id>' convenience slug", async () => {
    const got = JSON.parse(await call({ mode: "get", slug: "integration:slack" })) as {
      slug: string;
      title: string;
      markdown: string;
    };
    expect(got.slug).toBe("integrations/slack");
    expect(got.title).toBe("Connect Slack");
    expect(got.markdown.toLowerCase()).toContain("slack");
  });

  it("get/search/unknown-slug behave correctly through the tool", async () => {
    const got = JSON.parse(await call({ mode: "get", slug: "how-to/work-with-cybos" })) as {
      markdown: string;
    };
    expect(got.markdown).toContain("cybo.json");
    const search = JSON.parse(await call({ mode: "search", query: "task" })) as {
      results: Array<{ slug: string }>;
    };
    expect(search.results.map((r) => r.slug)).toContain("how-to/create-and-track-tasks");
    const missing = JSON.parse(await call({ mode: "get", slug: "how-to/nope" })) as {
      found: boolean;
    };
    expect(missing.found).toBe(false);
  });
});

// The test process runs from the monorepo git checkout, so the self-source tool is
// registered and repo-scoped reads resolve.
describe("cyborg7_read_source MCP tool (repo-scoped, read-only)", () => {
  async function call(args: Record<string, unknown>): Promise<string> {
    const server = createCyborg7McpServer({} as unknown as Cyborg7McpDeps, {
      workspaceId: "ws_1",
      agentId: "ag_1",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      const res = (await client.callTool({ name: "cyborg7_read_source", arguments: args })) as {
        content: Array<{ text: string }>;
      };
      return res.content.map((c) => c.text).join("\n");
    } finally {
      await client.close();
    }
  }

  it("is registered when running from a git checkout", async () => {
    const server = createCyborg7McpServer({} as unknown as Cyborg7McpDeps, {
      workspaceId: "ws_1",
      agentId: "ag_1",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(ct);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("cyborg7_read_source");
    } finally {
      await client.close();
    }
  });

  it("lists a repo directory and reads a file under the root", async () => {
    const listing = JSON.parse(await call({ mode: "list", path: "packages/docs-lib/src" })) as {
      entries: Array<{ name: string; type: string }>;
    };
    expect(listing.entries.map((e) => e.name)).toContain("index.ts");

    const file = JSON.parse(
      await call({ mode: "get", path: "packages/docs-lib/package.json" }),
    ) as { path: string; content: string };
    expect(file.path).toBe("packages/docs-lib/package.json");
    expect(file.content).toContain("@cyborg7/docs-lib");
  });

  it("REJECTS a `..` traversal escape (security)", async () => {
    const out = JSON.parse(await call({ mode: "get", path: "packages/../../etc/passwd" })) as {
      error: string;
    };
    expect(out.error).toMatch(/escapes the repository root/i);

    const abs = JSON.parse(await call({ mode: "get", path: "/etc/passwd" })) as { error: string };
    expect(abs.error).toMatch(/escapes the repository root/i);
  });
});
