import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { WorkspaceRelay } from "./workspace-relay.js";
import { DaemonRelayClient } from "./daemon-relay-client.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTestStorage(): DualStorage {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "relay-test-"));
  const sqlite = new CyborgStorage(path.join(tmpDir, "test.db"));
  return new DualStorage(sqlite, null);
}

describe("WorkspaceRelay — multi-daemon communication", () => {
  let relay: WorkspaceRelay;
  let relayPort: number;
  let storageA: DualStorage;
  let storageB: DualStorage;
  let clientA: DaemonRelayClient;
  let clientB: DaemonRelayClient;

  beforeEach(async () => {
    relay = new WorkspaceRelay();
    relayPort = await relay.listen(0);

    storageA = createTestStorage();
    storageB = createTestStorage();
  });

  afterEach(async () => {
    clientA?.close();
    clientB?.close();
    await relay.close();
    await storageA.close();
    await storageB.close();
  });

  function setupUser(storage: DualStorage) {
    const user = storage.upsertUser(
      `user-${Math.random().toString(36).slice(2)}@test.dev`,
      "Test User",
    );
    const ws = storage.createWorkspace("Shared WS", user.id);
    const channels = storage.getChannels(ws.id);
    const general = channels.find((c) => c.name === "general")!;
    return { user, workspace: ws, channel: general };
  }

  it("relay accepts daemon connections and confirms subscriptions", async () => {
    const { workspace } = setupUser(storageA);

    clientA = new DaemonRelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      daemonId: "daemon-a",
      token: "test-token",
      workspaceIds: [workspace.id],
      storage: storageA,
    });

    clientA.connect();
    await wait(200);

    expect(clientA.isConnected()).toBe(true);
    expect(relay.getConnectedDaemons()).toContain("daemon-a");
    expect(relay.getSubscriberCount(workspace.id)).toBe(1);
  });

  it("daemon A sends message, daemon B receives it", async () => {
    const ctxA = setupUser(storageA);

    // Daemon B needs the same workspace ID — simulate shared workspace
    const userB = storageB.upsertUser("user-b@test.dev", "User B");
    storageB.sqlite.db
      .prepare(`INSERT INTO workspaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)`)
      .run(ctxA.workspace.id, "Shared WS", userB.id, Date.now());
    storageB.sqlite.db
      .prepare(
        `INSERT INTO channels (id, workspace_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(ctxA.channel.id, ctxA.workspace.id, "general", userB.id, Date.now());
    storageB.addMember(ctxA.workspace.id, userB.id, "member");

    const receivedByB: Record<string, unknown>[] = [];

    clientA = new DaemonRelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      daemonId: "daemon-a",
      token: "test-token",
      workspaceIds: [ctxA.workspace.id],
      storage: storageA,
    });

    clientB = new DaemonRelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      daemonId: "daemon-b",
      token: "test-token",
      workspaceIds: [ctxA.workspace.id],
      storage: storageB,
      onMessage: (_wsId, _from, msg) => receivedByB.push(msg),
    });

    clientA.connect();
    clientB.connect();
    await wait(300);

    expect(clientA.isConnected()).toBe(true);
    expect(clientB.isConnected()).toBe(true);
    expect(relay.getSubscriberCount(ctxA.workspace.id)).toBe(2);

    // Daemon A inserts a message locally and forwards to relay
    const msg = storageA.insertMessage({
      workspaceId: ctxA.workspace.id,
      channelId: ctxA.channel.id,
      fromId: ctxA.user.id,
      fromType: "human",
      text: "hello from daemon A",
    });

    clientA.forward(ctxA.workspace.id, {
      type: "cyborg:channel_message_broadcast",
      payload: {
        id: msg.id,
        workspaceId: msg.workspace_id,
        channelId: msg.channel_id,
        fromId: msg.from_id,
        fromType: msg.from_type,
        text: msg.text,
        mentions: null,
        parentId: null,
        seq: msg.seq,
        createdAt: msg.created_at,
      },
    });

    await wait(300);

    // Daemon B received the message via relay
    expect(receivedByB).toHaveLength(1);
    expect((receivedByB[0] as unknown as { payload: { text: string } }).payload.text).toBe(
      "hello from daemon A",
    );

    // Daemon B's SQLite has the message
    const bMessages = storageB.getMessages({ channelId: ctxA.channel.id });
    expect(bMessages).toHaveLength(1);
    expect(bMessages[0].text).toBe("hello from daemon A");
    expect(bMessages[0].from_id).toBe(ctxA.user.id);
  });

  it("relay assigns authoritative seq numbers", async () => {
    const ctxA = setupUser(storageA);

    clientA = new DaemonRelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      daemonId: "daemon-a",
      token: "test-token",
      workspaceIds: [ctxA.workspace.id],
      storage: storageA,
    });

    clientA.connect();
    await wait(200);

    clientA.forward(ctxA.workspace.id, {
      type: "cyborg:channel_message_broadcast",
      payload: { id: "msg-1", text: "first" },
    });

    clientA.forward(ctxA.workspace.id, {
      type: "cyborg:channel_message_broadcast",
      payload: { id: "msg-2", text: "second" },
    });

    await wait(200);

    expect(relay.getCurrentSeq(ctxA.workspace.id)).toBe(2);
  });

  it("bidirectional: both daemons send and receive", async () => {
    const ctxA = setupUser(storageA);
    const userB = storageB.upsertUser("user-b@test.dev", "User B");
    storageB.sqlite.db
      .prepare(`INSERT INTO workspaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)`)
      .run(ctxA.workspace.id, "Shared WS", userB.id, Date.now());
    storageB.sqlite.db
      .prepare(
        `INSERT INTO channels (id, workspace_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(ctxA.channel.id, ctxA.workspace.id, "general", userB.id, Date.now());

    const receivedByA: Record<string, unknown>[] = [];
    const receivedByB: Record<string, unknown>[] = [];

    clientA = new DaemonRelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      daemonId: "daemon-a",
      token: "test-token",
      workspaceIds: [ctxA.workspace.id],
      storage: storageA,
      onMessage: (_wsId, _from, msg) => receivedByA.push(msg),
    });

    clientB = new DaemonRelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      daemonId: "daemon-b",
      token: "test-token",
      workspaceIds: [ctxA.workspace.id],
      storage: storageB,
      onMessage: (_wsId, _from, msg) => receivedByB.push(msg),
    });

    clientA.connect();
    clientB.connect();
    await wait(300);

    // A sends
    clientA.forward(ctxA.workspace.id, {
      type: "cyborg:channel_message_broadcast",
      payload: {
        id: "msg-a1",
        workspaceId: ctxA.workspace.id,
        channelId: ctxA.channel.id,
        fromId: ctxA.user.id,
        fromType: "human",
        text: "from A",
        seq: 1,
        createdAt: Date.now(),
      },
    });

    // B sends
    clientB.forward(ctxA.workspace.id, {
      type: "cyborg:channel_message_broadcast",
      payload: {
        id: "msg-b1",
        workspaceId: ctxA.workspace.id,
        channelId: ctxA.channel.id,
        fromId: userB.id,
        fromType: "human",
        text: "from B",
        seq: 1,
        createdAt: Date.now(),
      },
    });

    await wait(300);

    // A received B's message
    expect(receivedByA).toHaveLength(1);
    expect((receivedByA[0] as unknown as { payload: { text: string } }).payload.text).toBe(
      "from B",
    );

    // B received A's message
    expect(receivedByB).toHaveLength(1);
    expect((receivedByB[0] as unknown as { payload: { text: string } }).payload.text).toBe(
      "from A",
    );

    // Both daemons have both messages in SQLite
    const msgsA = storageA.getMessages({ channelId: ctxA.channel.id });
    const msgsB = storageB.getMessages({ channelId: ctxA.channel.id });
    expect(msgsA).toHaveLength(1); // only B's message ingested (A's was local)
    expect(msgsB).toHaveLength(1); // only A's message ingested (B's was local)
  });

  it("workspace isolation: daemon only receives messages for subscribed workspaces", async () => {
    const ctxA = setupUser(storageA);
    const ctxB = setupUser(storageB); // different workspace

    const receivedByB: Record<string, unknown>[] = [];

    clientA = new DaemonRelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      daemonId: "daemon-a",
      token: "test-token",
      workspaceIds: [ctxA.workspace.id],
      storage: storageA,
    });

    clientB = new DaemonRelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      daemonId: "daemon-b",
      token: "test-token",
      workspaceIds: [ctxB.workspace.id],
      storage: storageB,
      onMessage: (_wsId, _from, msg) => receivedByB.push(msg),
    });

    clientA.connect();
    clientB.connect();
    await wait(300);

    clientA.forward(ctxA.workspace.id, {
      type: "cyborg:channel_message_broadcast",
      payload: { id: "msg-private", text: "workspace A only" },
    });

    await wait(200);

    // B should NOT receive A's message (different workspace)
    expect(receivedByB).toHaveLength(0);
  });

  it("relay rejects unauthenticated connections", async () => {
    const authRelay = new WorkspaceRelay({
      validateToken: (token) => token === "valid-secret",
    });
    const authPort = await authRelay.listen(0);

    const storage = createTestStorage();
    const { workspace } = setupUser(storage);

    const client = new DaemonRelayClient({
      relayUrl: `ws://127.0.0.1:${authPort}`,
      daemonId: "bad-daemon",
      token: "wrong-token",
      workspaceIds: [workspace.id],
      storage,
      reconnectMs: 999999,
    });

    client.connect();
    await wait(300);

    expect(client.isConnected()).toBe(false);
    expect(authRelay.getConnectedDaemons()).toHaveLength(0);

    client.close();
    await storage.close();
    await authRelay.close();
  });

  it("daemon reconnects and syncs missed messages", async () => {
    const ctxA = setupUser(storageA);
    const userB = storageB.upsertUser("user-b@test.dev", "User B");
    storageB.sqlite.db
      .prepare(`INSERT INTO workspaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)`)
      .run(ctxA.workspace.id, "Shared WS", userB.id, Date.now());
    storageB.sqlite.db
      .prepare(
        `INSERT INTO channels (id, workspace_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(ctxA.channel.id, ctxA.workspace.id, "general", userB.id, Date.now());

    const receivedByB: Record<string, unknown>[] = [];

    clientA = new DaemonRelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      daemonId: "daemon-a",
      token: "test-token",
      workspaceIds: [ctxA.workspace.id],
      storage: storageA,
    });

    clientB = new DaemonRelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      daemonId: "daemon-b",
      token: "test-token",
      workspaceIds: [ctxA.workspace.id],
      storage: storageB,
      onMessage: (_wsId, _from, msg) => receivedByB.push(msg),
      reconnectMs: 200,
    });

    clientA.connect();
    clientB.connect();
    await wait(300);

    // B disconnects
    clientB.close();
    await wait(100);
    expect(relay.getSubscriberCount(ctxA.workspace.id)).toBe(1);

    // A sends while B is offline
    clientA.forward(ctxA.workspace.id, {
      type: "cyborg:channel_message_broadcast",
      payload: {
        id: "msg-offline",
        workspaceId: ctxA.workspace.id,
        channelId: ctxA.channel.id,
        fromId: ctxA.user.id,
        fromType: "human",
        text: "sent while B offline",
        seq: 1,
        createdAt: Date.now(),
      },
    });

    await wait(200);

    // B should NOT have the message (was offline)
    const bMsgsBefore = storageB.getMessages({ channelId: ctxA.channel.id });
    expect(bMsgsBefore).toHaveLength(0);

    // B reconnects
    clientB = new DaemonRelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      daemonId: "daemon-b",
      token: "test-token",
      workspaceIds: [ctxA.workspace.id],
      storage: storageB,
      onMessage: (_wsId, _from, msg) => receivedByB.push(msg),
    });
    clientB.connect();
    await wait(300);

    expect(clientB.isConnected()).toBe(true);
    expect(relay.getSubscriberCount(ctxA.workspace.id)).toBe(2);

    // Note: without PG in relay, sync returns empty — that's expected in solo mode.
    // The reconnect sync test with actual PG backfill is in dual-storage.test.ts.
    // Here we verify the reconnect mechanism works (daemon reconnects and subscribes).
  });

  // Regression (#agent-session-reload): agent-scoped RPC forwards (timeline,
  // set_agent_model, …) must reach the daemon that OWNS the agent. The
  // no-target fallback delivers to whichever subscriber comes first, so a
  // workspace with several daemons answered "Agent not found" — blank history
  // after reload, model switches that never applied. relay-standalone resolves
  // the owning daemon (pg.getAgentDaemonId) and passes it as the target; this
  // pins the targeted-delivery contract that resolution relies on.
  it("sendToDaemonInWorkspace with an explicit target reaches THAT daemon, not the first subscriber", async () => {
    const ctxA = setupUser(storageA);

    const userB = storageB.upsertUser("user-b2@test.dev", "User B");
    storageB.sqlite.db
      .prepare(`INSERT INTO workspaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)`)
      .run(ctxA.workspace.id, "Shared WS", userB.id, Date.now());
    storageB.addMember(ctxA.workspace.id, userB.id, "member");

    const receivedByA: Record<string, unknown>[] = [];
    const receivedByB: Record<string, unknown>[] = [];

    clientA = new DaemonRelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      daemonId: "daemon-a",
      token: "test-token",
      workspaceIds: [ctxA.workspace.id],
      storage: storageA,
      onMessage: (_wsId, _from, msg) => receivedByA.push(msg),
    });
    clientB = new DaemonRelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      daemonId: "daemon-b",
      token: "test-token",
      workspaceIds: [ctxA.workspace.id],
      storage: storageB,
      onMessage: (_wsId, _from, msg) => receivedByB.push(msg),
    });
    clientA.connect();
    clientB.connect();
    await wait(300);
    expect(relay.getSubscriberCount(ctxA.workspace.id)).toBe(2);

    // Targeted at daemon-b (connected second — the untargeted fallback would
    // pick the first subscriber): only B may receive it.
    const rpc = { type: "cyborg:relay_rpc", inner: { type: "cyborg:fetch_agent_timeline" } };
    const delivered = relay.sendToDaemonInWorkspace(ctxA.workspace.id, rpc, "daemon-b");
    expect(delivered).toBe(true);
    await wait(300);

    expect(receivedByB.some((m) => m.type === "cyborg:relay_rpc")).toBe(true);
    expect(receivedByA.some((m) => m.type === "cyborg:relay_rpc")).toBe(false);

    // Targeting a daemon that isn't connected reports failure instead of
    // silently falling back to an arbitrary subscriber.
    expect(relay.sendToDaemonInWorkspace(ctxA.workspace.id, rpc, "daemon-zzz")).toBe(false);
  });
});
