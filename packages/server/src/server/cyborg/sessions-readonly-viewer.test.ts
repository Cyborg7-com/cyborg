/* eslint-disable @typescript-eslint/no-explicit-any */
// CLI-first verification for sessions-readonly-viewer (#994): the captured
// ephemeral context + transcript are served, attach-free, to an audit-scoped
// owner AFTER teardown; non-owners are blocked; secrets are redacted; and the
// read path NEVER revives the agent.
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, unlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { CyborgAuth } from "./auth.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MessageRouter, type BroadcastFn } from "./message-router.js";
import { CyborgDispatcher } from "./dispatcher.js";
import { SqliteAgentTimelineStore } from "./sqlite-timeline-store.js";
import { spawnCybo } from "./cybo-manager.js";
import { redactSecrets } from "./session-context-redact.js";

function createMockAgentManager() {
  const created: any[] = [];
  const manager = {
    created,
    resumeAgentFromPersistence: vi.fn(async () => {
      throw new Error("resumeAgentFromPersistence must never be called by a read RPC");
    }),
    async createAgent(config: any, agentId?: string, options?: any) {
      const id = agentId ?? `agent-${created.length}`;
      created.push({ config, agentId: id, options });
      return {
        id,
        provider: config.provider,
        lifecycle: "idle" as const,
        cwd: config.cwd ?? "/tmp",
        labels: options?.labels ?? {},
        config,
        createdAt: new Date(),
      };
    },
    getAgent: vi.fn(() => undefined),
    appendTimelineItem: vi.fn(async () => {}),
    // streamAgent throws synchronously — routeToAgent forwards turn_failed and
    // returns AFTER the prompt-capture update already ran (which is what we test).
    streamAgent: vi.fn(() => {
      throw new Error("no streaming in this test");
    }),
    fetchTimeline: vi.fn(() => ({
      rows: [],
      epoch: "committed",
      window: { minSeq: 0, maxSeq: 0 },
      hasNewer: false,
      hasOlder: false,
    })),
    closeAgent: vi.fn(async () => {}),
    subscribe: () => () => {},
  };
  return manager;
}

interface Harness {
  storage: DualStorage;
  sqlite: CyborgStorage;
  auth: CyborgAuth;
  workspaceManager: WorkspaceManager;
  messageRouter: MessageRouter;
  dispatcher: CyborgDispatcher;
  manager: ReturnType<typeof createMockAgentManager>;
  durable: SqliteAgentTimelineStore;
  workspaceId: string;
  ownerId: string;
  ownerAuth: any;
  tmpDir: string;
  dbPath: string;
}

// A controllable daemon-access store: only `admin`-scoped users pass the audit
// predicate. Mirrors pg.getUserDaemonScopes (owner ⇒ all scopes). Every other PG
// method is an async no-op (fire-and-forget mirror writes / upserts) so the
// dual-storage hot path doesn't blow up — we only care about the scope check.
function fakePg(scopesByUser: Map<string, Set<string>>) {
  const base: Record<string, any> = {
    getUserDaemonScopes: async (_ws: string, _daemon: string, userId: string) =>
      scopesByUser.get(userId) ?? new Set<string>(),
    upsertUser: async (id: string) => id,
    getWorkspacesForUser: async () => [],
  };
  return new Proxy(base, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  }) as any;
}

function makeHarness(opts?: { pg?: any }): Harness {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "rov-"));
  const dbPath = path.join(tmpDir, "test.db");
  const sqlite = new CyborgStorage(dbPath);
  const storage = new DualStorage(sqlite, opts?.pg ?? null);
  const auth = new CyborgAuth(storage);
  const workspaceManager = new WorkspaceManager(storage);
  const broadcast: BroadcastFn = { toWorkspace() {}, toUser() {} };
  const messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
  const dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);
  const manager = createMockAgentManager();
  dispatcher.setAgentManager(manager as any);
  messageRouter.setAgentManager(manager as any);
  dispatcher.setServerId("daemon-1");
  messageRouter.setServerId("daemon-1");
  const durable = new SqliteAgentTimelineStore(new Database(":memory:"));
  dispatcher.setDurableTimelineStore(durable);

  const ownerAuth = auth.validateToken(auth.createToken("alice@test.com", "Alice"));
  const ownerId = ownerAuth.user.id;
  const workspaceId = workspaceManager.createWorkspace("RO WS", ownerId).id;
  return {
    storage,
    sqlite,
    auth,
    workspaceManager,
    messageRouter,
    dispatcher,
    manager,
    durable,
    workspaceId,
    ownerId,
    ownerAuth,
    tmpDir,
    dbPath,
  };
}

function teardownHarness(h: Harness) {
  h.storage.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(h.dbPath + suffix)) unlinkSync(h.dbPath + suffix);
  }
}

function collect(): { emit: (m: any) => void; messages: any[] } {
  const messages: any[] = [];
  return { emit: (m) => messages.push(m), messages };
}

// ─── 1. Durable capture store (task 1.3) ───────────────────────────────────

describe("ephemeral_session_context store", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => teardownHarness(h));

  it("inserts, reads back by agentId, and prunes past the TTL", () => {
    h.storage.saveEphemeralSessionContext({
      agentId: "a1",
      workspaceId: h.workspaceId,
      channelId: "c1",
      cyboId: "cybo1",
      systemPrompt: "You are Apex.",
      mcpServersJson: JSON.stringify([{ name: "cyborg7", type: "http" }]),
    });
    h.storage.updateEphemeralSessionContextPrompts("a1", "FRAMED", "raw");

    const row = h.storage.getEphemeralSessionContext("a1");
    expect(row?.system_prompt).toBe("You are Apex.");
    expect(row?.routed_prompt).toBe("FRAMED");
    expect(row?.raw_prompt).toBe("raw");
    expect(row?.channel_id).toBe("c1");

    // Not yet past TTL.
    expect(h.storage.pruneEphemeralSessionContext({ olderThanMs: 60_000 })).toBe(0);
    expect(h.storage.getEphemeralSessionContext("a1")).toBeDefined();

    // Past TTL → pruned.
    const pruned = h.storage.pruneEphemeralSessionContext({
      olderThanMs: 0,
      now: Date.now() + 1000,
    });
    expect(pruned).toBe(1);
    expect(h.storage.getEphemeralSessionContext("a1")).toBeUndefined();
  });
});

// ─── 2. Capture at spawn + survives teardown (tasks 2.3, 2.4) ───────────────

async function spawnEphemeralCybo(h: Harness, mcpServers: Record<string, unknown>) {
  const cybo = h.sqlite.createCybo({
    workspaceId: h.workspaceId,
    slug: "apex",
    name: "Apex",
    soul: "Be helpful.",
    provider: "claude",
    createdBy: h.ownerId,
    mcpServers,
  });
  const result = await spawnCybo({
    storage: h.storage,
    agentManager: h.manager as any,
    workspaceId: h.workspaceId,
    cyboIdOrSlug: cybo.id,
    userId: h.ownerId,
    serverId: "daemon-1",
    ephemeral: true,
    context: { channelId: "chan-1", channelName: "general", cwd: h.tmpDir },
  });
  return { cybo, agentId: result.agentId };
}

describe("capture at spawn + routeToAgent threading", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => teardownHarness(h));

  it("captures system prompt + tools at spawn and the routed/raw prompt on route, and survives teardown", async () => {
    const { agentId } = await spawnEphemeralCybo(h, {
      memory: { type: "http", url: "https://mcp.example/memory" },
    });

    // After spawn: system prompt + tools made available are captured.
    const afterSpawn = h.storage.getEphemeralSessionContext(agentId);
    expect(afterSpawn).toBeDefined();
    expect(afterSpawn?.system_prompt).toContain("Apex");
    const tools = JSON.parse(afterSpawn?.mcp_servers_json ?? "[]");
    expect(tools).toEqual([{ name: "memory", type: "http", url: "https://mcp.example/memory" }]);
    expect(afterSpawn?.routed_prompt).toBeNull();

    // Route a turn: the framed + raw prompt are threaded into the same row.
    h.manager.getAgent.mockReturnValue({ id: agentId } as any);
    await h.messageRouter.routeToAgent(agentId, "FRAMED roster + transcript + text", {
      rawPrompt: "hola apex",
    });
    const afterRoute = h.storage.getEphemeralSessionContext(agentId);
    expect(afterRoute?.routed_prompt).toBe("FRAMED roster + transcript + text");
    expect(afterRoute?.raw_prompt).toBe("hola apex");

    // Teardown drops the binding but the capture row SURVIVES (#994 invariant).
    await (h.messageRouter as any).teardownEphemeralAgent(agentId);
    expect(h.storage.getAgentBinding(agentId)).toBeUndefined();
    expect(h.storage.getEphemeralSessionContext(agentId)).toBeDefined();
  });
});

// ─── 3 + 4. Read RPCs: transcript + context post-teardown, authz, no-revive ──

function seedTornDownEphemeral(
  h: Harness,
  agentId: string,
  opts?: { systemPrompt?: string; mcpServersJson?: string; routedPrompt?: string },
) {
  // Simulate a torn-down ephemeral session: durable rows on disk, a capture row,
  // but NO live binding (teardown deleted it).
  h.storage.saveEphemeralSessionContext({
    agentId,
    workspaceId: h.workspaceId,
    channelId: "chan-1",
    cyboId: "cybo-x",
    systemPrompt: opts?.systemPrompt ?? "You are Apex.",
    mcpServersJson: opts?.mcpServersJson ?? JSON.stringify([{ name: "cyborg7", type: "http" }]),
  });
  h.storage.updateEphemeralSessionContextPrompts(agentId, opts?.routedPrompt ?? "FRAMED", "raw");
}

describe("read RPCs (timeline + context)", () => {
  let h: Harness;
  let scopes: Map<string, Set<string>>;
  beforeEach(() => {
    scopes = new Map();
    h = makeHarness({ pg: fakePg(scopes) });
    scopes.set(h.ownerId, new Set(["admin", "chat", "spawn", "terminal"]));
  });
  afterEach(() => teardownHarness(h));

  it("serves the durable transcript of a torn-down ephemeral session to the owner", async () => {
    const agentId = "ephem-1";
    seedTornDownEphemeral(h, agentId);
    await h.durable.appendCommitted(agentId, { type: "user_message", text: "hola apex" } as any);
    await h.durable.appendCommitted(agentId, {
      type: "assistant_message",
      text: "hello!",
    } as any);

    const { emit, messages } = collect();
    await h.dispatcher.dispatch(
      {
        type: "cyborg:fetch_agent_timeline",
        requestId: "r1",
        workspaceId: h.workspaceId,
        agentId,
      } as any,
      h.ownerAuth,
      emit,
    );

    const resp = messages.find((m) => m.type === "cyborg:fetch_agent_timeline_response");
    expect(resp).toBeDefined();
    expect(resp.payload.items.map((i: any) => i.text)).toEqual(["hola apex", "hello!"]);
    // No binding existed, yet the rows were served — and NO revive happened.
    expect(h.manager.resumeAgentFromPersistence).not.toHaveBeenCalled();
  });

  it("serves the captured context bundle to the owner for an ephemeral session", async () => {
    const agentId = "ephem-2";
    seedTornDownEphemeral(h, agentId);
    const { emit, messages } = collect();
    await h.dispatcher.dispatch(
      {
        type: "cyborg:fetch_session_context",
        requestId: "r2",
        workspaceId: h.workspaceId,
        agentId,
      } as any,
      h.ownerAuth,
      emit,
    );
    const resp = messages.find((m) => m.type === "cyborg:fetch_session_context_response");
    expect(resp.payload.context).not.toBeNull();
    expect(resp.payload.context.systemPrompt).toBe("You are Apex.");
    expect(resp.payload.context.routedPrompt).toBe("FRAMED");
    expect(resp.payload.context.rawPrompt).toBe("raw");
    expect(resp.payload.context.mcpServers).toEqual([{ name: "cyborg7", type: "http" }]);
  });

  it("returns context:null for an ordinary (non-ephemeral) agent", async () => {
    // A live, non-ephemeral binding with no capture row.
    h.storage.createAgentBinding({
      agentId: "live-1",
      workspaceId: h.workspaceId,
      provider: "claude",
      ephemeral: false,
    });
    const { emit, messages } = collect();
    await h.dispatcher.dispatch(
      {
        type: "cyborg:fetch_session_context",
        requestId: "r3",
        workspaceId: h.workspaceId,
        agentId: "live-1",
      } as any,
      h.ownerAuth,
      emit,
    );
    const resp = messages.find((m) => m.type === "cyborg:fetch_session_context_response");
    expect(resp.payload.context).toBeNull();
  });

  it("rejects a requester without audit scope for BOTH read RPCs", async () => {
    const agentId = "ephem-3";
    seedTornDownEphemeral(h, agentId);
    await h.durable.appendCommitted(agentId, { type: "user_message", text: "secret" } as any);

    const bob = h.auth.validateToken(h.auth.createToken("bob@test.com", "Bob"));
    scopes.set(bob.user.id, new Set(["chat"])); // chat-only — NOT admin

    const ctx = collect();
    await h.dispatcher.dispatch(
      {
        type: "cyborg:fetch_session_context",
        requestId: "r4",
        workspaceId: h.workspaceId,
        agentId,
      } as any,
      bob,
      ctx.emit,
    );
    const ctxErr = ctx.messages.find((m) => m.type === "cyborg:error");
    expect(ctxErr?.payload.code).toBe("forbidden");
    expect(
      ctx.messages.find((m) => m.type === "cyborg:fetch_session_context_response"),
    ).toBeUndefined();

    const tl = collect();
    await h.dispatcher.dispatch(
      {
        type: "cyborg:fetch_agent_timeline",
        requestId: "r5",
        workspaceId: h.workspaceId,
        agentId,
      } as any,
      bob,
      tl.emit,
    );
    const tlErr = tl.messages.find((m) => m.type === "cyborg:error");
    expect(tlErr?.payload.code).toBe("not_found");
    expect(
      tl.messages.find((m) => m.type === "cyborg:fetch_agent_timeline_response"),
    ).toBeUndefined();
  });

  it("NEVER revives the agent on either read RPC (dormant + ephemeral)", async () => {
    // (a) torn-down ephemeral session (no binding).
    const ephemeralId = "ephem-4";
    seedTornDownEphemeral(h, ephemeralId);
    await h.durable.appendCommitted(ephemeralId, {
      type: "assistant_message",
      text: "x",
    } as any);
    // (b) dormant non-ephemeral session (binding exists, agent not loaded).
    h.storage.createAgentBinding({
      agentId: "dormant-1",
      workspaceId: h.workspaceId,
      provider: "claude",
      ephemeral: false,
    });
    await h.durable.appendCommitted("dormant-1", {
      type: "assistant_message",
      text: "y",
    } as any);

    const reviveSpy = vi.spyOn(h.dispatcher as any, "ensureAgentLoaded");

    for (const agentId of [ephemeralId, "dormant-1"]) {
      const c1 = collect();
      await h.dispatcher.dispatch(
        {
          type: "cyborg:fetch_agent_timeline",
          requestId: `t-${agentId}`,
          workspaceId: h.workspaceId,
          agentId,
        } as any,
        h.ownerAuth,
        c1.emit,
      );
      const c2 = collect();
      await h.dispatcher.dispatch(
        {
          type: "cyborg:fetch_session_context",
          requestId: `c-${agentId}`,
          workspaceId: h.workspaceId,
          agentId,
        } as any,
        h.ownerAuth,
        c2.emit,
      );
    }

    expect(reviveSpy).not.toHaveBeenCalled();
    expect(h.manager.resumeAgentFromPersistence).not.toHaveBeenCalled();
    expect(h.manager.created).toHaveLength(0); // no provider session created
    // getAgent stays undefined throughout — nothing was loaded into the manager.
    expect(h.manager.getAgent(ephemeralId)).toBeUndefined();
    expect(h.manager.getAgent("dormant-1")).toBeUndefined();
  });
});

// ─── Secret redaction (task: redaction on the served context) ───────────────

describe("secret redaction on served context", () => {
  let h: Harness;
  let scopes: Map<string, Set<string>>;
  beforeEach(() => {
    scopes = new Map();
    h = makeHarness({ pg: fakePg(scopes) });
    scopes.set(h.ownerId, new Set(["admin"]));
  });
  afterEach(() => teardownHarness(h));

  it("redacts ck_/sk- keys and MCP url tokens before serving", async () => {
    const agentId = "ephem-redact";
    h.storage.saveEphemeralSessionContext({
      agentId,
      workspaceId: h.workspaceId,
      channelId: "chan-1",
      cyboId: "cybo-x",
      systemPrompt: "Your key is sk-ant-abc123def456ghi and router ck_live_9988776655.",
      mcpServersJson: JSON.stringify([
        {
          name: "composio",
          type: "http",
          url: "https://mcp.composio.dev/x?token=tok_supersecret12345",
        },
      ]),
    });
    h.storage.updateEphemeralSessionContextPrompts(agentId, "use sk-deadbeefdeadbeef00", "raw");

    const { emit, messages } = collect();
    await h.dispatcher.dispatch(
      {
        type: "cyborg:fetch_session_context",
        requestId: "rr",
        workspaceId: h.workspaceId,
        agentId,
      } as any,
      h.ownerAuth,
      emit,
    );
    const ctx = messages.find((m) => m.type === "cyborg:fetch_session_context_response").payload
      .context;
    expect(ctx.systemPrompt).not.toContain("sk-ant-abc123def456ghi");
    expect(ctx.systemPrompt).not.toContain("ck_live_9988776655");
    expect(ctx.systemPrompt).toContain("[redacted]");
    expect(ctx.routedPrompt).not.toContain("sk-deadbeefdeadbeef00");
    expect(ctx.mcpServers[0].url).not.toContain("tok_supersecret12345");
    expect(ctx.mcpServers[0].url).toContain("[redacted]");
  });

  it("redactSecrets leaves clean text untouched", () => {
    expect(redactSecrets("just a normal prompt")).toBe("just a normal prompt");
    expect(redactSecrets(null)).toBeNull();
  });
});
