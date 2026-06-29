import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { ScheduledMessageRunner, scheduledMessageView } from "./scheduled-message-runner.js";
import type { MessageRouter, BroadcastFn } from "./message-router.js";

// Runner unit tests for the daemon-side "send later" fire path (#607). A solo
// DualStorage (SQLite only, pg = null) drives the REAL claim/permission logic; the
// MessageRouter + broadcast are fakes that only capture calls. We assert the
// runner: fires a due+authorized row through the normal message path and stamps it
// processed; leaves a future row untouched; on a re-validation failure stamps the
// row with its closed-set error_code, does NOT send, and broadcasts the failure to
// the author (never silently dropped). Every tick is driven with an explicit `now`
// so there is no timing flake.

// A logger stub typed as Logger (no `any`): the runner only calls warn/info, and
// the pino Logger return type is itself, so the stub returns `this`.
function makeLogger(): Logger {
  const logger = {
    warn() {
      return logger;
    },
    info() {
      return logger;
    },
  };
  return logger as unknown as Logger;
}

interface ChannelCall {
  workspaceId: string;
  channelId: string;
  text: string;
  mentions?: string[];
  fromId: string;
}
interface DmCall {
  workspaceId: string;
  toId: string;
  text: string;
  fromId: string;
}
interface BroadcastCall {
  userId: string;
  message: { type: string; payload: ReturnType<typeof scheduledMessageView> };
}

interface Harness {
  runner: ScheduledMessageRunner;
  storage: DualStorage;
  channelCalls: ChannelCall[];
  dmCalls: DmCall[];
  toUserCalls: BroadcastCall[];
  workspaceId: string;
  channelId: string;
  fromId: string;
}

const PERMS_OK = true;

// Build a runner over a fresh in-memory solo DualStorage seeded with a workspace,
// an authorized member author, and a channel. Returns capture arrays for the fakes.
function makeHarness(): Harness {
  const sqlite = new CyborgStorage(":memory:");
  const storage = new DualStorage(sqlite, null);
  const workspaceManager = new WorkspaceManager(storage);

  // Seed: an owner user → a workspace (owner gets owner membership + a general
  // channel), then a dedicated channel + the author with member role (member can
  // send_message). All real rows so checkPermission/getChannel read the truth.
  const owner = sqlite.upsertUser("owner@smt.dev", "Owner");
  const ws = sqlite.createWorkspace("SMT WS", owner.id);
  const author = sqlite.upsertUser("author@smt.dev", "Author");
  sqlite.addMember(ws.id, author.id, "member");
  const channel = sqlite.createChannel(ws.id, "later", author.id);

  const channelCalls: ChannelCall[] = [];
  const dmCalls: DmCall[] = [];
  const toUserCalls: BroadcastCall[] = [];

  const messageRouter = {
    handleChannelMessage(
      auth: { user: { id: string } },
      msg: { workspaceId: string; channelId: string; text: string; mentions?: string[] },
    ) {
      channelCalls.push({
        workspaceId: msg.workspaceId,
        channelId: msg.channelId,
        text: msg.text,
        mentions: msg.mentions,
        fromId: auth.user.id,
      });
    },
    handleDm(
      auth: { user: { id: string } },
      msg: { workspaceId: string; toId: string; text: string },
    ) {
      dmCalls.push({
        workspaceId: msg.workspaceId,
        toId: msg.toId,
        text: msg.text,
        fromId: auth.user.id,
      });
    },
  } as unknown as MessageRouter;

  const broadcast: BroadcastFn = {
    toWorkspace() {
      /* unused by the runner */
    },
    toUser(userId: string, message: unknown) {
      toUserCalls.push({ userId, message: message as BroadcastCall["message"] });
    },
  };

  const runner = new ScheduledMessageRunner({
    storage,
    workspaceManager,
    messageRouter,
    broadcast,
    logger: makeLogger(),
  });

  return {
    runner,
    storage,
    channelCalls,
    dmCalls,
    toUserCalls,
    workspaceId: ws.id,
    channelId: channel.id,
    fromId: author.id,
  };
}

describe("ScheduledMessageRunner.tick — fire path (#607)", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(async () => {
    await h.storage.close();
  });

  it("fires a past-due authorized channel message and stamps it processed (sent, not dropped)", async () => {
    const NOW = 10_000;
    const row = h.storage.createScheduledMessage({
      workspaceId: h.workspaceId,
      fromId: h.fromId,
      text: "scheduled hello",
      sendAt: NOW - 1_000,
      channelId: h.channelId,
      mentions: ["user_x"],
    });

    await h.runner.tick(NOW);

    // Sent exactly once through the normal channel path, with the right payload.
    expect(h.channelCalls).toHaveLength(1);
    expect(h.channelCalls[0]).toMatchObject({
      workspaceId: h.workspaceId,
      channelId: h.channelId,
      text: "scheduled hello",
      mentions: ["user_x"],
      fromId: h.fromId,
    });
    expect(h.dmCalls).toHaveLength(0);

    // The row is claimed (processed_at set) with NO error — a clean success.
    const after = h.storage.getScheduledMessage(row.id)!;
    expect(after.processed_at).toBe(NOW);
    expect(after.error_code).toBeNull();
    // A successful send is not broadcast as a failure.
    expect(h.toUserCalls).toHaveLength(0);
    expect(PERMS_OK).toBe(true);
  });

  it("does NOT fire a future message and leaves it pending", async () => {
    const NOW = 10_000;
    const row = h.storage.createScheduledMessage({
      workspaceId: h.workspaceId,
      fromId: h.fromId,
      text: "not yet",
      sendAt: NOW + 5_000,
      channelId: h.channelId,
    });

    await h.runner.tick(NOW);

    expect(h.channelCalls).toHaveLength(0);
    expect(h.storage.getScheduledMessage(row.id)!.processed_at).toBeNull();
  });

  it("a deauthorized author: stamps no_permission, does NOT send, broadcasts the failure", async () => {
    const NOW = 10_000;
    const row = h.storage.createScheduledMessage({
      workspaceId: h.workspaceId,
      fromId: h.fromId,
      text: "should fail",
      sendAt: NOW - 1_000,
      channelId: h.channelId,
    });
    // The author lost workspace access between scheduling and firing.
    h.storage.sqlite.deleteMembership(h.workspaceId, h.fromId);

    await h.runner.tick(NOW);

    // Not sent …
    expect(h.channelCalls).toHaveLength(0);
    // … the row is processed WITH the closed-set reason (failed, not dropped) …
    const after = h.storage.getScheduledMessage(row.id)!;
    expect(after.processed_at).toBe(NOW);
    expect(after.error_code).toBe("no_permission");
    // … and the failure was surfaced to the author.
    expect(h.toUserCalls).toHaveLength(1);
    expect(h.toUserCalls[0].userId).toBe(h.fromId);
    expect(h.toUserCalls[0].message.type).toBe("cyborg:schedule_message_failed");
    expect(h.toUserCalls[0].message.payload.id).toBe(row.id);
    expect(h.toUserCalls[0].message.payload.errorCode).toBe("no_permission");
  });

  it("a deleted channel: stamps channel_not_found, does NOT send, broadcasts the failure", async () => {
    const NOW = 10_000;
    // channelId points to a channel that does not exist (deleted between schedule
    // and fire). getChannel → undefined → channel_not_found.
    const row = h.storage.createScheduledMessage({
      workspaceId: h.workspaceId,
      fromId: h.fromId,
      text: "ghost channel",
      sendAt: NOW - 1_000,
      channelId: "ch_does_not_exist",
    });

    await h.runner.tick(NOW);

    expect(h.channelCalls).toHaveLength(0);
    const after = h.storage.getScheduledMessage(row.id)!;
    expect(after.processed_at).toBe(NOW);
    expect(after.error_code).toBe("channel_not_found");
    expect(h.toUserCalls).toHaveLength(1);
    expect(h.toUserCalls[0].message.payload.errorCode).toBe("channel_not_found");
  });

  it("idempotent across ticks: a row already claimed is not fired again", async () => {
    const NOW = 10_000;
    const row = h.storage.createScheduledMessage({
      workspaceId: h.workspaceId,
      fromId: h.fromId,
      text: "once only",
      sendAt: NOW - 1_000,
      channelId: h.channelId,
    });

    await h.runner.tick(NOW);
    await h.runner.tick(NOW + 1); // a second pass must find nothing due

    expect(h.channelCalls).toHaveLength(1);
    expect(h.storage.getScheduledMessage(row.id)!.processed_at).toBe(NOW);
  });
});

describe("ScheduledMessageRunner.tick — connected daemon no-ops (#607)", () => {
  it("does NOT fire when storage.pg is truthy (the cloud relay owns firing)", async () => {
    // Build the solo harness, seed a due row, then simulate a PG connection by
    // overriding storage.pg → truthy. The runner must skip firing entirely so a
    // connected daemon + the relay don't double-send the same row.
    const h = makeHarness();
    const NOW = 10_000;
    const row = h.storage.createScheduledMessage({
      workspaceId: h.workspaceId,
      fromId: h.fromId,
      text: "relay owns this",
      sendAt: NOW - 1_000,
      channelId: h.channelId,
    });

    // DualStorage.pg is a getter over a private field; define it as truthy for this
    // instance to exercise the connected branch without a real PgSync.
    Object.defineProperty(h.storage, "pg", { configurable: true, get: () => ({}) });
    expect(h.storage.pg).toBeTruthy();

    await h.runner.tick(NOW);

    // No-op: nothing sent, the row stays pending for the relay to fire from PG.
    expect(h.channelCalls).toHaveLength(0);
    expect(h.toUserCalls).toHaveLength(0);
    expect(h.storage.getScheduledMessage(row.id)!.processed_at).toBeNull();

    await h.storage.close();
  });
});

describe("scheduledMessageView (#607)", () => {
  it("maps a stored row to the wire view, parsing mentions", () => {
    const view = scheduledMessageView({
      id: "schedmsg_1",
      workspace_id: "ws_1",
      channel_id: "ch_1",
      to_id: null,
      from_id: "user_1",
      text: "hi",
      mentions: JSON.stringify(["user_a"]),
      send_at: 111,
      processed_at: 222,
      error_code: "no_permission",
      created_at: 100,
    });
    expect(view).toEqual({
      id: "schedmsg_1",
      workspaceId: "ws_1",
      channelId: "ch_1",
      toId: null,
      fromId: "user_1",
      text: "hi",
      mentions: ["user_a"],
      sendAt: 111,
      processedAt: 222,
      errorCode: "no_permission",
      createdAt: 100,
    });
  });

  it("maps a null mentions column to a null mentions array", () => {
    const view = scheduledMessageView({
      id: "schedmsg_2",
      workspace_id: "ws_1",
      channel_id: null,
      to_id: "user_2",
      from_id: "user_1",
      text: "dm",
      mentions: null,
      send_at: 1,
      processed_at: null,
      error_code: null,
      created_at: 0,
    });
    expect(view.mentions).toBeNull();
    expect(view.toId).toBe("user_2");
    expect(view.channelId).toBeNull();
  });
});
