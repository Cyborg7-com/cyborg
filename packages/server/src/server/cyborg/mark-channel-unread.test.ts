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

// Mark-unread-from-post for channels (N4): the channel analogue of
// mark_thread_unread. Rewinds message_reads.last_read_at to beforeAt - 1ms so
// the chosen post (and everything after it) counts as unread again.

interface Emitted {
  type: string;
  payload: Record<string, unknown>;
}

describe("mark_channel_unread (dispatcher, local mode)", () => {
  let storage: DualStorage;
  let auth: CyborgAuth;
  let dispatcher: CyborgDispatcher;
  let broadcasts: Emitted[];
  let tmpDir: string;
  let owner: CyborgAuthContext;
  let workspaceId: string;
  let channelId: string;

  async function dispatch(msg: Record<string, unknown>, who = owner): Promise<Emitted[]> {
    const out: Emitted[] = [];
    await dispatcher.dispatch(msg as never, who, (m) => out.push(m as Emitted));
    return out;
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-unread-"));
    storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "test.db")), null);
    auth = new CyborgAuth(storage);
    const workspaceManager = new WorkspaceManager(storage);
    broadcasts = [];
    const broadcast: BroadcastFn = {
      toWorkspace() {},
      toUser(_userId, msg) {
        broadcasts.push(msg as Emitted);
      },
    };
    const messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
    dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);

    owner = auth.validateToken(auth.createToken("owner@test.com", "Owner"))!;
    const ws = await dispatch({ type: "cyborg:create_workspace", name: "WS", requestId: "w1" });
    workspaceId = (ws[0].payload.workspace as { id: string }).id;
    const ch = await dispatch({
      type: "cyborg:create_channel",
      workspaceId,
      name: "general",
      requestId: "c1",
    });
    channelId = (ch[0].payload.channel as { id: string }).id;
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rewinds last_read_at to the post's created_at - 1ms", async () => {
    // The channel is read up to "now".
    await dispatch({ type: "cyborg:mark_read", workspaceId, channelId, lastReadAt: 10_000 });
    expect(storage.getLastRead(owner.user.id, channelId)).toBe(10_000);

    // Mark unread from a post created at t=5000 → last_read_at rewinds to 4999.
    const res = await dispatch({
      type: "cyborg:mark_channel_unread",
      workspaceId,
      channelId,
      beforeAt: 5_000,
      requestId: "u1",
    });
    expect(res[0].type).toBe("cyborg:mark_channel_unread_response");
    expect(res[0].payload.lastReadAt).toBe(4_999);
    expect(storage.getLastRead(owner.user.id, channelId)).toBe(4_999);
  });

  it("broadcasts the rewound read state to the user's other sockets (read_broadcast)", async () => {
    await dispatch({
      type: "cyborg:mark_channel_unread",
      workspaceId,
      channelId,
      beforeAt: 8_000,
      requestId: "u2",
    });
    const rb = broadcasts.find((b) => b.type === "cyborg:read_broadcast");
    expect(rb).toBeDefined();
    expect(rb?.payload).toMatchObject({ workspaceId, channelId, lastReadAt: 7_999 });
  });

  it("works from a clean state (no prior read row) — creates the rewound read", async () => {
    expect(storage.getLastRead(owner.user.id, channelId)).toBeNull();
    await dispatch({
      type: "cyborg:mark_channel_unread",
      workspaceId,
      channelId,
      beforeAt: 3_000,
      requestId: "u3",
    });
    expect(storage.getLastRead(owner.user.id, channelId)).toBe(2_999);
  });

  it("a non-member's mark-unread doesn't touch the channel's read row", async () => {
    await dispatch({ type: "cyborg:mark_read", workspaceId, channelId, lastReadAt: 10_000 });
    const stranger = auth.validateToken(auth.createToken("stranger@test.com", "Stranger"))!;
    await dispatch(
      {
        type: "cyborg:mark_channel_unread",
        workspaceId,
        channelId,
        beforeAt: 5_000,
        requestId: "u4",
      },
      stranger,
    );
    // The owner's read row is untouched; the stranger has none.
    expect(storage.getLastRead(owner.user.id, channelId)).toBe(10_000);
    expect(storage.getLastRead(stranger.user.id, channelId)).toBeNull();
  });
});
