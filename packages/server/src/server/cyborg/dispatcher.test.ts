import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { CyborgAuth } from "./auth.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MessageRouter, type BroadcastFn } from "./message-router.js";
import { CyborgDispatcher } from "./dispatcher.js";
import type { CyborgAuthContext } from "./auth.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { PgSync } from "./db/pg-sync.js";
import { DAEMON_SCOPES, type DaemonScope } from "./daemon-scopes.js";

// Daemon-owner audit listing (#993): cyborg:list_daemon_sessions returns ALL
// sessions on ONE daemon — ephemeral/internal + other users' — gated on the
// `admin` daemon scope. These tests prove the listing, the gate (dispatcher
// layer), and that the scoped cyborg:list_agents path is left untouched.

interface Emitted {
  type: string;
  payload: Record<string, unknown>;
}

const DAEMON_D = "daemon-D";
const DAEMON_E = "daemon-E";

// Minimal PgSync stub: a real getUserDaemonScopes (per-user map) so the gate is
// meaningfully exercised; every other pg method is a fire-and-forget no-op (the
// DualStorage writes chain .then/.catch on a resolved promise) so the sqlite-first
// data path is unaffected.
function makePgStub(scopesByUser: Map<string, Set<DaemonScope>>): PgSync {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "getUserDaemonScopes") {
          return async (_ws: string, _d: string, userId: string) =>
            scopesByUser.get(userId) ?? new Set<DaemonScope>();
        }
        return async () => undefined;
      },
    },
  ) as unknown as PgSync;
}

describe("cyborg:list_daemon_sessions (dispatcher audit)", () => {
  let storage: DualStorage;
  let sqlite: CyborgStorage;
  let auth: CyborgAuth;
  let dispatcher: CyborgDispatcher;
  let tmpDir: string;
  let owner: CyborgAuthContext;
  let member: CyborgAuthContext;
  let workspaceId: string;
  let otherUserId: string;
  const scopesByUser = new Map<string, Set<DaemonScope>>();

  async function dispatch(msg: Record<string, unknown>, who = owner): Promise<Emitted[]> {
    const out: Emitted[] = [];
    await dispatcher.dispatch(msg as never, who, (m) => out.push(m as Emitted));
    return out;
  }

  function bind(opts: {
    agentId: string;
    initiatedBy?: string | null;
    ephemeral?: boolean;
    daemonId?: string | null;
    channelId?: string | null;
  }): void {
    sqlite.createAgentBinding({
      agentId: opts.agentId,
      workspaceId,
      provider: "claude",
      cyboId: null,
      initiatedBy: opts.initiatedBy ?? null,
      ephemeral: opts.ephemeral ?? false,
      daemonId: opts.daemonId ?? DAEMON_D,
      channelId: opts.channelId ?? null,
    });
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-audit-"));
    sqlite = new CyborgStorage(path.join(tmpDir, "test.db"));
    scopesByUser.clear();
    storage = new DualStorage(sqlite, makePgStub(scopesByUser));
    auth = new CyborgAuth(storage);
    const workspaceManager = new WorkspaceManager(storage);
    const broadcast: BroadcastFn = { toWorkspace() {}, toUser() {} };
    const messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
    dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);
    dispatcher.setServerId(DAEMON_D);

    // A live "internal" agent so the ephemeral summon row also surfaces internal:true.
    // Minimal ManagedAgent shape (liveAgentFields reads config/lifecycle/etc).
    dispatcher.setAgentManager({
      getAgent: (id: string) =>
        id === "ephemeral-1"
          ? {
              internal: true,
              lifecycle: "running",
              config: {},
              currentModeId: null,
              availableModes: [],
              runtimeInfo: undefined,
              cwd: null,
              attention: undefined,
            }
          : undefined,
    } as unknown as AgentManager);

    owner = auth.validateToken(auth.createToken("owner@test.com", "Owner"))!;
    member = auth.validateToken(auth.createToken("member@test.com", "Member"))!;
    const other = sqlite.upsertUser("other@test.com", "Other");
    otherUserId = other.id;

    // Owner ⇒ full scope set (mirrors pg-sync's owner-implicit behavior). Member ⇒
    // no scope on D. Each test overrides as needed.
    scopesByUser.set(owner.user.id, new Set<DaemonScope>(DAEMON_SCOPES));

    const ws = await dispatch({
      type: "cyborg:create_workspace",
      name: "Audit WS",
      requestId: "w1",
    });
    workspaceId = (ws[0].payload.workspace as { id: string }).id;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("owner audit returns ALL sessions incl. ephemeral + other users'", async () => {
    bind({ agentId: "ephemeral-1", initiatedBy: owner.user.id, ephemeral: true });
    bind({ agentId: "other-1", initiatedBy: otherUserId });
    bind({ agentId: "owner-1", initiatedBy: owner.user.id });

    const out = await dispatch({
      type: "cyborg:list_daemon_sessions",
      requestId: "a1",
      workspaceId,
      daemonId: DAEMON_D,
    });

    const resp = out.find((m) => m.type === "cyborg:list_daemon_sessions_response");
    expect(resp).toBeDefined();
    const sessions = resp!.payload.sessions as Array<Record<string, unknown>>;
    const ids = sessions.map((s) => s.agentId).sort();
    expect(ids).toEqual(["ephemeral-1", "other-1", "owner-1"]);
    const eph = sessions.find((s) => s.agentId === "ephemeral-1")!;
    expect(eph.ephemeral).toBe(true);
    expect(eph.internal).toBe(true);
    const ownerRow = sessions.find((s) => s.agentId === "owner-1")!;
    expect(ownerRow.ephemeral).toBe(false);
    expect(ownerRow.internal).toBe(false);
  });

  it("denies a non-admin member with forbidden — and their scoped list_agents is untouched", async () => {
    // The member owns one normal session; another user owns another. The audit is
    // denied, but the scoped list_agents still returns ONLY the member's own.
    bind({ agentId: "member-own", initiatedBy: member.user.id });
    bind({ agentId: "ephemeral-1", initiatedBy: otherUserId, ephemeral: true });
    bind({ agentId: "other-1", initiatedBy: otherUserId });

    const denied = await dispatch(
      { type: "cyborg:list_daemon_sessions", requestId: "a2", workspaceId, daemonId: DAEMON_D },
      member,
    );
    const err = denied.find((m) => m.type === "cyborg:error");
    expect(err?.payload.code).toBe("forbidden");
    expect(err?.payload.requestId).toBe("a2");
    expect(denied.find((m) => m.type === "cyborg:list_daemon_sessions_response")).toBeUndefined();

    const scoped = await dispatch(
      { type: "cyborg:list_agents", requestId: "l1", workspaceId },
      member,
    );
    const agents = scoped.find((m) => m.type === "cyborg:list_agents_response")!.payload
      .agents as Array<Record<string, unknown>>;
    expect(agents.map((a) => a.agentId)).toEqual(["member-own"]);
  });

  it("allows an explicit admin grantee (not owner)", async () => {
    scopesByUser.set(member.user.id, new Set<DaemonScope>(["admin"]));
    bind({ agentId: "owner-1", initiatedBy: owner.user.id });

    const out = await dispatch(
      { type: "cyborg:list_daemon_sessions", requestId: "a3", workspaceId, daemonId: DAEMON_D },
      member,
    );
    const resp = out.find((m) => m.type === "cyborg:list_daemon_sessions_response");
    expect(resp).toBeDefined();
    expect((resp!.payload.sessions as unknown[]).length).toBe(1);
  });

  it("denies a member with only chat/spawn/terminal scope", async () => {
    for (const scope of ["chat", "spawn", "terminal"] as DaemonScope[]) {
      scopesByUser.set(member.user.id, new Set<DaemonScope>([scope]));
      const out = await dispatch(
        {
          type: "cyborg:list_daemon_sessions",
          requestId: `s-${scope}`,
          workspaceId,
          daemonId: DAEMON_D,
        },
        member,
      );
      expect(out.find((m) => m.type === "cyborg:error")?.payload.code).toBe("forbidden");
    }
  });

  it("does not include sessions bound to a different daemon", async () => {
    bind({ agentId: "on-D", initiatedBy: owner.user.id, daemonId: DAEMON_D });
    bind({ agentId: "on-E", initiatedBy: owner.user.id, daemonId: DAEMON_E });

    const out = await dispatch({
      type: "cyborg:list_daemon_sessions",
      requestId: "a4",
      workspaceId,
      daemonId: DAEMON_D,
    });
    const sessions = out.find((m) => m.type === "cyborg:list_daemon_sessions_response")!.payload
      .sessions as Array<Record<string, unknown>>;
    expect(sessions.map((s) => s.agentId)).toEqual(["on-D"]);
  });

  it("includes local-daemon sessions whose binding daemon_id is null (falls back to serverId)", async () => {
    bind({ agentId: "local-null", initiatedBy: owner.user.id, daemonId: null });

    const out = await dispatch({
      type: "cyborg:list_daemon_sessions",
      requestId: "a5",
      workspaceId,
      daemonId: DAEMON_D,
    });
    const sessions = out.find((m) => m.type === "cyborg:list_daemon_sessions_response")!.payload
      .sessions as Array<Record<string, unknown>>;
    expect(sessions.map((s) => s.agentId)).toEqual(["local-null"]);
  });

  it("permits the local caller in solo mode (no shared pg store)", async () => {
    // Rebuild in solo mode (pg=null) — single-tenant host, audit permitted.
    const soloSqlite = new CyborgStorage(path.join(tmpDir, "solo.db"));
    const soloStorage = new DualStorage(soloSqlite, null);
    const soloAuth = new CyborgAuth(soloStorage);
    const wm = new WorkspaceManager(soloStorage);
    const broadcast: BroadcastFn = { toWorkspace() {}, toUser() {} };
    const mr = new MessageRouter(soloStorage, wm, broadcast);
    const solo = new CyborgDispatcher(mr, wm, soloStorage);
    solo.setServerId(DAEMON_D);
    const host = soloAuth.validateToken(soloAuth.createToken("host@test.com", "Host"))!;
    const out1: Emitted[] = [];
    await solo.dispatch(
      { type: "cyborg:create_workspace", name: "Solo", requestId: "sw" } as never,
      host,
      (m) => out1.push(m as Emitted),
    );
    const soloWs = (out1[0].payload.workspace as { id: string }).id;
    soloSqlite.createAgentBinding({
      agentId: "solo-1",
      workspaceId: soloWs,
      provider: "claude",
      cyboId: null,
      initiatedBy: host.user.id,
      daemonId: DAEMON_D,
    });
    const out: Emitted[] = [];
    await solo.dispatch(
      {
        type: "cyborg:list_daemon_sessions",
        requestId: "a6",
        workspaceId: soloWs,
        daemonId: DAEMON_D,
      } as never,
      host,
      (m) => out.push(m as Emitted),
    );
    const resp = out.find((m) => m.type === "cyborg:list_daemon_sessions_response");
    expect(resp).toBeDefined();
    expect((resp!.payload.sessions as unknown[]).length).toBe(1);
  });
});

// handleArchiveAgent ownership guard (#810 security fix): archive must mirror
// handleSendAgentPrompt's ownership rule — a PRIVATE (DM / ephemeral) session is
// archivable ONLY by its initiator; a SHARED (non-ephemeral channel) agent is
// archivable by any member. Previously _auth was unused, so any member could
// archive anyone's private session.
describe("cyborg:archive_agent ownership guard (#810)", () => {
  let storage: DualStorage;
  let sqlite: CyborgStorage;
  let auth: CyborgAuth;
  let dispatcher: CyborgDispatcher;
  let tmpDir: string;
  let owner: CyborgAuthContext; // workspace OWNER
  let member: CyborgAuthContext; // workspace MEMBER (non-admin)
  let workspaceId: string;
  // Live agents the stubbed AgentManager reports. Lets a test simulate a LIVE
  // agent with NO binding (the orphaned-row bypass the review caught).
  const liveAgents = new Map<string, unknown>();

  async function dispatch(
    msg: Record<string, unknown>,
    who: CyborgAuthContext,
  ): Promise<Emitted[]> {
    const out: Emitted[] = [];
    await dispatcher.dispatch(msg as never, who, (m) => out.push(m as Emitted));
    return out;
  }

  function bindSession(agentId: string, initiatedBy: string, channelId: string | null): void {
    sqlite.createAgentBinding({
      agentId,
      workspaceId,
      provider: "claude",
      cyboId: null,
      initiatedBy,
      channelId,
    });
  }

  // A LIVE agent with no binding. labels.channelId null ⇒ a PRIVATE (DM) session.
  function liveOrphan(agentId: string, channelId: string | null = null): void {
    liveAgents.set(agentId, {
      provider: "claude",
      persistence: undefined,
      config: {},
      cwd: null,
      labels: channelId ? { channelId } : {},
    });
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-archive-"));
    sqlite = new CyborgStorage(path.join(tmpDir, "test.db"));
    storage = new DualStorage(sqlite, null);
    auth = new CyborgAuth(storage);
    const workspaceManager = new WorkspaceManager(storage);
    const broadcast: BroadcastFn = { toWorkspace() {}, toUser() {} };
    const messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
    dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);
    dispatcher.setServerId(DAEMON_D);
    liveAgents.clear();
    dispatcher.setAgentManager({
      getAgent: (id: string) => liveAgents.get(id),
      archiveAgent: async () => {},
    } as unknown as AgentManager);

    owner = auth.validateToken(auth.createToken("arch-owner@test.com", "Owner"))!;
    member = auth.validateToken(auth.createToken("arch-member@test.com", "Member"))!;

    const out: Emitted[] = [];
    await dispatcher.dispatch(
      { type: "cyborg:create_workspace", name: "Arch WS", requestId: "w" } as never,
      owner,
      (m) => out.push(m as Emitted),
    );
    workspaceId = (out[0].payload.workspace as { id: string }).id;
    // `member` is a real workspace MEMBER (role member — NOT owner/admin).
    storage.ensureMembership(workspaceId, member.user.id, "member");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects a non-initiator NON-admin member archiving another user's PRIVATE (DM) session", async () => {
    bindSession("dm-owner", owner.user.id, null);
    const out = await dispatch(
      { type: "cyborg:archive_agent", requestId: "ar1", workspaceId, agentId: "dm-owner" },
      member,
    );
    const err = out.find((m) => m.type === "cyborg:error");
    expect(err?.payload.code).toBe("forbidden");
    expect(err?.payload.message).toBe("Cannot archive another user's private agent session");
    expect(out.find((m) => m.type === "cyborg:archive_agent_response")).toBeUndefined();
    // The rejected attempt must NOT have cleared the binding.
    expect(sqlite.getAgentBinding("dm-owner")).toBeDefined();
  });

  it("allows the INITIATOR (a non-admin member) to archive their own private session", async () => {
    bindSession("dm-member", member.user.id, null);
    const out = await dispatch(
      { type: "cyborg:archive_agent", requestId: "ar2", workspaceId, agentId: "dm-member" },
      member,
    );
    expect(out.find((m) => m.type === "cyborg:archive_agent_response")).toBeDefined();
    expect(out.find((m) => m.type === "cyborg:error")).toBeUndefined();
    expect(sqlite.getAgentBinding("dm-member")).toBeUndefined();
  });

  it("allows a workspace OWNER/ADMIN to archive ANOTHER user's private session (clear clutter)", async () => {
    bindSession("dm-by-member", member.user.id, null);
    const out = await dispatch(
      { type: "cyborg:archive_agent", requestId: "ar3", workspaceId, agentId: "dm-by-member" },
      owner,
    );
    expect(out.find((m) => m.type === "cyborg:archive_agent_response")).toBeDefined();
    expect(out.find((m) => m.type === "cyborg:error")).toBeUndefined();
    expect(sqlite.getAgentBinding("dm-by-member")).toBeUndefined();
  });

  it("allows any member to archive a SHARED (non-ephemeral channel) agent", async () => {
    bindSession("chan-agent", owner.user.id, "chan-1");
    const out = await dispatch(
      { type: "cyborg:archive_agent", requestId: "ar4", workspaceId, agentId: "chan-agent" },
      member,
    );
    expect(out.find((m) => m.type === "cyborg:archive_agent_response")).toBeDefined();
    expect(out.find((m) => m.type === "cyborg:error")).toBeUndefined();
  });

  it("a LIVE agent with a NULL binding does NOT bypass the guard — a non-admin member is rejected", async () => {
    // The review's null-binding bypass: agent live, no binding row, private (no
    // channel) → only an owner/admin or the initiator may archive. A random member
    // (not initiator — unknowable here — and not admin) must be REJECTED.
    liveOrphan("orphan-dm", null);
    const out = await dispatch(
      { type: "cyborg:archive_agent", requestId: "ar5", workspaceId, agentId: "orphan-dm" },
      member,
    );
    const err = out.find((m) => m.type === "cyborg:error");
    expect(err?.payload.code).toBe("forbidden");
    expect(out.find((m) => m.type === "cyborg:archive_agent_response")).toBeUndefined();
  });

  it("a LIVE agent with a NULL binding is still archivable by a workspace OWNER/ADMIN", async () => {
    liveOrphan("orphan-dm-2", null);
    const out = await dispatch(
      { type: "cyborg:archive_agent", requestId: "ar6", workspaceId, agentId: "orphan-dm-2" },
      owner,
    );
    expect(out.find((m) => m.type === "cyborg:archive_agent_response")).toBeDefined();
    expect(out.find((m) => m.type === "cyborg:error")).toBeUndefined();
  });
});
