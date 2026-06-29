// @vitest-environment jsdom
//
// REGRESSION (#797): the daemon_status offline→online reattach (FIX-1) and the
// bounded auto-retry (FIX-3) re-subscribe in a LOOP — the daemon showed 3 viewers
// for one terminal within ~1s. The initial snapshot renders, but subsequent live
// output never reaches the VISIBLE xterm: every re-subscribe makes the daemon push
// a FRESH snapshot, whose onSnapshot handler calls term.reset() and wipes the live
// output that arrived since. With no debounce/guard, a burst of daemon_status
// flaps (or a daemon that re-broadcasts online) fans out repeated re-subscribes
// and the screen freezes on the snapshot.
//
// This test drives the REAL TerminalView with a transport that records every
// subscribe and every onData handler, plus a Terminal mock that records writes and
// resets. It asserts:
//   1. A burst of daemon_status offline→online edges produces EXACTLY ONE live
//      re-subscribe (debounced) — not one per fire.
//   2. Live output delivered AFTER the reconnect reaches term.write (the visible
//      xterm), and is not swallowed by a re-subscribe-triggered reset loop.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import type { TerminalTransport, TerminalSubscribeResult } from "./terminal-transport.js";
import type { TerminalState } from "./terminal-snapshot.js";

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

// A Terminal mock that records every write so the test can prove live output
// reaches the VISIBLE xterm (term.write) after a reconnect.
const writes: string[] = [];
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: { disableStdin?: boolean } = {};
    buffer = { active: { type: "normal" } };
    loadAddon() {}
    open() {}
    onData() {
      return { dispose() {} };
    }
    write(data: string) {
      writes.push(data);
    }
    focus() {}
    scrollToBottom() {}
    reset() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

import TerminalView from "./TerminalView.svelte";

const TERM_ID = "term-1";
const DAEMON_ID = "d1";

function makeCloudTransport() {
  const subscribeCalls: string[] = [];
  // The live count of in-flight subscribe()s that have NOT yet resolved — proxies
  // the daemon's "N viewers" signal: a re-subscribe loop stacks these.
  let inFlight = 0;
  let maxInFlight = 0;
  let dataHandlers: Array<(p: { id: string; data: string }) => void> = [];
  let snapshotHandler: ((p: { id: string; state: TerminalState }) => void) | null = null;
  let daemonReconnectHandler: (() => void) | null = null;
  let resolveNext: Array<() => void> = [];

  const transport: TerminalTransport = {
    start: async () => ({ id: TERM_ID }),
    subscribe: (id) =>
      new Promise<TerminalSubscribeResult>((resolve) => {
        subscribeCalls.push(id);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Resolve when the test releases it (mirrors the relay snapshot round-trip).
        resolveNext.push(() => {
          inFlight--;
          resolve({ ok: true, live: true });
        });
      }),
    unsubscribe: () => {},
    input: () => {},
    resize: () => {},
    kill: () => {},
    onData: (handler) => {
      dataHandlers.push(handler);
      return () => {
        dataHandlers = dataHandlers.filter((h) => h !== handler);
      };
    },
    onExit: () => () => {},
    onSnapshot: (handler) => {
      snapshotHandler = handler;
      return () => {
        snapshotHandler = null;
      };
    },
    onReconnect: () => () => {},
    onDaemonReconnect: (_daemonId, handler) => {
      daemonReconnectHandler = handler;
      return () => {
        daemonReconnectHandler = null;
      };
    },
  };

  return {
    transport,
    subscribeCalls,
    maxInFlight: () => maxInFlight,
    activeDataHandlers: () => dataHandlers.length,
    deliverOutput: (data: string) => {
      for (const h of dataHandlers) h({ id: TERM_ID, data });
    },
    fireSnapshot: (marker = "x") =>
      snapshotHandler?.({
        id: TERM_ID,
        state: {
          rows: 1,
          cols: 1,
          grid: [[{ char: marker }]],
          scrollback: [],
          cursor: { row: 0, col: 0 },
        },
      }),
    fireDaemonReconnect: () => daemonReconnectHandler?.(),
    flushSubscribes: () => {
      const pending = resolveNext;
      resolveNext = [];
      for (const r of pending) r();
    },
  };
}

async function settle() {
  await vi.runOnlyPendingTimersAsync();
  await Promise.resolve();
  flushSync();
}

describe("TerminalView re-subscribe loop (#797 regression)", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    writes.length = 0;
    vi.useFakeTimers();
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    (globalThis as unknown as { visualViewport: unknown }).visualViewport = null;
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    vi.useRealTimers();
    host.remove();
  });

  it("a burst of daemon offline→online edges re-subscribes ONCE, not once per fire", async () => {
    const h = makeCloudTransport();
    const component = mount(TerminalView, {
      target: host,
      props: { transport: h.transport, terminalId: TERM_ID, daemonId: DAEMON_ID },
    });
    // Resolve the initial mount subscribe. The healthy screen content arrives with
    // that round-trip (fireSnapshot before the settle), so the cold-start blank
    // watchdog never arms — this test isolates the daemon-flap re-subscribe debounce.
    await settle();
    h.flushSubscribes();
    h.fireSnapshot("init");
    await settle();

    const before = h.subscribeCalls.length;

    // The daemon flaps online repeatedly within ~1s (relay re-broadcast / a real
    // flap-flap-flap). Each edge currently fires reattachLive() with NO guard.
    h.fireDaemonReconnect();
    h.fireDaemonReconnect();
    h.fireDaemonReconnect();
    await settle();

    // Exactly ONE re-subscribe should be in flight for the burst (debounced).
    const burstSubscribes = h.subscribeCalls.length - before;
    expect(burstSubscribes).toBe(1);
    // And the daemon never sees more than one viewer's worth of overlapping
    // subscribes at a time.
    expect(h.maxInFlight()).toBeLessThanOrEqual(1);

    h.flushSubscribes();
    await settle();
    await unmount(component);
    flushSync();
  });

  it("live output AFTER a reconnect reaches the visible xterm (term.write)", async () => {
    const h = makeCloudTransport();
    const component = mount(TerminalView, {
      target: host,
      props: { transport: h.transport, terminalId: TERM_ID, daemonId: DAEMON_ID },
    });
    await settle();
    h.flushSubscribes();
    await settle();
    h.fireSnapshot("init");
    await settle();

    // Daemon flaps online → reattach → fresh snapshot heals the screen.
    h.fireDaemonReconnect();
    await settle();
    h.flushSubscribes();
    await settle();
    h.fireSnapshot("healed");
    await settle();

    // Exactly ONE live onData wiring must own the visible xterm (no stacking).
    expect(h.activeDataHandlers()).toBe(1);

    const writesBefore = writes.length;
    // Live output arrives AFTER the reconnect — it MUST reach term.write.
    h.deliverOutput("LIVE-AFTER-RECONNECT");
    await settle();

    expect(writes.slice(writesBefore)).toContain("LIVE-AFTER-RECONNECT");

    await unmount(component);
    flushSync();
  });
});
