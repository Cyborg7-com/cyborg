/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { CyborgAuth } from "./auth.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MessageRouter, type BroadcastFn } from "./message-router.js";
import { CyborgDispatcher } from "./dispatcher.js";

// #242: slash commands must not read/act in a PRIVATE channel the caller isn't a
// member of. The dispatcher's gate runs on the PG-connected path, so we stub
// storage.pg.getChannelMemberRole to simulate (non-)membership.
describe("slash command private-channel membership gate (#242)", () => {
  let storage: DualStorage;
  let auth: CyborgAuth;
  let workspaceManager: WorkspaceManager;
  let dispatcher: CyborgDispatcher;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-slashpriv-"));
    storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "test.db")), null);
    auth = new CyborgAuth(storage);
    workspaceManager = new WorkspaceManager(storage);
    const broadcast: BroadcastFn = { toWorkspace() {}, toUser() {} };
    const messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
    dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);
  });

  afterEach(() => {
    storage.close();
    const dbPath = path.join(tmpDir, "test.db");
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(f)) unlinkSync(f);
  });

  function ctx(email: string, name: string) {
    return auth.validateToken(auth.createToken(email, name))!;
  }

  async function dispatch(msg: Record<string, unknown>, authCtx: ReturnType<typeof ctx>) {
    const emitted: unknown[] = [];
    await dispatcher.dispatch(msg as any, authCtx, (m) => emitted.push(m));
    return emitted;
  }

  async function makeChannel(isPrivate: boolean): Promise<{
    workspaceId: string;
    channelId: string;
    owner: ReturnType<typeof ctx>;
  }> {
    const owner = ctx("owner@test.com", "Owner");
    const ws = await dispatch(
      { type: "cyborg:create_workspace", name: "WS", requestId: "ws" },
      owner,
    );
    const workspaceId = (ws[0] as any).payload.workspace.id;
    const ch = await dispatch(
      { type: "cyborg:create_channel", workspaceId, name: "secret", isPrivate, requestId: "cc" },
      owner,
    );
    const channelId = (ch[0] as any).payload.channel.id;
    return { workspaceId, channelId, owner };
  }

  it("blocks a non-member from running a slash command in a PRIVATE channel", async () => {
    const { workspaceId, channelId, owner } = await makeChannel(true);
    // Connected daemon (PG present) where the caller is NOT a channel member.
    (storage as any)._pg = { getChannelMemberRole: async () => null, close: () => {} };

    const out = await dispatch(
      {
        type: "cyborg:slash_command",
        workspaceId,
        channelId,
        trigger: "summarize",
        requestId: "s",
      },
      owner,
    );
    const ack = (out[0] as any).payload;
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/private channel/i);
  });

  it("allows a member of the PRIVATE channel past the membership gate", async () => {
    const { workspaceId, channelId, owner } = await makeChannel(true);
    // Caller IS a channel member → gate passes; it fails later for an unrelated
    // reason (no AgentManager in this harness), NOT the membership block.
    (storage as any)._pg = { getChannelMemberRole: async () => "member", close: () => {} };

    const out = await dispatch(
      {
        type: "cyborg:slash_command",
        workspaceId,
        channelId,
        trigger: "summarize",
        requestId: "s",
      },
      owner,
    );
    const ack = (out[0] as any).payload;
    expect(ack.ok).toBe(false);
    expect(ack.error).not.toMatch(/private channel/i);
  });

  it("does not gate a PUBLIC channel (no membership required)", async () => {
    const { workspaceId, channelId, owner } = await makeChannel(false);
    (storage as any)._pg = { getChannelMemberRole: async () => null, close: () => {} };

    const out = await dispatch(
      {
        type: "cyborg:slash_command",
        workspaceId,
        channelId,
        trigger: "summarize",
        requestId: "s",
      },
      owner,
    );
    const ack = (out[0] as any).payload;
    expect(ack.ok).toBe(false);
    expect(ack.error).not.toMatch(/private channel/i);
  });
});
