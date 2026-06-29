import { describe, it, expect, beforeAll, vi } from "vitest";
import { SlackClient } from "./client.js";

// #503: the transport-level liveness heartbeat lives inside SlackClient, tied to
// the connection lifecycle (started on `open`, stopped on `close`) and NOT
// foreground-gated. Each tick pings; a missed pong within the window means the
// socket is half-open, so the client closes it and the `close` handler's
// scheduleReconnect() takes over. These tests drive the private heartbeat via a
// fake socket (the UI vitest env is plain node — no DOM/WebSocket).

const OPEN = 1;
const CLOSED = 3;

beforeAll(() => {
  // SlackClient.connected compares this.ws.readyState === WebSocket.OPEN.
  (globalThis as { WebSocket?: unknown }).WebSocket = { OPEN };
});

interface FakeSocket {
  readyState: number;
  sent: string[];
  closed: number;
  send: (data: string) => void;
  close: () => void;
}

function makeFakeSocket(): FakeSocket {
  const sent: string[] = [];
  const socket: FakeSocket = {
    readyState: OPEN,
    sent,
    closed: 0,
    send: (data: string) => sent.push(data),
    close: () => {
      socket.closed++;
      socket.readyState = CLOSED;
    },
  };
  return socket;
}

// Reach the private heartbeat seam + the same ws/handleMessage seams ping.test.ts
// uses, via casts — no real network.
class TestClient extends SlackClient {
  attach(socket: FakeSocket): void {
    (this as unknown as { ws: FakeSocket }).ws = socket;
  }
  setIntentionalClose(v: boolean): void {
    (this as unknown as { intentionalClose: boolean }).intentionalClose = v;
  }
  tick(): Promise<void> {
    return (this as unknown as { heartbeatTick: () => Promise<void> }).heartbeatTick();
  }
  start(): void {
    (this as unknown as { startHeartbeat: () => void }).startHeartbeat();
  }
  stop(): void {
    (this as unknown as { stopHeartbeat: () => void }).stopHeartbeat();
  }
  feed(frame: Record<string, unknown>): void {
    (this as unknown as { handleMessage: (raw: string) => void }).handleMessage(
      JSON.stringify(frame),
    );
  }
  lastPingRequestId(socket: FakeSocket): string {
    const last = socket.sent.at(-1);
    if (!last) throw new Error("no frame sent");
    const outer = JSON.parse(last) as { message?: { type?: string; requestId?: string } };
    expect(outer.message?.type).toBe("cyborg:ping");
    return outer.message!.requestId!;
  }
}

describe("SlackClient transport heartbeat (#503)", () => {
  it("closes a half-open socket when a heartbeat ping gets no pong", async () => {
    vi.useFakeTimers();
    try {
      const client = new TestClient();
      const socket = makeFakeSocket();
      client.attach(socket);

      const tick = client.tick(); // sends a ping, waits up to the 10s window
      client.lastPingRequestId(socket); // assert a cyborg:ping went out
      await vi.advanceTimersByTimeAsync(10_001); // no pong → window elapses
      await tick;

      expect(socket.closed).toBe(1); // socket torn down → close handler reconnects
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the socket open when the ping is answered (live socket)", async () => {
    const client = new TestClient();
    const socket = makeFakeSocket();
    client.attach(socket);

    const tick = client.tick();
    const requestId = client.lastPingRequestId(socket);
    client.feed({ type: "session", message: { type: "cyborg:pong", payload: { requestId } } });
    await tick;

    expect(socket.closed).toBe(0);
  });

  it("does NOT close during an intentional teardown (logout/shutdown)", async () => {
    vi.useFakeTimers();
    try {
      const client = new TestClient();
      const socket = makeFakeSocket();
      client.attach(socket);
      client.setIntentionalClose(true);

      const tick = client.tick();
      await vi.advanceTimersByTimeAsync(10_001); // ping times out
      await tick;

      expect(socket.closed).toBe(0); // watchdog must not fight an intentional close
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT close a reconnected socket when a stale ping from the old one times out (race)", async () => {
    vi.useFakeTimers();
    try {
      const client = new TestClient();
      const socketA = makeFakeSocket();
      client.attach(socketA);

      const tick = client.tick(); // probes socket A
      client.lastPingRequestId(socketA); // A's ping went out

      // Connection A drops and a reconnect swaps in a fresh socket B BEFORE the
      // 10s ping window elapses. The stale tick must only ever close the socket
      // it actually probed (A), never the new current one (B).
      const socketB = makeFakeSocket();
      client.attach(socketB);

      await vi.advanceTimersByTimeAsync(10_001); // stale ping times out → false
      await tick;

      expect(socketB.closed).toBe(0); // the new healthy socket is untouched
    } finally {
      vi.useRealTimers();
    }
  });

  it("no-ops the tick when not connected (lets the reconnect loop own it)", async () => {
    const client = new TestClient();
    // no socket attached → connected === false
    await client.tick();
    // nothing to assert beyond "did not throw"; a no-socket tick must be inert.
    expect(true).toBe(true);
  });

  it("startHeartbeat pings on the interval; stopHeartbeat cancels further pings", async () => {
    vi.useFakeTimers();
    try {
      const client = new TestClient();
      const socket = makeFakeSocket();
      client.attach(socket);

      client.start();
      await vi.advanceTimersByTimeAsync(30_000); // one interval
      expect(socket.sent.length).toBe(1);
      client.lastPingRequestId(socket); // the frame is a cyborg:ping

      client.stop();
      socket.sent.length = 0;
      await vi.advanceTimersByTimeAsync(60_000); // two more intervals
      expect(socket.sent.length).toBe(0); // stopped → no more pings
    } finally {
      vi.useRealTimers();
    }
  });
});
