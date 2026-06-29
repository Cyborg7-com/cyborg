import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SlackClient } from "./client.js";

// Regression for the signup "verify → spinner forever" bug. Every await in the
// connect/auth path is 15s-timeout-bounded EXCEPT the raw WebSocket open inside
// doConnect(): a stalled TCP/TLS/HTTP-upgrade handshake (relay cold start, LB
// drain, flaky network) fires neither `open` nor `error`, so doConnect()'s
// promise never settled and connectToServer() awaited forever — the UI hung on a
// spinner with NO error until a manual reload. doConnect() now arms a connect
// watchdog that rejects (→ NetworkError, surfaced + retryable) and tears the
// half-open socket down. These tests drive doConnect() via a fake WebSocket
// constructor (the UI vitest env is plain node — no DOM/WebSocket).

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

type Handler = (ev: unknown) => void;

// Minimal WebSocket stand-in: records sends/closes and lets a test drive the
// open/error/close events that a real socket would fire from the network.
class FakeWebSocket {
  static OPEN = OPEN;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = CONNECTING;
  sent: string[] = [];
  closedCount = 0;
  private handlers: Record<string, Handler[]> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: Handler): void {
    (this.handlers[type] ??= []).push(handler);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closedCount++;
    this.readyState = CLOSED;
    this.dispatch("close");
  }

  // ── test drivers ──────────────────────────────────────────────────────────
  private dispatch(type: string): void {
    for (const h of this.handlers[type] ?? []) h({});
  }
  fireOpen(): void {
    this.readyState = OPEN;
    this.dispatch("open");
  }
  fireError(): void {
    this.dispatch("error");
  }
  static last(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error("no FakeWebSocket was constructed");
    return ws;
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SlackClient.connect() watchdog (signup verify-then-hang regression)", () => {
  it("rejects instead of hanging forever when the socket never opens", async () => {
    vi.useFakeTimers();
    const client = new SlackClient();
    try {
      const p = client.connect("ws://relay.test/api/ws", "tok");
      // Attach the rejection handler BEFORE advancing so the reject is awaited.
      const assertion = expect(p).rejects.toThrow(/timed out/i);
      const ws = FakeWebSocket.last();
      expect(ws.readyState).toBe(CONNECTING); // still handshaking, no open/error

      await vi.advanceTimersByTimeAsync(15_001); // past connectTimeoutMs (15s)

      await assertion; // previously this promise never settled → test would hang
      expect(ws.closedCount).toBe(1); // watchdog tore the stalled socket down
    } finally {
      client.disconnect();
    }
  });

  it("resolves when the socket opens in time and clears the watchdog", async () => {
    vi.useFakeTimers();
    const client = new SlackClient();
    try {
      const p = client.connect("ws://relay.test/api/ws", "tok");
      const ws = FakeWebSocket.last();
      ws.fireOpen();

      await expect(p).resolves.toBeUndefined();

      // Advancing well past the connect timeout must NOT tear down a live socket
      // (the watchdog was cleared on open).
      await vi.advanceTimersByTimeAsync(20_000);
      expect(ws.closedCount).toBe(0);
      expect(ws.readyState).toBe(OPEN);
    } finally {
      client.disconnect();
    }
  });

  it("rejects on a socket error and clears the watchdog (no late timeout reject)", async () => {
    vi.useFakeTimers();
    const client = new SlackClient();
    try {
      const p = client.connect("ws://relay.test/api/ws", "tok");
      const assertion = expect(p).rejects.toThrow(/failed/i);
      const ws = FakeWebSocket.last();
      ws.fireError();

      await assertion;

      // Watchdog cleared by the error handler — advancing past the timeout must
      // not fire a second (timeout) teardown of this socket.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(ws.closedCount).toBe(0);
    } finally {
      client.disconnect();
    }
  });

  // Gemini review: WebSocket events are async, so a socket discarded by a newer
  // connect() can fire `open`/`close` late. Those stale events must not touch the
  // live socket (the close handler would otherwise null it out and schedule a
  // spurious reconnect).
  it("ignores a discarded socket's late open/close after a newer connect()", async () => {
    vi.useFakeTimers();
    const client = new SlackClient();
    try {
      const p1 = client.connect("ws://relay.test/api/ws", "tok"); // socket A
      p1.catch(() => {}); // A is discarded below — don't leave an unhandled rejection
      const a = FakeWebSocket.instances[0];

      // A second connect() (reconnect / re-login) replaces the socket: connect()
      // closes A and opens B. B is now the live socket.
      const p2 = client.connect("ws://relay.test/api/ws", "tok"); // socket B
      const b = FakeWebSocket.instances[1];
      expect(b).not.toBe(a);
      b.fireOpen();
      await expect(p2).resolves.toBeUndefined();
      expect(b.readyState).toBe(OPEN);

      const bClosedBefore = b.closedCount;
      // A's late, out-of-order events must NOT touch the live socket B.
      a.fireOpen();
      a.close();

      expect(b.closedCount).toBe(bClosedBefore); // B was not torn down by A's close
      expect(b.readyState).toBe(OPEN);
      expect((client as unknown as { ws: unknown }).ws).toBe(b); // B is still current
    } finally {
      client.disconnect();
      await vi.advanceTimersByTimeAsync(20_000); // flush A's connect watchdog
    }
  });
});
