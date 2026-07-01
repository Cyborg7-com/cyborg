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

// Problem (3): ephemeral mention-session ownership + PRIVACY (2026-06-30). When a
// user @mentions a cybo in a channel, the daemon spawns an EPHEMERAL, channel-bound
// agent session. Those sessions are OWNER-SCOPED in the list — visible ONLY by the
// user who triggered them. As of the 2026-06-30 privacy fix EVERY channel-bound
// session (ephemeral OR non-ephemeral/interactive) is owner-scoped in the LIST: a
// member no longer sees another member's channel cybo sessions.

interface Emitted {
  type: string;
  payload: Record<string, unknown>;
}

describe("ephemeral mention-session ownership (problem 3)", () => {
  let storage: DualStorage;
  let sqlite: CyborgStorage;
  let auth: CyborgAuth;
  let dispatcher: CyborgDispatcher;
  let workspaceManager: WorkspaceManager;
  let tmpDir: string;
  let mentioner: CyborgAuthContext;
  let bystander: CyborgAuthContext;
  let workspaceId: string;

  async function dispatch(
    msg: Record<string, unknown>,
    who: CyborgAuthContext,
  ): Promise<Emitted[]> {
    const out: Emitted[] = [];
    await dispatcher.dispatch(msg as never, who, (m) => out.push(m as Emitted));
    return out;
  }

  function listAgentIds(out: Emitted[]): string[] {
    const resp = out.find((m) => m.type === "cyborg:list_agents_response");
    const agents = (resp?.payload.agents as Array<Record<string, unknown>>) ?? [];
    return agents.map((a) => a.agentId as string);
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-eph-own-"));
    sqlite = new CyborgStorage(path.join(tmpDir, "test.db"));
    storage = new DualStorage(sqlite);
    auth = new CyborgAuth(storage);
    workspaceManager = new WorkspaceManager(storage);
    const broadcast: BroadcastFn = { toWorkspace() {}, toUser() {} };
    const messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
    dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);
    dispatcher.setServerId("daemon-D");

    mentioner = auth.validateToken(auth.createToken("mentioner@test.com", "Mentioner"))!;
    bystander = auth.validateToken(auth.createToken("bystander@test.com", "Bystander"))!;

    const ws = await dispatch(
      { type: "cyborg:create_workspace", name: "WS", requestId: "w1" },
      mentioner,
    );
    workspaceId = (ws[0].payload.workspace as { id: string }).id;
    // The bystander is a member of the same workspace (so they can list/prompt).
    sqlite.addMember(workspaceId, bystander.user.id, "member");
  });

  afterEach(() => {
    // Close the SQLite handle BEFORE removing the temp dir so a held file lock
    // can't fail the rmSync (EBUSY on Windows). finally guarantees cleanup even
    // if close throws.
    try {
      sqlite.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function spawnMentionSession(): string {
    // The shape spawnCybo writes for a mention/slash summon: ephemeral + channel-bound.
    const agentId = "mention-eph-1";
    sqlite.createAgentBinding({
      agentId,
      workspaceId,
      provider: "claude",
      cyboId: null,
      initiatedBy: mentioner.user.id,
      ephemeral: true,
      daemonId: "daemon-D",
      channelId: "chan-1",
    });
    return agentId;
  }

  it("a mention session appears in the mentioner's list_agents", async () => {
    const agentId = spawnMentionSession();
    const out = await dispatch(
      { type: "cyborg:list_agents", requestId: "l1", workspaceId },
      mentioner,
    );
    expect(listAgentIds(out)).toContain(agentId);
  });

  it("a mention session does NOT leak into another member's list_agents", async () => {
    spawnMentionSession();
    const out = await dispatch(
      { type: "cyborg:list_agents", requestId: "l2", workspaceId },
      bystander,
    );
    expect(listAgentIds(out)).toEqual([]);
  });

  it("a NON-ephemeral channel cybo session is OWNER-SCOPED — a bystander does NOT see it (privacy)", async () => {
    // PRIVACY (2026-06-30): the shared-channel short-circuit was removed. A
    // channel-bound cybo session is now private to its initiator — a member no
    // longer sees another member's channel cybo session in the list. (The cybo still
    // POSTS to its channel; only the session-LIST visibility is scoped.)
    sqlite.createAgentBinding({
      agentId: "chan-1-session",
      workspaceId,
      provider: "claude",
      cyboId: null,
      initiatedBy: mentioner.user.id,
      ephemeral: false,
      daemonId: "daemon-D",
      channelId: "chan-1",
    });
    // The initiator sees their own channel session…
    const forOwner = await dispatch(
      { type: "cyborg:list_agents", requestId: "l3a", workspaceId },
      mentioner,
    );
    expect(listAgentIds(forOwner)).toContain("chan-1-session");
    // …but a bystander in the same workspace does NOT.
    const forBystander = await dispatch(
      { type: "cyborg:list_agents", requestId: "l3b", workspaceId },
      bystander,
    );
    expect(listAgentIds(forBystander)).toEqual([]);
  });

  it("a non-initiator cannot prompt another user's mention session", async () => {
    const agentId = spawnMentionSession();
    const out = await dispatch(
      {
        type: "cyborg:send_agent_prompt",
        requestId: "p1",
        workspaceId,
        agentId,
        prompt: "hijack",
      },
      bystander,
    );
    const err = out.find((m) => m.type === "cyborg:error");
    expect(err?.payload.code).toBe("forbidden");
    expect(err?.payload.message).toBe("This is a private agent session");
  });
});
