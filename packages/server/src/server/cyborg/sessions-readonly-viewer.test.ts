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
function fakePg(
  scopesByUser: Map<string, Set<string>>,
  channelMembers?: Map<string, Array<{ userId: string; email: string }>>,
) {
  const base: Record<string, any> = {
    getUserDaemonScopes: async (_ws: string, _daemon: string, userId: string) =>
      scopesByUser.get(userId) ?? new Set<string>(),
    // Channel membership for the IDOR read-gate (canReadLiveSession). Returns the
    // humans in a channel keyed by CLOUD id + email — mirrors pg.getChannelMembers.
    getChannelMembers: async (channelId: string) =>
      (channelMembers?.get(channelId) ?? []).map((m) => ({
        userId: m.userId,
        email: m.email,
        name: null,
        role: "member",
        joinedAt: 0,
      })),
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

function makeHarness(opts?: { pg?: any; ownerEmail?: string }): Harness {
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

  const ownerAuth = auth.validateToken(
    auth.createToken(opts?.ownerEmail ?? "alice@test.com", "Alice"),
  );
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

// ─── IDOR gate: LIVE session reads (initiator / channel-member / admin) ──────

// A live binding that is loaded in the agent manager (getAgent returns it), with a
// durable transcript so the read returns rows.
async function seedLiveSession(
  h: Harness,
  agentId: string,
  opts: { channelId?: string | null; initiatedBy?: string | null },
) {
  h.storage.createAgentBinding({
    agentId,
    workspaceId: h.workspaceId,
    channelId: opts.channelId ?? null,
    provider: "claude",
    initiatedBy: opts.initiatedBy ?? null,
    ephemeral: false,
  });
  h.manager.getAgent.mockImplementation((id: string) => (id === agentId ? ({ id } as any) : undefined));
  await h.durable.appendCommitted(agentId, { type: "user_message", text: "secret transcript" } as any);
}

async function fetchTimeline(h: Harness, agentId: string, who: any) {
  const c = collect();
  await h.dispatcher.dispatch(
    { type: "cyborg:fetch_agent_timeline", requestId: "tl", workspaceId: h.workspaceId, agentId } as any,
    who,
    c.emit,
  );
  return c.messages;
}

describe("IDOR gate: live session timeline/context reads", () => {
  let h: Harness;
  let scopes: Map<string, Set<string>>;
  let channelMembers: Map<string, Array<{ userId: string; email: string }>>;
  beforeEach(() => {
    scopes = new Map();
    channelMembers = new Map();
    // Owner = Alice, holds admin (audit) scope.
    h = makeHarness({ pg: fakePg(scopes, channelMembers) });
    scopes.set(h.ownerId, new Set(["admin"]));
  });
  afterEach(() => teardownHarness(h));

  it("DENIES a non-member of the session's channel", async () => {
    const initiator = h.auth.validateToken(h.auth.createToken("initiator@test.com", "Init"));
    await seedLiveSession(h, "live-ch", { channelId: "chan-X", initiatedBy: initiator.user.id });
    channelMembers.set("chan-X", [{ userId: initiator.user.id, email: "initiator@test.com" }]);

    const stranger = h.auth.validateToken(h.auth.createToken("stranger@test.com", "Stranger"));
    const msgs = await fetchTimeline(h, "live-ch", stranger);
    expect(msgs.find((m) => m.type === "cyborg:error")?.payload.code).toBe("forbidden");
    expect(msgs.find((m) => m.type === "cyborg:fetch_agent_timeline_response")).toBeUndefined();
  });

  // PRIVACY (2026-06-30): channel-bound cybo sessions are OWNER-SCOPED. A plain
  // channel MEMBER who is neither the initiator nor an admin can NO LONGER read the
  // transcript just by being in the channel. (Reverses the earlier "channel member
  // can read" assertion — intended behavior change now that sessions are private.)
  it("DENIES a non-initiator, non-admin channel MEMBER (owner-scoped now)", async () => {
    await seedLiveSession(h, "live-ch2", { channelId: "chan-Y", initiatedBy: "someone-else" });
    const member = h.auth.validateToken(h.auth.createToken("member@test.com", "Member"));
    channelMembers.set("chan-Y", [{ userId: member.user.id, email: "member@test.com" }]);

    const msgs = await fetchTimeline(h, "live-ch2", member);
    expect(msgs.find((m) => m.type === "cyborg:error")?.payload.code).toBe("forbidden");
    expect(msgs.find((m) => m.type === "cyborg:fetch_agent_timeline_response")).toBeUndefined();
  });

  it("ALLOWS the initiator of a channel-bound session (email-bridged)", async () => {
    const initiator = h.auth.validateToken(h.auth.createToken("chinit@test.com", "ChInit"));
    await seedLiveSession(h, "live-ch3", { channelId: "chan-Y2", initiatedBy: initiator.user.id });
    // Initiator is NOT in the channel-members map — read is granted by ownership, not membership.
    const msgs = await fetchTimeline(h, "live-ch3", initiator);
    const resp = msgs.find((m) => m.type === "cyborg:fetch_agent_timeline_response");
    expect(resp).toBeDefined();
    expect(resp.payload.items.map((i: any) => i.text)).toEqual(["secret transcript"]);
  });

  it("ALLOWS the session initiator (even with no channel membership)", async () => {
    const initiator = h.auth.validateToken(h.auth.createToken("owner2@test.com", "Owner2"));
    await seedLiveSession(h, "live-priv", { channelId: null, initiatedBy: initiator.user.id });
    const msgs = await fetchTimeline(h, "live-priv", initiator);
    expect(msgs.find((m) => m.type === "cyborg:fetch_agent_timeline_response")).toBeDefined();
  });

  it("ALLOWS an admin (audit) read of any session", async () => {
    const initiator = h.auth.validateToken(h.auth.createToken("someone@test.com", "Someone"));
    await seedLiveSession(h, "live-priv2", { channelId: null, initiatedBy: initiator.user.id });
    // h.ownerAuth (Alice) holds admin scope but is NOT the initiator or a channel member.
    const msgs = await fetchTimeline(h, "live-priv2", h.ownerAuth);
    expect(msgs.find((m) => m.type === "cyborg:fetch_agent_timeline_response")).toBeDefined();
  });

  it("DENIES a non-initiator, non-admin for a PRIVATE (no-channel) session", async () => {
    const initiator = h.auth.validateToken(h.auth.createToken("owner3@test.com", "Owner3"));
    await seedLiveSession(h, "live-priv3", { channelId: null, initiatedBy: initiator.user.id });
    const stranger = h.auth.validateToken(h.auth.createToken("nobody@test.com", "Nobody"));
    const msgs = await fetchTimeline(h, "live-priv3", stranger);
    expect(msgs.find((m) => m.type === "cyborg:error")?.payload.code).toBe("forbidden");
  });

  it("gates fetch_session_context the same way (channel member denied, initiator allowed)", async () => {
    const initiator = h.auth.validateToken(h.auth.createToken("ctxowner@test.com", "CtxOwner"));
    await seedLiveSession(h, "live-ctx", { channelId: "chan-Z", initiatedBy: initiator.user.id });
    h.storage.saveEphemeralSessionContext({
      agentId: "live-ctx",
      workspaceId: h.workspaceId,
      channelId: "chan-Z",
      cyboId: "cybo-z",
      systemPrompt: "You are Z.",
    });
    // A plain channel MEMBER is now DENIED (owner-scoped, privacy 2026-06-30).
    const member = h.auth.validateToken(h.auth.createToken("cm@test.com", "CM"));
    channelMembers.set("chan-Z", [{ userId: member.user.id, email: "cm@test.com" }]);

    const denied = collect();
    await h.dispatcher.dispatch(
      { type: "cyborg:fetch_session_context", requestId: "x1", workspaceId: h.workspaceId, agentId: "live-ctx" } as any,
      member,
      denied.emit,
    );
    expect(denied.messages.find((m) => m.type === "cyborg:error")?.payload.code).toBe("forbidden");

    // The INITIATOR reads their own context.
    const allowed = collect();
    await h.dispatcher.dispatch(
      { type: "cyborg:fetch_session_context", requestId: "x2", workspaceId: h.workspaceId, agentId: "live-ctx" } as any,
      initiator,
      allowed.emit,
    );
    expect(
      allowed.messages.find((m) => m.type === "cyborg:fetch_session_context_response")?.payload.context
        ?.systemPrompt,
    ).toBe("You are Z.");
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

// ─── IDOR back-door: restore / import / list archived-session gates ──────────
// The timeline-read gate is bypassable via restore (it hydrates the victim's full
// transcript into a live agent stamped with the RESTORER as initiator, so the
// gated fetch_agent_timeline then passes for them). These lock the ownership gate
// on restore_session, import_session's idempotent revive, and list_archived_sessions
// (+ the workspace-scoped getArchivedSession lookup).

async function dispatch(h: Harness, msg: any, who: any) {
  const c = collect();
  await h.dispatcher.dispatch(msg, who, c.emit);
  return c.messages;
}

// For ALLOW-path assertions: the gate denies by EMITTING `forbidden` and RETURNING
// (no throw). When it ALLOWS, restore proceeds to importProviderSession, which the
// mock agent manager can't satisfy and throws — that throw means the gate PASSED.
// Swallow it so the test can assert "no forbidden error" without an unhandled reject.
async function dispatchPastGate(h: Harness, msg: any, who: any) {
  const c = collect();
  try {
    await h.dispatcher.dispatch(msg, who, c.emit);
  } catch {
    // Post-gate hydration failure in the mock — proves the gate let it through.
  }
  return c.messages;
}

describe("IDOR gate: restore_session ownership", () => {
  let h: Harness;
  let scopes: Map<string, Set<string>>;
  beforeEach(() => {
    scopes = new Map();
    h = makeHarness({ pg: fakePg(scopes) });
    scopes.set(h.ownerId, new Set(["admin"])); // Alice = workspace owner/admin (audit)
  });
  afterEach(() => teardownHarness(h));

  // Seed an archived row owned by `owner` and return its id.
  function seedArchived(owner: { id: string | null; email: string | null }): string {
    return h.storage.archiveSession({
      workspaceId: h.workspaceId,
      provider: "claude",
      providerHandleId: "handle-1",
      initiatedBy: owner.id,
      initiatedByEmail: owner.email,
    }).id;
  }

  it("DENIES a non-owner, non-admin member (the back-door)", async () => {
    const victim = h.auth.validateToken(h.auth.createToken("victim@test.com", "Victim"));
    const id = seedArchived({ id: victim.user.id, email: "victim@test.com" });
    const attacker = h.auth.validateToken(h.auth.createToken("attacker@test.com", "Attacker"));
    const msgs = await dispatch(
      h,
      { type: "cyborg:restore_session", requestId: "r1", workspaceId: h.workspaceId, sessionId: id },
      attacker,
    );
    expect(msgs.find((m) => m.type === "cyborg:error")?.payload.code).toBe("forbidden");
    expect(msgs.find((m) => m.type === "cyborg:restore_session_response")).toBeUndefined();
  });

  it("ALLOWS the OWNER (matched by initiated_by) past the gate", async () => {
    const owner = h.auth.validateToken(h.auth.createToken("owner-r@test.com", "OwnerR"));
    const id = seedArchived({ id: owner.user.id, email: "owner-r@test.com" });
    const msgs = await dispatchPastGate(
      h,
      { type: "cyborg:restore_session", requestId: "r2", workspaceId: h.workspaceId, sessionId: id },
      owner,
    );
    // The gate let it through — any error is NOT a forbidden (it's the mock manager
    // failing to hydrate, which proves the gate passed).
    expect(msgs.find((m) => m.type === "cyborg:error")?.payload.code).not.toBe("forbidden");
  });

  it("ALLOWS the OWNER when only the email matches (id bridged across namespaces)", async () => {
    // Row stamped with a DIFFERENT local id but the owner's canonical email.
    const id = seedArchived({ id: "local-xyz", email: "owner-e@test.com" });
    const owner = h.auth.validateToken(h.auth.createToken("owner-e@test.com", "OwnerE"));
    const msgs = await dispatchPastGate(
      h,
      { type: "cyborg:restore_session", requestId: "r3", workspaceId: h.workspaceId, sessionId: id },
      owner,
    );
    expect(msgs.find((m) => m.type === "cyborg:error")?.payload.code).not.toBe("forbidden");
  });

  it("ALLOWS a workspace ADMIN to restore any session (audit)", async () => {
    const someone = h.auth.validateToken(h.auth.createToken("someone-r@test.com", "SomeoneR"));
    const id = seedArchived({ id: someone.user.id, email: "someone-r@test.com" });
    // Alice (ownerAuth) holds admin scope but is neither initiator nor email-owner.
    const msgs = await dispatchPastGate(
      h,
      { type: "cyborg:restore_session", requestId: "r4", workspaceId: h.workspaceId, sessionId: id },
      h.ownerAuth,
    );
    expect(msgs.find((m) => m.type === "cyborg:error")?.payload.code).not.toBe("forbidden");
  });

  it("DENIES a non-admin for a NULL-owner legacy row (fail-closed)", async () => {
    const id = seedArchived({ id: null, email: null });
    const plain = h.auth.validateToken(h.auth.createToken("plain@test.com", "Plain"));
    const msgs = await dispatch(
      h,
      { type: "cyborg:restore_session", requestId: "r5", workspaceId: h.workspaceId, sessionId: id },
      plain,
    );
    expect(msgs.find((m) => m.type === "cyborg:error")?.payload.code).toBe("forbidden");
  });

  it("DENIES restoring a session that lives in a DIFFERENT workspace (id scope)", async () => {
    // Archive in THIS workspace, then attempt restore under a bogus workspace id.
    const owner = h.auth.validateToken(h.auth.createToken("owner-w@test.com", "OwnerW"));
    const id = seedArchived({ id: owner.user.id, email: "owner-w@test.com" });
    const msgs = await dispatch(
      h,
      { type: "cyborg:restore_session", requestId: "r6", workspaceId: "ws-other", sessionId: id },
      owner,
    );
    // Workspace-scoped lookup returns undefined ⇒ "not found", never a leak.
    expect(msgs.find((m) => m.type === "cyborg:restore_session_response")).toBeUndefined();
    expect(msgs.find((m) => m.type === "cyborg:error")).toBeDefined();
  });

  it("getArchivedSession is workspace-scoped (won't return a foreign-workspace row)", () => {
    const id = seedArchived({ id: "x", email: "x@test.com" });
    expect(h.storage.getArchivedSession(id, h.workspaceId)?.id).toBe(id);
    expect(h.storage.getArchivedSession(id, "ws-other")).toBeUndefined();
  });
});

describe("IDOR gate: import_session idempotent-revive ownership", () => {
  let h: Harness;
  let scopes: Map<string, Set<string>>;
  beforeEach(() => {
    scopes = new Map();
    h = makeHarness({ pg: fakePg(scopes) });
    scopes.set(h.ownerId, new Set(["admin"]));
  });
  afterEach(() => teardownHarness(h));

  it("DENIES importing when an existing archived row in the workspace is owned by another user", async () => {
    const victim = h.auth.validateToken(h.auth.createToken("victim-i@test.com", "VictimI"));
    // Pre-existing archived row (provider+handle the attacker will import) owned by victim.
    h.storage.archiveSession({
      workspaceId: h.workspaceId,
      provider: "claude",
      providerHandleId: "shared-handle",
      initiatedBy: victim.user.id,
      initiatedByEmail: "victim-i@test.com",
    });
    // Attacker passes the create_agent permission (workspace admin role) but holds
    // NO daemon audit scope — so the ownership gate (isAuditVisible + initiator) is
    // the SOLE denier here, not the upstream permission check.
    const attacker = h.auth.validateToken(h.auth.createToken("attacker-i@test.com", "AttackerI"));
    h.storage.addMember(h.workspaceId, attacker.user.id, "admin");
    const msgs = await dispatch(
      h,
      {
        type: "cyborg:import_session",
        requestId: "i1",
        workspaceId: h.workspaceId,
        provider: "claude",
        providerHandleId: "shared-handle",
      },
      attacker,
    );
    const err = msgs.find((m) => m.type === "cyborg:error");
    expect(err).toBeDefined();
    expect(err?.payload.message).toMatch(/not authorized to import/i);
  });
});

describe("IDOR gate: list_archived_sessions own-only vs admin", () => {
  let h: Harness;
  let scopes: Map<string, Set<string>>;
  beforeEach(() => {
    scopes = new Map();
    h = makeHarness({ pg: fakePg(scopes) });
    scopes.set(h.ownerId, new Set(["admin"])); // Alice = admin (audit ⇒ sees all)
  });
  afterEach(() => teardownHarness(h));

  function listFor(who: any) {
    return dispatch(h, {
      type: "cyborg:list_archived_sessions",
      requestId: "L",
      workspaceId: h.workspaceId,
    }, who);
  }
  function idsOf(msgs: any[]): string[] {
    const resp = msgs.find((m) => m.type === "cyborg:list_archived_sessions_response");
    return (resp?.payload.sessions ?? []).map((s: any) => s.id);
  }

  it("a plain member sees ONLY their own sessions; an admin sees ALL", async () => {
    const bob = h.auth.validateToken(h.auth.createToken("bob@test.com", "Bob"));
    const carol = h.auth.validateToken(h.auth.createToken("carol@test.com", "Carol"));
    const bobRow = h.storage.archiveSession({
      workspaceId: h.workspaceId,
      provider: "claude",
      providerHandleId: "h-bob",
      initiatedBy: bob.user.id,
      initiatedByEmail: "bob@test.com",
    }).id;
    const carolRow = h.storage.archiveSession({
      workspaceId: h.workspaceId,
      provider: "claude",
      providerHandleId: "h-carol",
      initiatedBy: carol.user.id,
      initiatedByEmail: "carol@test.com",
    }).id;
    const legacyRow = h.storage.archiveSession({
      workspaceId: h.workspaceId,
      provider: "claude",
      providerHandleId: "h-legacy",
      initiatedBy: null,
      initiatedByEmail: null,
    }).id;

    // Bob (plain member, no admin scope): only his own row, never Carol's or the legacy one.
    const bobIds = idsOf(await listFor(bob));
    expect(bobIds).toContain(bobRow);
    expect(bobIds).not.toContain(carolRow);
    expect(bobIds).not.toContain(legacyRow);

    // Alice (admin): sees everything, including the null-owner legacy row.
    const adminIds = idsOf(await listFor(h.ownerAuth));
    expect(adminIds).toEqual(expect.arrayContaining([bobRow, carolRow, legacyRow]));
  });
});
