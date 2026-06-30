import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

// DATA-LOSS regression (resume must not delete history).
//
// Before the fix, resuming an archived session hard-deleted its archived_sessions
// row. If the resumed live session then died (or was never explicitly re-archived)
// the session was lost permanently — it vanished from history with no way back.
//
// The fix keeps the archived row and links it to the live agent via
// resumed_agent_id: while that agent's binding exists the row is hidden from
// history (the session is reachable via the active list), and re-archiving REVIVES
// the same row (no duplicate). If the binding is gone the row reappears in history.
//
// Invariant proven here: a resumed session is ALWAYS reachable — either active
// (binding present) or in history — and is never deleted on resume.

describe("CyborgStorage archived-session resume (data-loss fix)", () => {
  let storage: CyborgStorage;

  beforeEach(() => {
    storage = new CyborgStorage(":memory:");
    storage.upsertUser("owner@test.com", "Owner");
  });

  afterEach(() => {
    storage.close();
  });

  function makeWorkspace(): string {
    const owner = storage.getUserByEmail("owner@test.com");
    if (!owner) throw new Error("no owner");
    return storage.createWorkspace("Resume WS", owner.id).id;
  }

  it("resume marks the archived row instead of deleting it (row preserved + recoverable)", () => {
    const ws = makeWorkspace();
    const archived = storage.archiveSession({
      workspaceId: ws,
      provider: "claude",
      providerHandleId: "handle-1",
      title: "Old chat",
      cwd: "/repo",
      model: "sonnet",
    });
    expect(archived.resumed_agent_id).toBeNull();

    // Simulate the resume handler's net storage effect.
    storage.markArchivedSessionResumed(archived.id, "agent-live-1");

    // The row is NOT gone — it is preserved and recoverable by id.
    const still = storage.getArchivedSession(archived.id, ws);
    expect(still).toBeDefined();
    expect(still!.resumed_agent_id).toBe("agent-live-1");
    // It is still in the raw archive table (not deleted).
    expect(storage.getArchivedSessions(ws).map((r) => r.id)).toContain(archived.id);
    // And it is reverse-resolvable from the live agent.
    expect(storage.getArchivedSessionByResumedAgent("agent-live-1")?.id).toBe(archived.id);
  });

  it("re-archiving a resumed session revives the SAME row (no duplicate)", () => {
    const ws = makeWorkspace();
    const archived = storage.archiveSession({
      workspaceId: ws,
      provider: "claude",
      providerHandleId: "handle-1",
      title: "Old chat",
      cwd: "/repo",
      model: "sonnet",
    });
    storage.markArchivedSessionResumed(archived.id, "agent-live-1");

    const revived = storage.reviveArchivedSession({
      id: archived.id,
      providerHandleId: "handle-1b",
      title: "Resumed chat",
      cwd: "/repo",
      model: "opus",
    });

    expect(revived).toBeDefined();
    expect(revived!.id).toBe(archived.id); // SAME row id
    expect(revived!.resumed_agent_id).toBeNull(); // back in history
    expect(revived!.title).toBe("Resumed chat"); // refreshed metadata
    expect(revived!.model).toBe("opus");
    // Exactly one row remains — no duplicate session created.
    expect(storage.getArchivedSessions(ws).length).toBe(1);
  });
});

interface Emitted {
  type: string;
  payload: Record<string, unknown>;
}

interface ArchivedListRow {
  id: string;
  title: string | null;
}

describe("cyborg:resume archived session lifecycle (dispatcher)", () => {
  let storage: DualStorage;
  let auth: CyborgAuth;
  let dispatcher: CyborgDispatcher;
  let tmpDir: string;
  let owner: CyborgAuthContext;
  let workspaceId: string;

  async function dispatch(msg: Record<string, unknown>): Promise<Emitted[]> {
    const out: Emitted[] = [];
    await dispatcher.dispatch(msg as never, owner, (m) => out.push(m as Emitted));
    return out;
  }

  async function listArchived(): Promise<ArchivedListRow[]> {
    const out = await dispatch({
      type: "cyborg:list_archived_sessions",
      requestId: `list-${Math.random()}`,
      workspaceId,
    });
    const resp = out.find((m) => m.type === "cyborg:list_archived_sessions_response");
    return (resp?.payload.sessions as ArchivedListRow[]) ?? [];
  }

  // Net storage effect of handleRestoreSession: link the archived row to the new
  // live agent + create its active binding. (The provider-level resume is Paseo's
  // and covered by its own tests; here we prove the cyborg history bookkeeping.)
  function simulateResume(archivedSessionId: string, agentId: string): void {
    storage.markArchivedSessionResumed(archivedSessionId, agentId);
    storage.createAgentBinding({
      agentId,
      workspaceId,
      provider: "claude",
      model: "sonnet",
      initiatedBy: owner.user.id,
    });
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-resume-"));
    storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "test.db")), null);
    auth = new CyborgAuth(storage);
    const workspaceManager = new WorkspaceManager(storage);
    const broadcast: BroadcastFn = { toWorkspace() {}, toUser() {} };
    const messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
    dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);

    // archiveAgent is best-effort; getAgent returns undefined so archive falls back
    // to the binding metadata (the realistic path for a dead/resumed session).
    dispatcher.setAgentManager({
      getAgent: () => undefined,
      archiveAgent: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentManager);

    owner = auth.validateToken(auth.createToken("owner@test.com", "Owner"))!;
    const ws = await dispatch({
      type: "cyborg:create_workspace",
      name: "Resume WS",
      requestId: "w1",
    });
    workspaceId = (ws[0].payload.workspace as { id: string }).id;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedArchived(title: string): string {
    return storage.archiveSession({
      workspaceId,
      provider: "claude",
      providerHandleId: `h-${title}`,
      title,
      cwd: "/repo",
      model: "sonnet",
    }).id;
  }

  it("resume hides the session from history (shown active) but never deletes it", async () => {
    const sid = seedArchived("Chat A");
    expect((await listArchived()).map((r) => r.id)).toContain(sid);

    simulateResume(sid, "agent-1");

    // Hidden from history (it is now in the active list via its binding) — not
    // duplicated, not gone.
    expect((await listArchived()).map((r) => r.id)).not.toContain(sid);
    // The underlying row is still present and recoverable.
    expect(storage.getArchivedSession(sid, workspaceId)).toBeDefined();
  });

  it("resume then end (re-archive) returns the session to history — not lost", async () => {
    const sid = seedArchived("Chat B");
    simulateResume(sid, "agent-1");
    expect((await listArchived()).map((r) => r.id)).not.toContain(sid);

    // The resumed session ends → user/UI archives it again.
    const out = await dispatch({
      type: "cyborg:archive_agent",
      requestId: "arch-1",
      workspaceId,
      agentId: "agent-1",
    });
    const resp = out.find((m) => m.type === "cyborg:archive_agent_response");
    expect(resp).toBeDefined();
    // Re-archive reuses the SAME archived session id (no duplicate).
    expect(resp!.payload.sessionId).toBe(sid);

    const history = await listArchived();
    expect(history.map((r) => r.id)).toContain(sid);
    // Exactly one history row for this session — no duplicate from resume.
    expect(history.filter((r) => r.id === sid).length).toBe(1);
  });

  it("resumed session that dies (binding removed) reappears in history — never lost", async () => {
    const sid = seedArchived("Chat C");
    simulateResume(sid, "agent-1");
    expect((await listArchived()).map((r) => r.id)).not.toContain(sid);

    // The resumed live session dies and its binding is gone (e.g. cleanup) WITHOUT
    // an explicit re-archive. The session must still be reachable in history.
    storage.deleteAgentBinding("agent-1");

    expect((await listArchived()).map((r) => r.id)).toContain(sid);
  });

  it("a resumed session is never listed in BOTH active and history at once", async () => {
    const sid = seedArchived("Chat D");
    simulateResume(sid, "agent-1");

    const inHistory = (await listArchived()).some((r) => r.id === sid);
    const hasLiveBinding = storage.getAgentBinding("agent-1") !== undefined;
    // While the binding exists it is active and NOT in history (no double listing).
    expect(hasLiveBinding).toBe(true);
    expect(inHistory).toBe(false);
  });
});
