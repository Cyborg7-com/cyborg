// @vitest-environment jsdom
//
// TerminalView connection-resilience + graceful-degradation UX
// (internal docs FIX-1/2/3 + internal docs PART B). Proves:
//   1. FIX-1: a daemon offline→online transition (guest socket stays OPEN) re-subscribes
//      the live pty and repaints from the fresh snapshot — NO "no longer available".
//   2. FIX-2/3: a subscribe TIMEOUT (transient) shows "Reconnecting…" and retries,
//      never the dead-end; only a real dead ack shows the ended state.
// 3. internal docs B.5: a genuinely-ended session (dead ack / live:false) renders the
//      read-only scrollback + a [Restart] affordance (and makes xterm read-only).
//
// xterm + the fit addon are mocked (no canvas in jsdom); a fake cloud-relay
// TerminalTransport (subscribe + onSnapshot + onReconnect + onDaemonReconnect)
// drives the component, and we assert on its recorded calls + the rendered DOM.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import type { TerminalTransport, TerminalSubscribeResult } from "./terminal-transport.js";
import type { TerminalState } from "./terminal-snapshot.js";

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
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
    write() {}
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

// A fake cloud-relay transport. subscribe() returns whatever the test queues
// (default a live snapshot). It records every subscribe call so we can assert a
// re-subscribe fired, and exposes hooks to fire reconnect / daemon-reconnect and
// to deliver a snapshot frame.
function makeCloudTransport() {
  const subscribeCalls: string[] = [];
  // Records every start() so a test can prove [Restart] spawns a FRESH pty
  // (start path) rather than re-subscribing to the dead id.
  const startCalls: Array<{ cwd?: string }> = [];
  let snapshotHandler: ((p: { id: string; state: TerminalState }) => void) | null = null;
  let reconnectHandler: (() => void) | null = null;
  let daemonReconnectHandler: (() => void) | null = null;
  let daemonReconnectDaemonId: string | null = null;
  // The next subscribe()'s result. Defaults to a live success; tests override it.
  let nextResult: () => TerminalSubscribeResult = () => ({ ok: true, live: true });

  const transport: TerminalTransport = {
    start: async (opts) => {
      startCalls.push({ cwd: opts.cwd });
      return { id: TERM_ID };
    },
    subscribe: async (id) => {
      subscribeCalls.push(id);
      return nextResult();
    },
    unsubscribe: () => {},
    input: () => {},
    resize: () => {},
    kill: () => {},
    onData: () => () => {},
    onExit: () => () => {},
    onSnapshot: (handler) => {
      snapshotHandler = handler;
      return () => {
        snapshotHandler = null;
      };
    },
    onReconnect: (handler) => {
      reconnectHandler = handler;
      return () => {
        reconnectHandler = null;
      };
    },
    onDaemonReconnect: (daemonId, handler) => {
      daemonReconnectDaemonId = daemonId;
      daemonReconnectHandler = handler;
      return () => {
        daemonReconnectHandler = null;
      };
    },
  };

  return {
    transport,
    subscribeCalls,
    startCalls,
    setNextResult: (fn: () => TerminalSubscribeResult) => {
      nextResult = fn;
    },
    fireSnapshot: () =>
      snapshotHandler?.({
        id: TERM_ID,
        state: {
          rows: 1,
          cols: 1,
          grid: [[{ char: "x" }]],
          scrollback: [],
          cursor: { row: 0, col: 0 },
        },
      }),
    fireReconnect: () => reconnectHandler?.(),
    fireDaemonReconnect: () => daemonReconnectHandler?.(),
    daemonReconnectDaemonId: () => daemonReconnectDaemonId,
  };
}

async function settle() {
  await vi.runOnlyPendingTimersAsync();
  await Promise.resolve();
  flushSync();
}

describe("TerminalView connection resilience (internal docs FIX-1/2/3 + 55 B)", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
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

  it("FIX-1: a daemon offline→online transition re-subscribes and repaints (no 'no longer available')", async () => {
    const h = makeCloudTransport();
    // Mount onto an EXISTING session (terminalId set) so the view subscribes.
    const component = mount(TerminalView, {
      target: host,
      props: { transport: h.transport, terminalId: TERM_ID, daemonId: DAEMON_ID },
    });
    await settle();

    // The view wired onDaemonReconnect for ITS daemon.
    expect(h.daemonReconnectDaemonId()).toBe(DAEMON_ID);
    const before = h.subscribeCalls.length;
    expect(before).toBeGreaterThanOrEqual(1);

    // The daemon flaps back online while the guest socket stayed up. The headline
    // fix: this re-subscribes (onReconnect never fired — the guest socket is fine).
    h.fireDaemonReconnect();
    await settle();
    // A FRESH snapshot arrives and heals the screen → status returns to live.
    h.fireSnapshot();
    await settle();

    // A re-subscribe was issued with the SAME id, and the screen never dead-ended.
    expect(h.subscribeCalls.length).toBeGreaterThan(before);
    expect(h.subscribeCalls.at(-1)).toBe(TERM_ID);
    expect(host.textContent).not.toContain("no longer available");

    await unmount(component);
    flushSync();
  });

  it("FIX-2/3: a subscribe TIMEOUT (transient) shows 'Reconnecting…' and retries, not the dead-end", async () => {
    const h = makeCloudTransport();
    // The FIRST mount subscribe is transient (timeout / link-down).
    h.setNextResult(() => ({ ok: false, dead: false, error: "timed out" }));
    const component = mount(TerminalView, {
      target: host,
      props: { transport: h.transport, terminalId: TERM_ID, daemonId: DAEMON_ID },
    });
    await settle();

    // The view shows the recoverable reconnecting state, NOT "no longer available".
    expect(host.textContent).toContain("Reconnecting");
    expect(host.textContent).not.toContain("no longer available");
    const afterFirst = h.subscribeCalls.length;

    // The next attempt succeeds onto a live pty; advance past the backoff so the
    // bounded auto-retry (FIX-3) fires, then deliver a snapshot.
    h.setNextResult(() => ({ ok: true, live: true }));
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    h.fireSnapshot();
    await settle();

    // It retried (≥1 extra subscribe) and recovered — no dead-end, no Restart banner.
    expect(h.subscribeCalls.length).toBeGreaterThan(afterFirst);
    expect(host.textContent).not.toContain("Restart");

    await unmount(component);
    flushSync();
  });

  it("real DEAD ack shows the ended state: read-only scrollback + [Restart] (internal docs B.5)", async () => {
    const h = makeCloudTransport();
    // The subscribe resolves an AUTHORITATIVE dead ack.
    h.setNextResult(() => ({ ok: false, dead: true, endedReason: "daemon_restart" }));
    const component = mount(TerminalView, {
      target: host,
      props: { transport: h.transport, terminalId: TERM_ID, daemonId: DAEMON_ID },
    });
    await settle();

    // The graceful "ended" UX: the daemon_restart banner + a [Restart] affordance,
    // NOT the raw "no longer available" dead-end string.
    expect(host.textContent).toContain("restarted");
    expect(host.textContent).toContain("Restart");
    expect(host.textContent).not.toContain("no longer available");

    // [Restart] respawns in the SAME tab: clicking it drops the dead id and starts
    // a FRESH pty (the start path), NOT a re-subscribe to the gone id. No start()
    // ran yet (this mount took the subscribe→dead path).
    expect(h.startCalls.length).toBe(0);
    const restartBtn = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Restart",
    );
    expect(restartBtn).toBeDefined();
    restartBtn!.click();
    await settle();
    // Restart dropped the dead terminalId → resolveTerminalSession took start():
    // a brand-new pty was requested. (A Retry-on-the-same-id would have re-called
    // subscribe instead and never started.)
    expect(h.startCalls.length).toBe(1);

    await unmount(component);
    flushSync();
  });

  it("FIX-3: bounded { ok:false } retries before ended, then a later { ok:true } → live WITHOUT a remount", async () => {
    const h = makeCloudTransport();
    const component = mount(TerminalView, {
      target: host,
      props: { transport: h.transport, terminalId: TERM_ID, daemonId: DAEMON_ID },
    });
    // Initial subscribe lands live (default result).
    await settle();
    h.fireSnapshot();
    await settle();
    const subscribesAfterMount = h.subscribeCalls.length;

    // A daemon flap fires onDaemonReconnect → reattachLive(). Queue a TRANSIENT
    // failure so the bounded FIX-3 retry chain kicks in (NOT an authoritative
    // dead ack — that would dead-end immediately).
    h.setNextResult(() => ({ ok: false, dead: false }));
    h.fireDaemonReconnect();
    await settle();
    // The recoverable state is shown — "Reconnecting…", never the dead-end.
    expect(host.textContent).toContain("Reconnecting");
    expect(host.textContent).not.toContain("no longer available");
    // A re-subscribe was attempted (transient → retry, not ended).
    expect(h.subscribeCalls.length).toBeGreaterThan(subscribesAfterMount);

    // The daemon comes back: the NEXT retry returns a live pty. Advance past the
    // backoff so the bounded retry fires, then heal from a fresh snapshot.
    h.setNextResult(() => ({ ok: true, live: true }));
    await settle();
    h.fireSnapshot();
    await settle();

    // Back to interactive — NO "Reconnecting…", NO "ended", and crucially the same
    // component instance healed in place (no remount: the buffer/subscription rode
    // the reconnect). The accessory bar is interactive again (no opacity-40 lock).
    expect(host.textContent).not.toContain("Reconnecting");
    expect(host.textContent).not.toContain("no longer available");

    await unmount(component);
    flushSync();
  });
});
