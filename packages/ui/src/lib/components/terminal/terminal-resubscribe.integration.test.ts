import { beforeAll, describe, expect, it } from "vitest";
import { CyborgClient } from "../../ws-client.js";
import { relayTerminalTransport } from "./terminal-transport.js";
import type { TerminalState } from "./terminal-snapshot.js";

// internal docs PART F — the regression test that would have caught #789.
//
// #789's root cause was a fan-out WHITELIST OMISSION in ws-client.ts (the inbound
// frame type was dropped before it reached the terminal transport). The existing
// terminal-transport tests use a `fakeSocket` and so could NEVER catch it: they
// never route through the REAL CyborgClient.handleExtensionMessage fan-out.
//
// This test wires a `relayTerminalTransport` to a REAL CyborgClient's
// `terminalSocket()` and drives inbound frames through the client's real private
// `handleMessage` (the exact path doConnect's socket "message" listener uses), so
// a snapshot frame must traverse the genuine whitelist → terminalListeners →
// terminalSocket().on → transport.onSnapshot chain to be observed.

const OPEN = 1;

beforeAll(() => {
  // SlackClient.connected / sendRaw compare this.ws.readyState === WebSocket.OPEN.
  (globalThis as { WebSocket?: unknown }).WebSocket = { OPEN };
});

interface FakeSocket {
  readyState: number;
  sent: string[];
  send: (data: string) => void;
}

function makeFakeSocket(): FakeSocket {
  const sent: string[] = [];
  return { readyState: OPEN, sent, send: (data: string) => sent.push(data) };
}

// A real CyborgClient with an injected fake ws, exposing the private message seam
// so a test can replay relay→client frames exactly as the live socket would.
class TestCyborgClient extends CyborgClient {
  attach(socket: FakeSocket): void {
    (this as unknown as { ws: FakeSocket }).ws = socket;
  }
  // Replay a relay → client frame through the REAL fan-out (handleMessage →
  // handleExtensionMessage → terminalListeners). This is the load-bearing seam:
  // the frame must survive the ws-client whitelist to reach the transport.
  feed(frame: Record<string, unknown>): void {
    (this as unknown as { handleMessage: (raw: string) => void }).handleMessage(
      JSON.stringify(frame),
    );
  }
}

// A tiny screen state with one identifying glyph so a repaint is observable.
function snapshotState(marker: string): TerminalState {
  return {
    rows: 1,
    cols: 4,
    grid: [[{ char: marker }]],
    scrollback: [],
    cursor: { row: 0, col: 1 },
  };
}

function makeHarness() {
  const socket = makeFakeSocket();
  const client = new TestCyborgClient();
  client.attach(socket);

  let requestSeq = 0;
  const transport = relayTerminalTransport({
    socket: client.terminalSocket(),
    workspaceId: "ws1",
    daemonId: "d1",
    newRequestId: () => `req-${++requestSeq}`,
  });

  // Capture what the view would repaint: every snapshot's rendered marker + every
  // output chunk, in arrival order.
  const painted: string[] = [];
  const offData = transport.onData(({ data }) => painted.push(`out:${data}`));
  const offSnapshot = transport.onSnapshot?.(({ state }) =>
    painted.push(`snap:${state.grid[0]?.[0]?.char ?? ""}`),
  );

  // The terminalId the start ack will hand back.
  const terminalId = "term-1";

  // The daemon stub: reply to a start_terminal with an ack + a snapshot + output.
  function lastSent(): { type?: string; terminalId?: string } {
    const raw = socket.sent.at(-1);
    if (!raw) throw new Error("nothing sent");
    return (JSON.parse(raw) as { message: { type?: string; terminalId?: string } }).message;
  }

  function startTerminalSentCount(): number {
    return socket.sent.filter(
      (raw) =>
        (JSON.parse(raw) as { message: { type?: string } }).message.type ===
        "cyborg:start_terminal",
    ).length;
  }

  return {
    socket,
    client,
    transport,
    terminalId,
    painted,
    lastSent,
    startTerminalSentCount,
    feed: (frame: Record<string, unknown>) => client.feed(frame),
    dispose() {
      offData();
      offSnapshot?.();
    },
  };
}

describe("terminal snapshot-on-resubscribe self-heals through the REAL ws-client fan-out", () => {
  it("start → snapshot + output repaints; resubscribe repaints from a fresh snapshot with NO new start()", async () => {
    const h = makeHarness();

    // 1. start() → the transport sends cyborg:start_terminal and waits for the ack.
    const startPromise = h.transport.start({ cols: 4, rows: 1 });
    const startFrame = h.lastSent();
    expect(startFrame.type).toBe("cyborg:start_terminal");
    const requestId = (JSON.parse(h.socket.sent.at(-1)!) as { message: { requestId: string } })
      .message.requestId;

    // Daemon acks the start with the assigned terminalId.
    h.feed({
      type: "cyborg:start_terminal_response",
      payload: { requestId, ok: true, terminalId: h.terminalId },
    });
    const started = await startPromise;
    expect(started.id).toBe(h.terminalId);

    // Daemon delivers the initial snapshot + a live output chunk.
    h.feed({
      type: "cyborg:terminal_snapshot",
      payload: { terminalId: h.terminalId, state: snapshotState("A"), toUserId: "u1" },
    });
    h.feed({
      type: "cyborg:terminal_output",
      payload: { terminalId: h.terminalId, data: "hi", toUserId: "u1" },
    });

    expect(h.painted).toEqual(["snap:A", "out:hi"]);
    expect(h.startTerminalSentCount()).toBe(1);

    // 2. Simulate a tab-switch resubscribe: NO ack frame at all — only a FRESH
    //    snapshot. Under the OLD model a missing ack → 15s timeout → fresh start();
    //    under snapshot-on-(re)subscribe the snapshot ALONE heals the screen.
    h.feed({
      type: "cyborg:terminal_snapshot",
      payload: { terminalId: h.terminalId, state: snapshotState("B"), toUserId: "u1" },
    });

    // The screen repainted from the fresh snapshot...
    expect(h.painted).toEqual(["snap:A", "out:hi", "snap:B"]);
    // ...and CRUCIALLY no new cyborg:start_terminal was issued (the #789 failure).
    expect(h.startTerminalSentCount()).toBe(1);

    h.dispose();
  });

  it("subscribe() resolves on the FRESH snapshot frame alone — NO ack on the critical path (Phase 2)", async () => {
    const h = makeHarness();

    // The view (re)subscribes to an existing session. Under Phase 2 the daemon
    // sends NO ack — the transport resolves the instant the snapshot for THIS
    // terminal arrives through the real ws-client fan-out.
    const subPromise = h.transport.subscribe!(h.terminalId);
    const subFrame = h.lastSent();
    expect(subFrame.type).toBe("cyborg:subscribe_terminal");

    // Daemon delivers ONLY a fresh snapshot (no *_response ack at all).
    h.feed({
      type: "cyborg:terminal_snapshot",
      payload: { terminalId: h.terminalId, state: snapshotState("S"), toUserId: "u1" },
    });

    const res = await subPromise;
    expect(res.ok).toBe(true);
    // The screen repainted from the snapshot, and crucially NO start() was issued.
    expect(h.painted).toEqual(["snap:S"]);
    expect(h.startTerminalSentCount()).toBe(0);

    h.dispose();
  });

  it("unsubscribe() sends cyborg:unsubscribe_terminal and never a kill (pty survives the tab switch)", () => {
    const h = makeHarness();
    h.transport.unsubscribe!(h.terminalId, "mount-1");
    const frame = h.lastSent();
    expect(frame.type).toBe("cyborg:unsubscribe_terminal");
    // No kill frame was ever produced — unsubscribe is not a teardown.
    const killCount = h.socket.sent.filter(
      (raw) =>
        (JSON.parse(raw) as { message: { type?: string } }).message.type === "cyborg:kill_terminal",
    ).length;
    expect(killCount).toBe(0);
    h.dispose();
  });

  it("NEGATIVE GUARD: a snapshot frame is dropped when cyborg:terminal_snapshot is NOT whitelisted in ws-client", () => {
    // This guards the exact class of gap #789 exploited. We re-create the failure
    // by feeding a frame type that is NOT in the ws-client whitelist and asserting
    // it never reaches the transport. If a future change removes
    // cyborg:terminal_snapshot from the whitelist, the POSITIVE test above flips to
    // painting nothing on resubscribe — and this test documents why: an
    // un-whitelisted terminal frame is silently dropped by the real fan-out.
    const h = makeHarness();

    // A frame type the whitelist does NOT include (stand-in for "snapshot dropped
    // from the whitelist"): it must NOT reach any terminal listener.
    h.feed({
      type: "cyborg:terminal_snapshot_NOT_WHITELISTED",
      payload: { terminalId: h.terminalId, state: snapshotState("X"), toUserId: "u1" },
    });
    expect(h.painted).toEqual([]);

    // Sanity: the WHITELISTED snapshot type DOES reach the transport — proving the
    // fan-out works and the negative result above is the whitelist, not a dead wire.
    h.feed({
      type: "cyborg:terminal_snapshot",
      payload: { terminalId: h.terminalId, state: snapshotState("Y"), toUserId: "u1" },
    });
    expect(h.painted).toEqual(["snap:Y"]);

    h.dispose();
  });
});
