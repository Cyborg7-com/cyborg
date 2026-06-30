import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  composeCyboSoul,
  createCyborg7McpServer,
  type Cyborg7McpDeps,
} from "./cyborg7-mcp-tools.js";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import type { StoredCybo } from "./cybo-types.js";

// D2: cyborg7_update_my_personality — a cybo edits its OWN soul. STRICTLY scoped
// to ctx.cyboId (there is no cyboId param), gated on the manage_self grant, and
// persisted via the same update path as update_cybo (here: daemon-local SQLite +
// a spy cyboWrite that stands in for the relay's shared-PG write).

interface CyboWriteCall {
  workspaceId: string;
  cyboId?: string;
  kind: string;
  soul?: string;
}

describe("cyborg7_update_my_personality (self-edit)", () => {
  let tmpDir: string;
  let sqlite: CyborgStorage;
  let storage: DualStorage;
  let workspaceId: string;
  let writes: CyboWriteCall[];

  function makeDeps(): Cyborg7McpDeps {
    writes = [];
    return {
      storage,
      messageRouter: {} as never,
      workspaceManager: {} as never,
      cyboWrite: async (req) => {
        writes.push({
          workspaceId: req.workspaceId,
          cyboId: req.cyboId,
          kind: req.kind,
          soul: req.soul,
        });
        return {
          ok: true,
          cybo: { id: req.cyboId ?? "", slug: "x", soul: req.soul ?? "" },
        };
      },
    } as unknown as Cyborg7McpDeps;
  }

  let ownerId: string;

  function mkCybo(opts: { name: string; soul: string; permissions?: string[] }): StoredCybo {
    return sqlite.createCybo({
      workspaceId,
      slug: opts.name.toLowerCase(),
      name: opts.name,
      soul: opts.soul,
      provider: "claude",
      createdBy: ownerId,
      platformPermissions: opts.permissions,
    });
  }

  async function listTools(cyboId: string | undefined, permissions?: string[]): Promise<string[]> {
    const server = createCyborg7McpServer(makeDeps(), {
      workspaceId,
      agentId: "ag_1",
      cyboId,
      platformPermissions: permissions,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "1.0.0" });
    await client.connect(ct);
    try {
      return (await client.listTools()).tools.map((t) => t.name);
    } finally {
      await client.close();
    }
  }

  async function callTool(
    cyboId: string | undefined,
    args: Record<string, unknown>,
    permissions?: string[],
  ): Promise<string> {
    const server = createCyborg7McpServer(makeDeps(), {
      workspaceId,
      agentId: "ag_1",
      cyboId,
      platformPermissions: permissions,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "1.0.0" });
    await client.connect(ct);
    try {
      const res = (await client.callTool({
        name: "cyborg7_update_my_personality",
        arguments: args,
      })) as { content: Array<{ text: string }> };
      return res.content.map((c) => c.text).join("\n");
    } finally {
      await client.close();
    }
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-self-pers-"));
    sqlite = new CyborgStorage(path.join(tmpDir, "test.db"));
    storage = new DualStorage(sqlite);
    // Real user + workspace so the cybos table's FKs (workspace_id, created_by)
    // are satisfied.
    ownerId = sqlite.upsertUser("owner@test.com", "Owner").id;
    workspaceId = sqlite.createWorkspace("Self WS", ownerId).id;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is NOT registered for a non-cybo agent (no ctx.cyboId)", async () => {
    const names = await listTools(undefined, []);
    expect(names).not.toContain("cyborg7_update_my_personality");
  });

  it("is registered for a cybo with no explicit grants (fail-open default)", async () => {
    const cybo = mkCybo({ name: "Apex", soul: "You are Apex." });
    const names = await listTools(cybo.id, []);
    expect(names).toContain("cyborg7_update_my_personality");
  });

  it("is registered when the cybo holds manage_self", async () => {
    const cybo = mkCybo({ name: "Apex", soul: "You are Apex.", permissions: ["manage_self"] });
    const names = await listTools(cybo.id, ["manage_self"]);
    expect(names).toContain("cyborg7_update_my_personality");
  });

  it("is WITHHELD when the cybo has grants but not manage_self", async () => {
    const cybo = mkCybo({ name: "Apex", soul: "You are Apex.", permissions: ["send_message"] });
    const names = await listTools(cybo.id, ["send_message"]);
    expect(names).not.toContain("cyborg7_update_my_personality");
  });

  it("replaces the full soul and persists it (round-trips)", async () => {
    const cybo = mkCybo({ name: "Apex", soul: "old soul" });
    const out = await callTool(cybo.id, { soul: "You are Apex, reborn." }, []);
    expect(out).toContain("Saved");
    // Local SQLite persisted.
    expect(sqlite.getCybo(cybo.id)!.soul).toBe("You are Apex, reborn.");
    // Relay write fired, scoped to THIS cybo, with the new soul.
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      cyboId: cybo.id,
      kind: "update_self",
      soul: "You are Apex, reborn.",
    });
  });

  it("appends a paragraph to the current soul", async () => {
    const cybo = mkCybo({ name: "Apex", soul: "You are Apex." });
    await callTool(cybo.id, { append: "You love precision." }, []);
    const saved = sqlite.getCybo(cybo.id)!.soul;
    expect(saved).toBe("You are Apex.\n\nYou love precision.");
  });

  it("rewrites the Personality section from traits (round-trips into UI chips)", async () => {
    const cybo = mkCybo({ name: "Apex", soul: "You are Apex." });
    await callTool(cybo.id, { traits: ["warm", "direct"] }, []);
    const saved = sqlite.getCybo(cybo.id)!.soul;
    expect(saved).toContain("Personality:");
    expect(saved).toContain("- Warm — a real person on a good day");
    expect(saved).toContain("- Direct — no hedging");
  });

  it("re-applying traits does not stack duplicate Personality blocks", async () => {
    const cybo = mkCybo({ name: "Apex", soul: "You are Apex." });
    await callTool(cybo.id, { traits: ["warm"] }, []);
    await callTool(cybo.id, { traits: ["brief"] }, []);
    const saved = sqlite.getCybo(cybo.id)!.soul;
    // Exactly one Personality heading, and only the latest trait remains.
    expect(saved.match(/Personality:/g)).toHaveLength(1);
    expect(saved).toContain("- Brief — says the thing, then stops");
    expect(saved).not.toContain("- Warm —");
  });

  it("requires at least one of soul/append/traits", async () => {
    const cybo = mkCybo({ name: "Apex", soul: "You are Apex." });
    const out = await callTool(cybo.id, {}, []);
    expect(out).toContain("Error");
    // Nothing persisted.
    expect(sqlite.getCybo(cybo.id)!.soul).toBe("You are Apex.");
    expect(writes).toHaveLength(0);
  });

  it("only ever edits the CALLER's own cybo — another cybo's soul is untouched", async () => {
    const me = mkCybo({ name: "Apex", soul: "You are Apex." });
    const other = mkCybo({ name: "Nova", soul: "You are Nova." });
    // The tool has no cyboId param, so the only soul it can change is ctx.cyboId's.
    await callTool(me.id, { soul: "rewritten" }, []);
    expect(sqlite.getCybo(me.id)!.soul).toBe("rewritten");
    expect(sqlite.getCybo(other.id)!.soul).toBe("You are Nova.");
    // The relay write is scoped to the caller, never the other cybo.
    expect(writes.every((w) => w.cyboId === me.id)).toBe(true);
  });
});

describe("composeCyboSoul (pure soul edit)", () => {
  it("full replace ignores the current soul", () => {
    expect(composeCyboSoul("old", { soul: "new" })).toBe("new");
  });

  it("append adds a trailing paragraph", () => {
    expect(composeCyboSoul("You are Apex.", { append: "Be kind." })).toBe(
      "You are Apex.\n\nBe kind.",
    );
  });

  it("traits add a Personality block", () => {
    const out = composeCyboSoul("You are Apex.", { traits: ["warm", "brief"] });
    expect(out).toContain("Personality:");
    expect(out).toContain("- Warm — a real person on a good day");
    expect(out).toContain("- Brief — says the thing, then stops");
  });

  it("re-applying traits replaces, never stacks, the Personality block", () => {
    const once = composeCyboSoul("You are Apex.", { traits: ["warm"] });
    const twice = composeCyboSoul(once, { traits: ["direct"] });
    expect(twice.match(/Personality:/g)).toHaveLength(1);
    expect(twice).toContain("- Direct — no hedging");
    expect(twice).not.toContain("- Warm —");
  });

  it("an empty traits array clears the Personality block", () => {
    const withTraits = composeCyboSoul("You are Apex.", { traits: ["warm"] });
    const cleared = composeCyboSoul(withTraits, { traits: [] });
    expect(cleared).not.toContain("Personality:");
    expect(cleared).toBe("You are Apex.");
  });
});
