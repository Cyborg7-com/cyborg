/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { CyborgAuth } from "./auth.js";
import { WorkspaceManager } from "./workspace-manager.js";
import {
  buildCyboPrompt,
  describeSpawnCyboNotFound,
  resolveCybo,
  spawnCybo,
  CyboNotFoundError,
  resolveCyboHarness,
} from "./cybo-manager.js";
import type { StoredCybo } from "./cybo-types.js";

// Module-level so the lookup arrow isn't a 4th-level nested callback inside the
// describe>describe>it test body (oxlint max-nested-callbacks).
function findByCategory(
  events: import("./audit-event-log.js").AuditEvent[],
  category: string,
): import("./audit-event-log.js").AuditEvent | undefined {
  return events.find((e) => e.category === category);
}

function makeCybo(overrides: Partial<StoredCybo> = {}): StoredCybo {
  return {
    id: "cybo_test",
    workspace_id: "ws_1",
    slug: "test",
    name: "TestBot",
    description: null,
    avatar: null,
    role: null,
    soul: "You are helpful and concise.",
    provider: "claude",
    model: null,
    mcp_servers: null,
    is_default: 0,
    created_by: "user_1",
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

function createMockAgentManager() {
  const agents = new Map<string, any>();
  const createdConfigs: any[] = [];

  return {
    createdConfigs,
    agents,

    async createAgent(
      config: any,
      agentId?: string,
      options?: { labels?: Record<string, string>; workspaceId?: string },
    ) {
      const id = agentId ?? `agent-${Date.now()}`;
      createdConfigs.push({ config, agentId: id, options });
      const agent = {
        id,
        provider: config.provider,
        lifecycle: "idle" as const,
        cwd: config.cwd ?? "/tmp",
        labels: options?.labels ?? {},
        config,
        createdAt: new Date(),
        updatedAt: new Date(),
        availableModes: [],
        currentModeId: null,
        pendingPermissions: new Map(),
        bufferedPermissionResolutions: new Map(),
        inFlightPermissionResponses: new Set(),
        pendingReplacement: false,
        persistence: null,
        historyPrimed: false,
        lastUserMessageAt: null,
        attention: { active: false },
        foregroundTurnWaiters: new Set(),
        finalizedForegroundTurnIds: new Set(),
        unsubscribeSession: null,
        session: {},
        activeForegroundTurnId: null,
        capabilities: {},
      };
      agents.set(id, agent);
      return agent;
    },
  };
}

describe("buildCyboPrompt", () => {
  it("assembles basic prompt with name and soul", () => {
    const cybo = makeCybo();
    const prompt = buildCyboPrompt(cybo);
    expect(prompt).toContain("You are TestBot.");
    expect(prompt).toContain("You are helpful and concise.");
  });

  it("includes role when present", () => {
    const cybo = makeCybo({ role: "Code Reviewer" });
    const prompt = buildCyboPrompt(cybo);
    expect(prompt).toContain("You are TestBot, a Code Reviewer.");
  });

  it("includes description when present", () => {
    const cybo = makeCybo({ description: "Helps review PRs" });
    const prompt = buildCyboPrompt(cybo);
    expect(prompt).toContain("Helps review PRs");
  });

  it("includes workspace context when provided", () => {
    const cybo = makeCybo();
    const prompt = buildCyboPrompt(cybo, { workspaceName: "acme" });
    expect(prompt).toContain('You are in workspace "acme".');
  });

  it("includes channel context when provided", () => {
    const cybo = makeCybo();
    const prompt = buildCyboPrompt(cybo, { channelName: "general" });
    expect(prompt).toContain("Current channel: general.");
  });

  it("states the channel medium so the cybo replies where it was invoked (Bug T1)", () => {
    // The system prompt must tell the cybo WHERE it is speaking — a group channel,
    // and which one — so its reply lands in the same channel it was invoked from
    // instead of a hardcoded/default channel. (Reply-routing itself is enforced by
    // MessageRouter; this is the prompt-layer reinforcement the owner asked for.)
    const cybo = makeCybo();
    const prompt = buildCyboPrompt(cybo, { channelName: "random" });
    expect(prompt).toContain('group channel "random"');
    expect(prompt).toMatch(/Answer directly in your response/i);
    expect(prompt).toMatch(/do not call cyborg7_send_message to post your reply here/i);
    expect(prompt).toMatch(/not post to another channel or DM/i);
  });

  it("AUTONOMOUS run: instructs the OPPOSITE — response text is dropped, tool is the delivery", () => {
    // Scheduled/unattended turns never auto-post: emitAgentStream tags them
    // `autonomous` and the relay accumulator DROPS the prose, so the ONLY way the
    // run reaches a channel/DM is an explicit cyborg7_send_message call. The
    // interactive "don't call send_message" framing would silence every cron.
    const cybo = makeCybo();
    const prompt = buildCyboPrompt(cybo, { channelName: "general", autonomous: true });
    expect(prompt).toContain("autonomous (scheduled/unattended) run");
    expect(prompt).toMatch(/response text is NOT delivered anywhere/i);
    expect(prompt).toMatch(/MUST call cyborg7_send_message/i);
    // And it must NOT carry the interactive no-tool instruction.
    expect(prompt).not.toMatch(/do not call cyborg7_send_message to post your reply here/i);
    expect(prompt).not.toMatch(/posted to that channel automatically/i);
  });

  it("combines all elements in order", () => {
    const cybo = makeCybo({ role: "Helper", description: "Friendly bot" });
    const prompt = buildCyboPrompt(cybo, {
      workspaceName: "acme",
      channelName: "dev",
    });

    const lines = prompt.split("\n");
    const identityIdx = lines.findIndex((l) => l.includes("You are TestBot, a Helper."));
    const descIdx = lines.findIndex((l) => l.includes("Friendly bot"));
    const soulIdx = lines.findIndex((l) => l.includes("You are helpful and concise."));
    const wsIdx = lines.findIndex((l) => l.includes("acme"));
    const chIdx = lines.findIndex((l) => l.includes("dev"));

    expect(identityIdx).toBeLessThan(descIdx);
    expect(descIdx).toBeLessThan(soulIdx);
    expect(soulIdx).toBeLessThan(wsIdx);
    expect(wsIdx).toBeLessThan(chIdx);
  });
});

describe("Cybo CRUD + spawn flow (SQLite integration)", () => {
  let storage: DualStorage;
  let auth: CyborgAuth;
  let workspaceManager: WorkspaceManager;
  let mockAgentManager: ReturnType<typeof createMockAgentManager>;
  let tmpDir: string;
  let workspaceId: string;
  let userId: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cybo-mgr-"));
    const dbPath = path.join(tmpDir, "test.db");
    storage = new DualStorage(new CyborgStorage(dbPath), null);
    auth = new CyborgAuth(storage);
    workspaceManager = new WorkspaceManager(storage);
    mockAgentManager = createMockAgentManager();

    const token = auth.createToken("alice@test.com", "Alice");
    const ctx = auth.validateToken(token)!;
    userId = ctx.user.id;

    const ws = workspaceManager.createWorkspace("TestWS", userId);
    workspaceId = ws.id;
  });

  afterEach(() => {
    storage.close();
    const dbPath = path.join(tmpDir, "test.db");
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = dbPath + suffix;
      if (existsSync(p)) unlinkSync(p);
    }
  });

  describe("storage CRUD", () => {
    it("creates and retrieves a cybo by ID", () => {
      const cybo = storage.createCybo({
        workspaceId,
        slug: "reviewer",
        name: "Reviewer",
        soul: "Review code carefully.",
        provider: "claude",
        createdBy: userId,
      });

      expect(cybo.id).toMatch(/^cybo_/);
      expect(cybo.slug).toBe("reviewer");

      const fetched = storage.getCybo(cybo.id);
      expect(fetched).toBeDefined();
      expect(fetched!.name).toBe("Reviewer");
      expect(fetched!.workspace_id).toBe(workspaceId);
    });

    it("retrieves a cybo by slug", () => {
      storage.createCybo({
        workspaceId,
        slug: "helper",
        name: "Helper",
        soul: "Help people.",
        provider: "claude",
        createdBy: userId,
      });

      const fetched = storage.getCyboBySlug(workspaceId, "helper");
      expect(fetched).toBeDefined();
      expect(fetched!.name).toBe("Helper");
    });

    it("lists cybos for a workspace", () => {
      storage.createCybo({
        workspaceId,
        slug: "a",
        name: "A",
        soul: "a",
        provider: "claude",
        createdBy: userId,
      });
      storage.createCybo({
        workspaceId,
        slug: "b",
        name: "B",
        soul: "b",
        provider: "claude",
        createdBy: userId,
      });

      const cybos = storage.getCybos(workspaceId);
      expect(cybos).toHaveLength(2);
    });

    it("updates a cybo", () => {
      const cybo = storage.createCybo({
        workspaceId,
        slug: "orig",
        name: "Original",
        soul: "v1",
        provider: "claude",
        createdBy: userId,
      });

      const updated = storage.updateCybo(cybo.id, {
        name: "Updated",
        soul: "v2",
        role: "Tester",
      });

      expect(updated).toBeDefined();
      expect(updated!.name).toBe("Updated");
      expect(updated!.soul).toBe("v2");
      expect(updated!.role).toBe("Tester");
    });

    it("deletes a cybo", () => {
      const cybo = storage.createCybo({
        workspaceId,
        slug: "temp",
        name: "Temp",
        soul: "temp",
        provider: "claude",
        createdBy: userId,
      });

      storage.deleteCybo(cybo.id);
      expect(storage.getCybo(cybo.id)).toBeUndefined();
    });
  });

  describe("resolveCybo", () => {
    it("resolves by ID", async () => {
      const cybo = storage.createCybo({
        workspaceId,
        slug: "by-id",
        name: "ByID",
        soul: "test",
        provider: "claude",
        createdBy: userId,
      });

      const resolved = await resolveCybo(storage, workspaceId, cybo.id);
      expect(resolved).toBeDefined();
      expect(resolved!.id).toBe(cybo.id);
    });

    it("resolves by slug", async () => {
      storage.createCybo({
        workspaceId,
        slug: "by-slug",
        name: "BySlug",
        soul: "test",
        provider: "claude",
        createdBy: userId,
      });

      const resolved = await resolveCybo(storage, workspaceId, "by-slug");
      expect(resolved).toBeDefined();
      expect(resolved!.slug).toBe("by-slug");
    });

    it("returns undefined for non-existent", async () => {
      expect(await resolveCybo(storage, workspaceId, "nope")).toBeUndefined();
    });
  });

  describe("spawnCybo", () => {
    it("spawns an agent from a cybo and creates binding", async () => {
      const cybo = storage.createCybo({
        workspaceId,
        slug: "pi",
        name: "PI",
        role: "Assistant",
        soul: "You help with tasks.",
        provider: "claude",
        createdBy: userId,
      });

      const result = await spawnCybo({
        storage,
        agentManager: mockAgentManager as any,
        workspaceId,
        cyboIdOrSlug: "pi",
        userId,
      });

      expect(result.cyboId).toBe(cybo.id);
      expect(result.cyboSlug).toBe("pi");
      expect(result.provider).toBe("claude");
      expect(result.agentId).toBeTruthy();
      expect(result.systemPrompt).toContain("You are PI, a Assistant.");
      expect(result.systemPrompt).toContain("You help with tasks.");

      const binding = storage.getAgentBinding(result.agentId);
      expect(binding).toBeDefined();
      expect(binding!.workspace_id).toBe(workspaceId);
      expect(binding!.cybo_id).toBe(cybo.id);
    });

    it("passes workspace name as context in the prompt", async () => {
      storage.createCybo({
        workspaceId,
        slug: "ctx",
        name: "CtxBot",
        soul: "soul",
        provider: "claude",
        createdBy: userId,
      });

      const result = await spawnCybo({
        storage,
        agentManager: mockAgentManager as any,
        workspaceId,
        cyboIdOrSlug: "ctx",
        userId,
      });

      expect(result.systemPrompt).toContain('You are in workspace "TestWS".');
    });

    it("throws CyboNotFoundError for non-existent cybo", async () => {
      await expect(
        spawnCybo({
          storage,
          agentManager: mockAgentManager as any,
          workspaceId,
          cyboIdOrSlug: "ghost",
          userId,
        }),
      ).rejects.toThrow(CyboNotFoundError);
    });

    it("throws CyboNotFoundError for cybo from different workspace", async () => {
      const otherWs = workspaceManager.createWorkspace("Other", userId);
      storage.createCybo({
        workspaceId: otherWs.id,
        slug: "alien",
        name: "Alien",
        soul: "soul",
        provider: "claude",
        createdBy: userId,
      });

      await expect(
        spawnCybo({
          storage,
          agentManager: mockAgentManager as any,
          workspaceId,
          cyboIdOrSlug: "alien",
          userId,
        }),
      ).rejects.toThrow(CyboNotFoundError);
    });

    // The "Your cybos" roster lists the daemon's LOCAL (disk) cybos (fetch_cybos
    // merges scanLocalCybos), which are NOT in any workspace's PG. The relay's
    // spawn enrichment can't find them in pg.getCybos(workspace), so it now forwards
    // UNENRICHED and lets the daemon resolve them. A local cybo (id "local:…") must
    // therefore spawn into the current workspace WITHOUT a workspace-membership check
    // — otherwise the roster shows a cybo that can never start a chat.
    it("spawns a LOCAL cybo into any workspace (bypasses the workspace check)", async () => {
      const seed = storage.createCybo({
        workspaceId: workspaceManager.createWorkspace("Elsewhere", userId).id,
        slug: "rickmaster",
        name: "Rick Master",
        soul: "Wubba lubba dub dub.",
        provider: "claude",
        createdBy: userId,
      });
      // A local (disk) cybo: "local:" id + no workspace ownership — the shape the
      // daemon resolves from ~/.cybo/agents / the relay forwards unenriched.
      const localCybo: StoredCybo = { ...seed, id: "local:rickmaster", workspace_id: "" };

      const result = await spawnCybo({
        storage,
        agentManager: mockAgentManager as any,
        workspaceId, // current workspace — different from the local cybo's (empty) one
        cyboIdOrSlug: "local:rickmaster",
        userId,
        resolvedCybo: localCybo,
      });

      expect(result.cyboId).toBe("local:rickmaster");
      expect(result.agentId).toBeTruthy();
      const binding = storage.getAgentBinding(result.agentId);
      expect(binding!.workspace_id).toBe(workspaceId);
    });

    it("injects cyborg7 MCP server when URL is provided", async () => {
      storage.createCybo({
        workspaceId,
        slug: "mcp",
        name: "MCPBot",
        soul: "soul",
        provider: "claude",
        createdBy: userId,
      });

      const mcpBaseUrl = "http://localhost:6767/mcp/cyborg7";

      const result = await spawnCybo({
        storage,
        agentManager: mockAgentManager as any,
        workspaceId,
        cyboIdOrSlug: "mcp",
        userId,
        cyborg7McpBaseUrl: mcpBaseUrl,
      });

      const created = mockAgentManager.createdConfigs[0];
      expect(created.config.mcpServers).toBeDefined();
      expect(created.config.mcpServers.cyborg7).toBeDefined();
      expect(created.config.mcpServers.cyborg7.type).toBe("http");
      expect(created.config.mcpServers.cyborg7.url).toContain(mcpBaseUrl);
      expect(created.config.mcpServers.cyborg7.url).toContain(
        `workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      expect(created.config.mcpServers.cyborg7.url).toContain(
        `agentId=${encodeURIComponent(result.agentId)}`,
      );
    });

    it("does not inject MCP server when URL is not provided", async () => {
      storage.createCybo({
        workspaceId,
        slug: "nomcp",
        name: "NoMCP",
        soul: "soul",
        provider: "claude",
        createdBy: userId,
      });

      await spawnCybo({
        storage,
        agentManager: mockAgentManager as any,
        workspaceId,
        cyboIdOrSlug: "nomcp",
        userId,
      });

      const created = mockAgentManager.createdConfigs[0];
      expect(created.config.mcpServers).toBeUndefined();
    });

    it("pre-generates agent ID and passes it to createAgent", async () => {
      storage.createCybo({
        workspaceId,
        slug: "idtest",
        name: "IDTest",
        soul: "soul",
        provider: "claude",
        createdBy: userId,
      });

      const result = await spawnCybo({
        storage,
        agentManager: mockAgentManager as any,
        workspaceId,
        cyboIdOrSlug: "idtest",
        userId,
      });

      const created = mockAgentManager.createdConfigs[0];
      expect(created.agentId).toBe(result.agentId);
    });

    it("sets cyborg7 labels on agent", async () => {
      const cybo = storage.createCybo({
        workspaceId,
        slug: "labeled",
        name: "Labeled",
        soul: "soul",
        provider: "claude",
        createdBy: userId,
      });

      await spawnCybo({
        storage,
        agentManager: mockAgentManager as any,
        workspaceId,
        cyboIdOrSlug: "labeled",
        userId,
        context: { channelId: "ch_1" },
      });

      const created = mockAgentManager.createdConfigs[0];
      expect(created.options.labels.surface).toBe("cyborg7");
      expect(created.options.labels.cyboId).toBe(cybo.id);
      expect(created.options.labels.cyboSlug).toBe("labeled");
      expect(created.options.labels.channelId).toBe("ch_1");
    });

    // Ghost-session regression (2026-06-12): a mention-spawned cybo appeared as
    // a persistent, joinable "Agent session" in every member's sidebar. An
    // ephemeral summon must be an INTERNAL, non-persisted agent — the same
    // invisibility contract as /summarize's internal sessions.
    it("ephemeral spawn creates an internal, non-persisted agent with an ephemeral binding", async () => {
      storage.createCybo({
        workspaceId,
        slug: "ghost",
        name: "Ghost",
        soul: "soul",
        provider: "claude",
        createdBy: userId,
      });

      const result = await spawnCybo({
        storage,
        agentManager: mockAgentManager as any,
        workspaceId,
        cyboIdOrSlug: "ghost",
        userId,
        ephemeral: true,
        context: { channelId: "ch_1" },
      });

      const created = mockAgentManager.createdConfigs[0];
      expect(created.config.internal).toBe(true);
      expect(created.options.persistSession).toBe(false);
      expect(storage.getAgentBinding(result.agentId)!.ephemeral).toBe(1);
    });

    // #995: the ONE new emit — spawn surfaces a redacted context + tool snapshot
    // onto the audit stream. The full prompt + any secret never reach the payload.
    it("emits redacted context_injection + tool_injection audit events on spawn", async () => {
      // A long soul so the 280-char preview genuinely DROPS the tail — proving the
      // full prompt is never shipped (a short soul would fit entirely in preview).
      const secretTail = "ULTRA_SECRET_TAIL_THAT_MUST_BE_TRUNCATED";
      const cybo = storage.createCybo({
        workspaceId,
        slug: "audited",
        name: "Audited",
        role: "Auditor",
        soul: `${"padding instructions. ".repeat(40)}${secretTail}`,
        provider: "claude",
        createdBy: userId,
      });

      const events: import("./audit-event-log.js").AuditEvent[] = [];
      const capturingSink = {
        emit: (e: import("./audit-event-log.js").AuditEvent) => events.push(e),
      };
      const mcpBaseUrl = "https://relay.example.com/mcp/cyborg7";

      const result = await spawnCybo({
        storage,
        agentManager: mockAgentManager as any,
        workspaceId,
        cyboIdOrSlug: "audited",
        userId,
        cyborg7McpBaseUrl: mcpBaseUrl,
        context: { channelId: "ch_99" },
        auditSink: capturingSink,
      });

      const ctx = findByCategory(events, "context_injection");
      const tools = findByCategory(events, "tool_injection");
      expect(ctx).toBeDefined();
      expect(tools).toBeDefined();

      // Right ids on both events.
      for (const e of [ctx!, tools!]) {
        expect(e.agentId).toBe(result.agentId);
        expect(e.cyboId).toBe(cybo.id);
        expect(e.workspaceId).toBe(workspaceId);
        expect(e.channelId).toBe("ch_99");
      }

      // Context: preview is truncated; FULL prompt is absent; hash + length present.
      const ctxPayload = ctx!.payload as Record<string, unknown>;
      expect((ctxPayload.promptPreview as string).length).toBeLessThanOrEqual(280);
      expect(ctxPayload.promptLength).toBe(result.systemPrompt.length);
      expect(typeof ctxPayload.promptSha256).toBe("string");
      expect(result.systemPrompt.length).toBeGreaterThan(280);
      const serializedCtx = JSON.stringify(ctxPayload);
      expect(serializedCtx).not.toContain(secretTail);

      // Tools: lists cyborg7; the formatted line strips the URL query string.
      const toolsPayload = tools!.payload as Record<string, unknown>;
      expect(toolsPayload.mcpServers).toContain("cyborg7");
      const line = (await import("./audit-event-log.js")).formatAuditEvent(tools!);
      expect(JSON.stringify(line.payload)).not.toContain("agentId=");
    });

    it("non-ephemeral spawn stays visible (not internal, session persisted)", async () => {
      storage.createCybo({
        workspaceId,
        slug: "vis",
        name: "Vis",
        soul: "soul",
        provider: "claude",
        createdBy: userId,
      });

      const result = await spawnCybo({
        storage,
        agentManager: mockAgentManager as any,
        workspaceId,
        cyboIdOrSlug: "vis",
        userId,
      });

      const created = mockAgentManager.createdConfigs[0];
      expect(created.config.internal).toBeUndefined();
      expect(created.options.persistSession).toBeUndefined();
      expect(storage.getAgentBinding(result.agentId)!.ephemeral).toBe(0);
    });
  });
});

// The spawn not-found ack: a raw "Cybo not found: X" hid the real cause (the
// relay forwards UNENRICHED when the cybo isn't in the workspace's PG — a
// local-disk cybo can only start on its home machine). The message must say so.
describe("describeSpawnCyboNotFound", () => {
  it("explains the unenriched case (local cybo on another machine) with the daemon id", () => {
    const msg = describeSpawnCyboNotFound("rickmaster", { enriched: false, daemonId: "srv_abc" });
    expect(msg).toContain('"rickmaster"');
    expect(msg).toContain("isn't in this workspace's shared cybos");
    expect(msg).toContain("this daemon's disk (srv_abc)");
    expect(msg).toContain("home daemon");
    expect(msg).toContain("import it into the workspace");
  });

  it("degrades gracefully without a daemon id", () => {
    const msg = describeSpawnCyboNotFound("rickmaster", { enriched: false, daemonId: null });
    expect(msg).toContain("this daemon's disk");
    expect(msg).not.toContain("(null)");
  });

  it("explains the enriched case as a workspace mismatch (stale roster)", () => {
    const msg = describeSpawnCyboNotFound("rickmaster", { enriched: true });
    expect(msg).toContain("different workspace");
    expect(msg).toContain('"rickmaster"');
  });
});

// Provider IS the harness (internal docs): claude/codex route to the daemon's
// NATIVE provider; everything else stays on the Cybo runtime.
describe("resolveCyboHarness", () => {
  it("claude cybo → native claude provider, model verbatim", () => {
    expect(resolveCyboHarness("claude", "claude-haiku-4-5")).toEqual({
      provider: "claude",
      model: "claude-haiku-4-5",
    });
    expect(resolveCyboHarness("claude", null)).toEqual({ provider: "claude", model: undefined });
  });

  it("codex cybo → native codex provider", () => {
    expect(resolveCyboHarness("codex", "gpt-5.5")).toEqual({ provider: "codex", model: "gpt-5.5" });
  });

  it("runtime backends keep the backend/model ref (no regression)", () => {
    expect(resolveCyboHarness("opencode-go", "glm-5.1")).toEqual({
      provider: "pi",
      model: "opencode-go/glm-5.1",
    });
    expect(resolveCyboHarness("pi", "anthropic/claude-haiku-4-5")).toEqual({
      provider: "pi",
      model: "anthropic/claude-haiku-4-5",
    });
    expect(resolveCyboHarness("pi", null)).toEqual({ provider: "pi", model: undefined });
  });
});

// Local fixture for the harness-routing suite (same shape as the CRUD suite's
// beforeEach, self-contained so these tests stay independent).
async function makeSpawnFixture() {
  const tmp = mkdtempSync(path.join(tmpdir(), "cybo-harness-"));
  const storage = new DualStorage(new CyborgStorage(path.join(tmp, "t.db")), null);
  const auth = new CyborgAuth(storage);
  const workspaceManager = new WorkspaceManager(storage);
  const manager = createMockAgentManager();
  const ctx = auth.validateToken(auth.createToken("h@test.com", "H"))!;
  const ws = workspaceManager.createWorkspace("HarnessWS", ctx.user.id);
  return {
    storage,
    agentManager: manager as unknown as Parameters<typeof spawnCybo>[0]["agentManager"],
    raw: manager,
    workspaceId: ws.id,
    userId: ctx.user.id,
  };
}

describe("spawnCybo harness routing (internal docs)", () => {
  it("provider=claude spawns on the NATIVE claude provider with the soul as systemPrompt", async () => {
    const { storage, agentManager, raw, workspaceId, userId } = await makeSpawnFixture();
    const cybo = storage.createCybo({
      workspaceId,
      slug: "apex",
      name: "Apex",
      soul: "Be sharp and brief.",
      provider: "claude",
      model: "claude-haiku-4-5",
      createdBy: userId,
    });

    await spawnCybo({
      storage,
      agentManager,
      workspaceId,
      cyboIdOrSlug: cybo.id,
      userId,
    });

    expect(raw.createdConfigs).toHaveLength(1);
    const config = raw.createdConfigs[0].config as {
      provider: string;
      model?: string;
      systemPrompt?: string;
    };
    expect(config.provider).toBe("claude"); // NOT "pi"
    expect(config.model).toBe("claude-haiku-4-5"); // verbatim, no backend ref
    // The soul + cybo identity ride AgentSessionConfig.systemPrompt — the
    // native claude provider appends it to its preset (--append-system-prompt
    // equivalent), so the cybo introduces itself as Apex, never as the harness.
    expect(config.systemPrompt).toContain("You are Apex");
    expect(config.systemPrompt).toContain("Be sharp and brief.");
  });

  it("provider=opencode-go still spawns through the runtime (no regression)", async () => {
    const { storage, agentManager, raw, workspaceId, userId } = await makeSpawnFixture();
    const cybo = storage.createCybo({
      workspaceId,
      slug: "oc",
      name: "OC",
      soul: "Soul.",
      provider: "opencode-go",
      model: "glm-5.1",
      createdBy: userId,
    });

    await spawnCybo({ storage, agentManager, workspaceId, cyboIdOrSlug: cybo.id, userId });

    const config = raw.createdConfigs[0].config as { provider: string; model?: string };
    expect(config.provider).toBe("pi");
    expect(config.model).toBe("opencode-go/glm-5.1");
  });
});
