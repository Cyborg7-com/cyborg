// @vitest-environment jsdom
//
// Cold-start subscribe race (confirmed 2026-06-21 via CDP against the live app).
// On app reopen the daemon re-attaches to the detached pty-host ASYNCHRONOUSLY; a
// (re)subscribe that lands before the pty is surfaced returns live:true but the
// daemon replays NO ring — the screen paints blank with no error and nothing
// re-pushes (the guest socket stayed open, so onReconnect/onDaemonReconnect never
// fire). TerminalView heals it with a bounded blank watchdog: if no output paints
// within the window it re-subscribes, until output arrives or the cap is reached.
//
// xterm + fit are mocked (no canvas in jsdom); a fake transport drives subscribe +
// onData, records subscribe calls, and lets the test deliver output frames.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import type { TerminalTransport, TerminalSubscribeResult } from "./terminal-transport.js";

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

function makeTransport() {
  const subscribeCalls: string[] = [];
  let dataHandler: ((p: { id: string; data: string }) => void) | null = null;
  let nextResult: () => TerminalSubscribeResult = () => ({ ok: true, live: true });

  const transport: TerminalTransport = {
    start: async () => ({ id: TERM_ID }),
    subscribe: async (id) => {
      subscribeCalls.push(id);
      return nextResult();
    },
    unsubscribe: () => {},
    input: () => {},
    resize: () => {},
    kill: () => {},
    onData: (handler) => {
      dataHandler = handler;
      return () => {
        dataHandler = null;
      };
    },
    onExit: () => () => {},
    onSnapshot: () => () => {},
    onReconnect: () => () => {},
    onDaemonReconnect: () => () => {},
  };

  return {
    transport,
    subscribeCalls,
    setNextResult: (fn: () => TerminalSubscribeResult) => {
      nextResult = fn;
    },
    fireData: (data: string) => dataHandler?.({ id: TERM_ID, data }),
  };
}

async function settle() {
  await vi.runOnlyPendingTimersAsync();
  await Promise.resolve();
  flushSync();
}

describe("TerminalView cold-start blank watchdog", () => {
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

  it("re-subscribes when a live subscribe lands blank (no output), then STOPS once output paints", async () => {
    const h = makeTransport();
    const component = mount(TerminalView, {
      target: host,
      props: { transport: h.transport, terminalId: TERM_ID, daemonId: DAEMON_ID },
    });
    await settle();

    // Subscribe landed live, but the daemon replayed NO output (cold-start race).
    const afterMount = h.subscribeCalls.length;
    expect(afterMount).toBeGreaterThanOrEqual(1);

    // The blank watchdog window elapses → it re-subscribes to re-pull the ring.
    await vi.advanceTimersByTimeAsync(1600);
    await settle();
    expect(h.subscribeCalls.length).toBeGreaterThan(afterMount);

    // The (now warm) daemon finally replays output → the watchdog must disarm.
    h.fireData("\x1b[2J\x1b[H$ ready\r\n");
    await settle();
    const afterOutput = h.subscribeCalls.length;

    // No more re-subscribes once output has painted, even after several windows.
    await vi.advanceTimersByTimeAsync(6000);
    await settle();
    expect(h.subscribeCalls.length).toBe(afterOutput);

    await unmount(component);
    flushSync();
  });

  it("never re-subscribes when the first subscribe already delivers output", async () => {
    const h = makeTransport();
    const component = mount(TerminalView, {
      target: host,
      props: { transport: h.transport, terminalId: TERM_ID, daemonId: DAEMON_ID },
    });
    await settle();
    // Output paints immediately (warm daemon) — the watchdog must never fire.
    h.fireData("hello world\r\n");
    await settle();
    const baseline = h.subscribeCalls.length;

    await vi.advanceTimersByTimeAsync(6000);
    await settle();
    expect(h.subscribeCalls.length).toBe(baseline);

    await unmount(component);
    flushSync();
  });

  it("bounds the blank re-subscribe retries (does not loop forever on a truly empty pty)", async () => {
    const h = makeTransport();
    const component = mount(TerminalView, {
      target: host,
      props: { transport: h.transport, terminalId: TERM_ID, daemonId: DAEMON_ID },
    });
    await settle();
    const afterMount = h.subscribeCalls.length;

    // Output never arrives. Advance well past the full retry budget.
    await vi.advanceTimersByTimeAsync(1600 * 12);
    await settle();
    const total = h.subscribeCalls.length - afterMount;
    // Capped (BLANK_REATTACH_ATTEMPTS = 8) — bounded, not unbounded.
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(8);

    await unmount(component);
    flushSync();
  });
});
