/* eslint-disable @typescript-eslint/no-explicit-any */
// Launch-critical: a DM turn to a cybo must reply ONLY in the DM, never echo to a
// channel. A scheduled cybo's session is non-ephemeral and channel-bound (its
// system prompt still says "Current channel: general"), so when a user DMs it the
// reused session would call cyborg7_send_message({channel}) and leak the private
// reply. handleAgentMessage is the single chokepoint for durable channel posts; the
// hard guard there redirects a channel post to the DM recipient while a DM turn is
// in flight. This proves the redirect AND that a normal channel post still works.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { CyborgAuth } from "./auth.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MessageRouter, type BroadcastFn } from "./message-router.js";

describe("message-router: DM turn cannot post to a channel", () => {
  let tmpDir: string;
  let storage: DualStorage;
  let auth: CyborgAuth;
  let workspaceManager: WorkspaceManager;
  let messageRouter: MessageRouter;
  let broadcasts: Array<{ type: string; payload: any }>;
  let workspaceId: string;
  let channelId: string;
  let owner: NonNullable<ReturnType<CyborgAuth["validateToken"]>>;
  const agentId = "agent-sched";

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "dm-channel-guard-"));
    storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "test.db")), null);
    auth = new CyborgAuth(storage);
    workspaceManager = new WorkspaceManager(storage);
    broadcasts = [];
    const broadcast: BroadcastFn = {
      toWorkspace(_id, msg) {
        broadcasts.push(msg as any);
      },
      toUser(_id, msg) {
        broadcasts.push(msg as any);
      },
    };
    messageRouter = new MessageRouter(storage, workspaceManager, broadcast);

    owner = auth.validateToken(auth.createToken("alice@test.com", "Alice"))!;
    workspaceId = workspaceManager.createWorkspace("Guard WS", owner.user.id).id;
    channelId = storage.getChannels(workspaceId).find((c) => c.name === "general")!.id;

    // A scheduled, channel-bound, NON-ephemeral cybo session — the bug's setup.
    storage.createAgentBinding({
      agentId,
      workspaceId,
      channelId,
      provider: "pi",
    });
  });

  afterEach(() => {
    // Close the DB before deleting its files (try/finally so a close error can't
    // leak the temp dir, and the dir is removed even if a file unlink throws).
    try {
      storage.close();
    } finally {
      try {
        const dbPath = path.join(tmpDir, "test.db");
        for (const suffix of ["", "-wal", "-shm"]) {
          if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  const broadcastTypes = () => broadcasts.map((b) => b.type);

  it("a DM turn's send_message(channel) is redirected to the DM, never the channel", async () => {
    // Simulate the turn: handleDm sets the DM scope, then the cybo (via the MCP
    // tool) tries to post to its bound channel — exactly the leak path.
    (messageRouter as any).routeToAgent = async (id: string) => {
      messageRouter.handleAgentMessage(id, workspaceId, channelId, null, "secret DM reply");
    };

    messageRouter.handleDm(owner, {
      type: "cyborg:dm",
      workspaceId,
      toId: agentId,
      text: "hey, privately",
    });
    // routeToAgent is fire-and-forget inside handleDm; let its microtasks settle.
    await new Promise((r) => setImmediate(r));

    // No channel post leaked.
    expect(broadcastTypes()).not.toContain("cyborg:channel_message_broadcast");
    // The reply went to the human as a DM instead.
    const dm = broadcasts.find(
      (b) => b.type === "cyborg:dm_broadcast" && b.payload.text === "secret DM reply",
    );
    expect(dm).toBeDefined();
    expect(dm!.payload.toId).toBe(owner.user.id);
    // Scope is turn-scoped: a channel post AFTER the turn ends posts normally again.
    messageRouter.handleAgentMessage(agentId, workspaceId, channelId, null, "scheduled report");
    expect(broadcastTypes()).toContain("cyborg:channel_message_broadcast");
  });

  it("a DM turn's agent_stream is steered to the DM (channelId:null + recipient email)", async () => {
    // The relay persists a cybo's streamed reply, routing by the stream payload's
    // channelId/privateToEmail. A channel-bound cybo answering a DM must emit
    // channelId:null + the recipient's email so the relay flushes a DM, not a
    // channel post. Drive the real emitAgentStream from inside the DM scope.
    (messageRouter as any).routeToAgent = async (id: string) => {
      (messageRouter as any).emitAgentStream(id, storage.getAgentBinding(id), {
        type: "timeline",
        item: { type: "assistant_message", text: "private", messageId: "m1" },
      });
    };

    messageRouter.handleDm(owner, {
      type: "cyborg:dm",
      workspaceId,
      toId: agentId,
      text: "hey, privately",
    });
    await new Promise((r) => setImmediate(r));

    const stream = broadcasts.find((b) => b.type === "cyborg:agent_stream");
    expect(stream).toBeDefined();
    // channelId nulled so broadcastAgentReply takes the privateToEmail (DM) path...
    expect(stream!.payload.channelId).toBeNull();
    // ...addressed to the DM recipient's email.
    expect(stream!.payload.privateToEmail).toBe(owner.user.email);
  });

  it("a normal channel turn's send_message(channel) still posts to the channel", () => {
    // No DM scope active (an @-mention / scheduled-to-channel turn).
    messageRouter.handleAgentMessage(agentId, workspaceId, channelId, null, "daily standup");

    const post = broadcasts.find((b) => b.type === "cyborg:channel_message_broadcast");
    expect(post).toBeDefined();
    expect(post!.payload.text).toBe("daily standup");
    expect(post!.payload.channelId).toBe(channelId);
    expect(broadcastTypes()).not.toContain("cyborg:dm_broadcast");
  });
});
