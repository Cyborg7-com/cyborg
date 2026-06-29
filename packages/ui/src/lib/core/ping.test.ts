import { describe, it, expect, beforeAll, vi } from "vitest";
import { SlackClient } from "./client.js";

// Presence auto-heal (Part B): SlackClient.ping(timeoutMs) sends `cyborg:ping`
// over the existing round-trip plumbing and resolves:
//   • true  — on ANY response with the matching requestId, INCLUDING a
//             cyborg:error round-trip (an error reply still proves the socket is
//             alive → backward-compatible with relays that don't know the ping)
//   • false — only on timeout / not connected.
//
// The UI vitest env is plain node (no DOM/WebSocket), so we (a) provide a global
// WebSocket with an OPEN constant and (b) drive the client with a fake socket +
// the message-handling seam, instead of opening a real connection.

const OPEN = 1;

beforeAll(() => {
  // SlackClient.connected compares this.ws.readyState === WebSocket.OPEN.
  (globalThis as { WebSocket?: unknown }).WebSocket = { OPEN };
});

// Minimal fake socket: OPEN + a send() that records the frames the client emits.
interface FakeSocket {
  readyState: number;
  sent: string[];
  send: (data: string) => void;
}

function makeFakeSocket(): FakeSocket {
  const sent: string[] = [];
  return { readyState: OPEN, sent, send: (data: string) => sent.push(data) };
}

// Test seam over SlackClient: inject a fake ws and replay relay frames. `ws` and
// `handleMessage` are private on the base class; reach them via casts so we can
// exercise ping() exactly as a live socket would, with no real network.
class TestClient extends SlackClient {
  attach(socket: FakeSocket): void {
    (this as unknown as { ws: FakeSocket }).ws = socket;
  }
  detach(): void {
    (this as unknown as { ws: FakeSocket | null }).ws = null;
  }
  // Replay a relay → client frame (the same envelope doConnect's message handler
  // would pass to handleMessage).
  feed(frame: Record<string, unknown>): void {
    (this as unknown as { handleMessage: (raw: string) => void }).handleMessage(
      JSON.stringify(frame),
    );
  }
  // Pull the requestId the client put on the outgoing cyborg:ping, so a test can
  // answer with a matching pong/error.
  lastPingRequestId(socket: FakeSocket): string {
    const last = socket.sent.at(-1);
    if (!last) throw new Error("no frame sent");
    const outer = JSON.parse(last) as { message?: { type?: string; requestId?: string } };
    expect(outer.message?.type).toBe("cyborg:ping");
    return outer.message!.requestId!;
  }
  // Invoke the reject handler the client registered for this ping's requestId,
  // exactly as disconnect() (Error("Client disconnected")) or handleMessage()'s
  // cyborg:error branch (Error(payload.message)) would. Lets a test cover the
  // reject path directly without round-tripping a frame.
  rejectPending(requestId: string, err: Error): void {
    const pending = (
      this as unknown as { pendingRequests: Map<string, { reject: (e: Error) => void }> }
    ).pendingRequests.get(requestId);
    if (!pending) throw new Error(`no pending request for ${requestId}`);
    pending.reject(err);
  }
}

describe("SlackClient.ping()", () => {
  it("resolves true when a cyborg:pong with the matching requestId arrives", async () => {
    const client = new TestClient();
    const socket = makeFakeSocket();
    client.attach(socket);

    const pending = client.ping(1000);
    const requestId = client.lastPingRequestId(socket);
    // Pong envelope matches the relay's sendPaseoResponse shape.
    client.feed({ type: "session", message: { type: "cyborg:pong", payload: { requestId } } });

    expect(await pending).toBe(true);
  });

  it("resolves true on a cyborg:error round-trip (old relay) — an error still proves liveness", async () => {
    const client = new TestClient();
    const socket = makeFakeSocket();
    client.attach(socket);

    const pending = client.ping(1000);
    const requestId = client.lastPingRequestId(socket);
    client.feed({
      type: "session",
      message: {
        type: "cyborg:error",
        payload: { requestId, message: "unsupported: cyborg:ping" },
      },
    });

    expect(await pending).toBe(true);
  });

  it("resolves false when the pending request is rejected with 'Client disconnected' (disconnect())", async () => {
    const client = new TestClient();
    const socket = makeFakeSocket();
    client.attach(socket);

    const pending = client.ping(1000);
    const requestId = client.lastPingRequestId(socket);
    // disconnect() rejects every pending request with this exact error during an
    // intentional teardown — a torn-down socket must NOT report as alive.
    client.rejectPending(requestId, new Error("Client disconnected"));

    expect(await pending).toBe(false);
  });

  it("resolves true when the pending request is rejected with a generic relay error (old relay)", async () => {
    const client = new TestClient();
    const socket = makeFakeSocket();
    client.attach(socket);

    const pending = client.ping(1000);
    const requestId = client.lastPingRequestId(socket);
    // A cyborg:error round-trip (handleMessage rejects with the payload message)
    // still proves the socket is alive → backward-compatible with old relays.
    client.rejectPending(requestId, new Error("unsupported: cyborg:ping"));

    expect(await pending).toBe(true);
  });

  it("resolves false on timeout when no response arrives", async () => {
    vi.useFakeTimers();
    try {
      const client = new TestClient();
      const socket = makeFakeSocket();
      client.attach(socket);

      const pending = client.ping(5000);
      // No frame fed back — advance past the timeout.
      await vi.advanceTimersByTimeAsync(5001);
      expect(await pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves false immediately when not connected", async () => {
    const client = new TestClient();
    client.detach(); // no socket → connected === false
    expect(await client.ping(1000)).toBe(false);
  });

  it("ignores a pong for a DIFFERENT requestId (no false-positive liveness)", async () => {
    vi.useFakeTimers();
    try {
      const client = new TestClient();
      const socket = makeFakeSocket();
      client.attach(socket);

      const pending = client.ping(5000);
      client.lastPingRequestId(socket); // assert a ping went out
      // A stray pong for an unrelated request must not resolve THIS ping.
      client.feed({
        type: "session",
        message: { type: "cyborg:pong", payload: { requestId: "someone-else" } },
      });
      await vi.advanceTimersByTimeAsync(5001);
      expect(await pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
