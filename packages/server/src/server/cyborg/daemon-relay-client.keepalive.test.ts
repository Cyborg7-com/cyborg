import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { DaemonRelayClient } from "./daemon-relay-client.js";

// Minimal stand-in for a `ws` WebSocket — enough surface for the client's
// keepalive path (readyState/send/ping/terminate/close + open/message/pong/
// close/error events). A real socket can't deterministically simulate a
// half-open link, so we drive liveness by hand.
class FakeWs extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  pings = 0;
  terminated = false;
  throwOnPing = false;

  send(data: string): void {
    this.sent.push(data);
  }
  ping(): void {
    if (this.throwOnPing) throw new Error("ping failed");
    this.pings += 1;
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
    // ws emits "close" on terminate(); replicate so the client's reconnect path
    // runs exactly as it would in production.
    this.emit("close", 1006, Buffer.from(""));
  }
  close(): void {
    this.readyState = WebSocket.CLOSED;
  }
  // Drive the relay handshake so the client flips to connected.
  becomeSubscribed(): void {
    this.emit("message", Buffer.from(JSON.stringify({ type: "relay_subscribed" })));
  }
}

function createTestStorage(): DualStorage {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "daemon-keepalive-test-"));
  const sqlite = new CyborgStorage(path.join(tmpDir, "test.db"));
  return new DualStorage(sqlite, null);
}

const PING_INTERVAL_MS = 10_000;

describe("DaemonRelayClient — WS keepalive (no pong-stale terminate, #801 regression)", () => {
  let storage: DualStorage;
  let sockets: FakeWs[];
  let client: DaemonRelayClient;

  beforeEach(() => {
    vi.useFakeTimers();
    storage = createTestStorage();
    sockets = [];
  });

  afterEach(async () => {
    client?.close();
    vi.useRealTimers();
    await storage.close();
  });

  function makeClient(): DaemonRelayClient {
    return new DaemonRelayClient({
      relayUrl: "ws://relay.test",
      daemonId: "daemon-a",
      token: "t",
      workspaceIds: ["w1"],
      storage,
      reconnectMs: 1000,
      createWebSocket: () => {
        const ws = new FakeWs();
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
    });
  }

  it("sends a WS ping on the keepalive interval while connected", () => {
    client = makeClient();
    client.connect();
    sockets[0].emit("open");
    sockets[0].becomeSubscribed();

    expect(sockets[0].pings).toBe(0);
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(sockets[0].pings).toBe(1);
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(sockets[0].pings).toBe(2);
  });

  it("#801 regression: an open socket that NEVER receives a pong (ALB drops pong frames) is NOT terminated", () => {
    client = makeClient();
    client.connect();
    sockets[0].emit("open");
    sockets[0].becomeSubscribed();
    expect(client.isConnected()).toBe(true);

    // No pong EVER comes back (the ALB strips WS ping/pong control frames), yet
    // the socket stays OPEN and active. Advance far past the old 30s stale window
    // — the keepalive must keep pinging and must never terminate a healthy socket.
    vi.advanceTimersByTime(PING_INTERVAL_MS * 30); // 5 minutes, well past any stale window

    expect(sockets[0].terminated).toBe(false);
    expect(client.isConnected()).toBe(true);
    expect(sockets.length).toBe(1); // no terminate -> no reconnect
    expect(sockets[0].pings).toBeGreaterThan(0); // still keeping the link warm
  });

  it("a genuinely closed socket still triggers reconnect via the close handler", () => {
    client = makeClient();
    client.connect();
    sockets[0].emit("open");
    sockets[0].becomeSubscribed();
    expect(client.isConnected()).toBe(true);

    // A real socket close (network drop, relay restart) — distinct from a missed
    // pong. The on("close") handler must schedule a reconnect.
    sockets[0].readyState = WebSocket.CLOSED;
    sockets[0].emit("close", 1006, Buffer.from(""));
    expect(client.isConnected()).toBe(false);

    vi.advanceTimersByTime(2000);
    expect(sockets.length).toBe(2); // reconnected
  });

  it("terminates and reconnects when ping() itself throws (send failure on a dead socket)", () => {
    client = makeClient();
    client.connect();
    sockets[0].emit("open");
    sockets[0].becomeSubscribed();
    sockets[0].throwOnPing = true;

    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(sockets[0].terminated).toBe(true);

    vi.advanceTimersByTime(2000);
    expect(sockets.length).toBe(2);
  });

  // A cron-fired cybo read is decoupled from relay connectivity, so the socket
  // can be mid-reconnect when the read fires. cyboRead must wait for the socket
  // to come back rather than instantly returning null (which degrades the roster
  // to local SQLite placeholders — the "<uuid>@remote.local" roster bug).
  it("cyboRead waits for a reconnect instead of immediately degrading to null", async () => {
    client = makeClient();
    client.connect();
    sockets[0].emit("open");
    sockets[0].becomeSubscribed();
    expect(client.isConnected()).toBe(true);

    // Socket drops just before the read fires (cron tick during a reconnect).
    sockets[0].readyState = WebSocket.CLOSED;
    sockets[0].emit("close", 1006, Buffer.from(""));
    expect(client.isConnected()).toBe(false);

    const readPromise = client.cyboRead({ workspaceId: "w1", cyboId: "c1", kind: "roster" });

    // Reconnect lands inside the wait window (reconnectMs = 1000).
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets.length).toBe(2);
    sockets[1].emit("open");
    sockets[1].becomeSubscribed();

    // The poll observes the live socket and sends the request.
    await vi.advanceTimersByTimeAsync(200);
    const sent = sockets[1].sent.find((s) => s.includes("cybo_read_request"));
    expect(sent).toBeTruthy();

    // Relay answers → the read resolves with real data, not null.
    const requestId = JSON.parse(sent!).requestId as string;
    sockets[1].emit(
      "message",
      Buffer.from(JSON.stringify({ type: "cybo_read_response", requestId, ok: true, members: [] })),
    );
    const res = await readPromise;
    expect(res).not.toBeNull();
    expect(res?.ok).toBe(true);
  });

  it("cyboRead returns null when the socket never recovers within the wait window", async () => {
    client = makeClient();
    client.connect();
    sockets[0].emit("open");
    sockets[0].becomeSubscribed();
    sockets[0].readyState = WebSocket.CLOSED;
    sockets[0].emit("close", 1006, Buffer.from(""));

    const readPromise = client.cyboRead({ workspaceId: "w1", cyboId: "c1", kind: "roster" });
    // Reconnect sockets are created but never subscribe, so connected stays false.
    await vi.advanceTimersByTimeAsync(5200);
    expect(await readPromise).toBeNull();
  });

  it("cyboRead aborts its wait immediately when the client is closed mid-wait", async () => {
    client = makeClient();
    client.connect();
    sockets[0].emit("open");
    sockets[0].becomeSubscribed();
    sockets[0].readyState = WebSocket.CLOSED;
    sockets[0].emit("close", 1006, Buffer.from(""));

    const readPromise = client.cyboRead({ workspaceId: "w1", cyboId: "c1", kind: "roster" });
    client.close();
    // One poll tick is enough to observe `closed` and bail — no full 5s window.
    await vi.advanceTimersByTimeAsync(200);
    expect(await readPromise).toBeNull();
  });

  it("stops the keepalive timer on close (no leaked pings after shutdown)", () => {
    client = makeClient();
    client.connect();
    sockets[0].emit("open");
    sockets[0].becomeSubscribed();

    client.close();
    const pingsAtClose = sockets[0].pings;
    vi.advanceTimersByTime(PING_INTERVAL_MS * 5);
    expect(sockets[0].pings).toBe(pingsAtClose);
  });
});
