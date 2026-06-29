// @vitest-environment jsdom
//
// #48 mobile→desktop reflow × soft-keyboard responsiveness (hardening regression).
//
// The reflow branch in writeOutput reproduces a re-attach history frame at its CAPTURE
// width, then resizes xterm back to the current width so xterm reflows the buffer. While
// that is in flight `reflowingHistory` is true and fitAndResize early-returns so a
// container re-fit can't resize xterm out from under the replay.
//
// THE RACE this guards: real @xterm/xterm flushes its write buffer ASYNCHRONOUSLY, so a
// large scrollback blob keeps reflowingHistory=true for a real window of time. On MOBILE
// the soft keyboard opening DURING that window fires visualViewport resize/scroll →
// applyViewportHeight → fitSoon — but fitAndResize is gated off, so that keyboard fit is
// DROPPED. fitSoon does not self-re-arm and the reflow's resize-back restores the STALE
// pre-keyboard geometry (and sends no pty resize), so without the hardening xterm + the
// pty are left mis-sized under the keyboard until the next user gesture.
//
// The hardening: the reflow write callback, after clearing reflowingHistory and resizing
// back, calls fitSoon() + scrollTerminalToBottom() so the dropped fit is replayed against
// the TRUE current container geometry and the prompt is re-pinned above the keyboard.
//
// This suite deliberately DEFERS the write callback (queueMicrotask) to model the async
// parse window the existing history-reflow suite hides by calling the callback
// synchronously — that is the only place this race is observable.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import type { TerminalTransport } from "./terminal-transport.js";

// Recorded across all instances for assertions.
const writes: string[] = [];
const resizes: Array<[number, number]> = [];
const fitCalls: { n: number } = { n: 0 };
const scrollCalls: { n: number } = { n: 0 };
// Pending write callbacks held until the test chooses to drain them — this is how we
// keep reflowingHistory=true across a simulated keyboard event (the real async window).
let pendingWriteCbs: Array<() => void> = [];

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
    // Mirror xterm's write(data, cb?). The reflow's callback is HELD (not invoked) so the
    // test can keep reflowingHistory=true across a simulated keyboard event, then drain it
    // explicitly with drainWrites() — modelling xterm's async write-buffer flush. (Real
    // xterm flushes via a queued task; we hold it manually so fake-timer advances do not
    // accidentally flush it before we want.)
    write(data: string, cb?: () => void) {
      writes.push(data);
      if (typeof cb === "function") pendingWriteCbs.push(cb);
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      resizes.push([cols, rows]);
    }
    scrollToBottom() {
      scrollCalls.n++;
    }
    focus() {}
    reset() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {
      fitCalls.n++;
    }
  },
}));

import TerminalView from "./TerminalView.svelte";

const TERM_ID = "term-1";

function makeCloudTransport() {
  let onDataHandler:
    | ((p: { id: string; data: string; replayCols?: number; replayRows?: number }) => void)
    | null = null;
  const resizeCalls: Array<[string, number, number]> = [];
  const transport: TerminalTransport = {
    start: async () => ({ id: TERM_ID }),
    input: () => {},
    resize: (id: string, cols: number, rows: number) => {
      resizeCalls.push([id, cols, rows]);
    },
    kill: () => {},
    subscribe: async () => ({ ok: true, live: true }),
    unsubscribe: () => {},
    onSnapshot: () => () => {},
    onData: (handler) => {
      onDataHandler = handler;
      return () => {};
    },
    onExit: () => () => {},
  };
  return {
    transport,
    resizeCalls,
    fire: (data: string, replayCols?: number, replayRows?: number) =>
      onDataHandler?.({ id: TERM_ID, data, replayCols, replayRows }),
  };
}

// Give EVERY element a real layout box so canFitContainer() passes (jsdom reports 0×0 /
// null offsetParent, which would make fitAndResize bail before fit()). This is the
// mobile-visible-pane case the hardening must re-fit.
function stubLayoutBox(): void {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return document.body;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return 390; // a phone width
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return 600;
    },
  });
}

// A mobile soft-keyboard environment: coarse pointer (so softKeyboardSizing() is true)
// + a visualViewport stub that records listeners so we can fire a keyboard "resize".
function installMobileViewport(): {
  fireResize: () => void;
  setHeight: (h: number) => void;
} {
  const listeners: Record<string, Array<() => void>> = { resize: [], scroll: [] };
  const vv = {
    height: 600,
    width: 390,
    offsetTop: 0,
    addEventListener: (type: string, fn: () => void) => {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      const arr = listeners[type];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    },
  };
  (globalThis as unknown as { visualViewport: unknown }).visualViewport = vv;
  (window as unknown as { visualViewport: unknown }).visualViewport = vv;
  window.matchMedia = ((q: string) => ({
    matches: q.includes("coarse"),
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent() {
      return false;
    },
  })) as unknown as typeof window.matchMedia;
  return {
    fireResize: () => {
      for (const fn of listeners.resize ?? []) fn();
    },
    setHeight: (h: number) => {
      vv.height = h;
    },
  };
}

// Invoke and clear every held write callback (the reflow resize-back + hardening run
// here) — models xterm finishing its async parse of the history blob.
function drainWrites(): void {
  const cbs = pendingWriteCbs;
  pendingWriteCbs = [];
  for (const cb of cbs) cb();
}

async function settle() {
  await vi.runOnlyPendingTimersAsync();
  await Promise.resolve();
  flushSync();
}

describe("#48 reflow × mobile soft-keyboard responsiveness", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    writes.length = 0;
    resizes.length = 0;
    fitCalls.n = 0;
    scrollCalls.n = 0;
    pendingWriteCbs = [];
    vi.useFakeTimers();
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    stubLayoutBox();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    vi.useRealTimers();
    host.remove();
    (globalThis as unknown as { visualViewport: unknown }).visualViewport = null;
  });

  it("re-fits after a keyboard resize that lands DURING the async reflow window", async () => {
    const viewport = installMobileViewport();
    const { transport, resizeCalls, fire } = makeCloudTransport();
    const component = mount(TerminalView, {
      target: host,
      props: { transport, terminalId: TERM_ID },
    });
    await settle();
    // Isolate the reflow + keyboard interaction from attach-time bookkeeping.
    resizes.length = 0;
    writes.length = 0;
    fitCalls.n = 0;
    scrollCalls.n = 0;
    resizeCalls.length = 0;

    // Reopen a session captured NARROW (40×20) into the current 80×24 xterm → reflow.
    // The write callback is deferred (queueMicrotask), so reflowingHistory stays true.
    const history = "\x1b[H\x1b[2J\x1b[3Jnarrow mobile scrollback";
    fire(history, 40, 20);
    flushSync();

    // Reproduced at the capture width first; the history bytes are written; the deferred
    // callback (the resize-back) has NOT run yet — we are inside the reflow window.
    expect(resizes[0]).toEqual([40, 20]);
    expect(writes).toContain(history);
    expect(pendingWriteCbs.length).toBe(1);

    // The soft keyboard opens DURING the window: viewport shrinks + fires resize. This
    // schedules a fit via scheduleViewportSync(rAF) → applyViewportHeight → fitSoon, but
    // fitAndResize is gated off by reflowingHistory, so this fit is DROPPED.
    viewport.setHeight(320);
    viewport.fireResize();
    // Drain the rAF (scheduleViewportSync → applyViewportHeight, which arms fitSoon) AND
    // the 60ms fitSoon debounce WHILE still inside the reflow window (write cb not yet
    // drained). The keyboard fit therefore fires into fitAndResize's reflowingHistory
    // early-return and is CONSUMED-then-DROPPED — fitSoon is a single timer that does not
    // re-arm itself, so nothing is left pending from the keyboard path.
    await vi.advanceTimersByTimeAsync(100);
    expect(pendingWriteCbs.length).toBe(1); // still mid-reflow: the drop really happened
    const fitsDuringWindow = fitCalls.n;

    // Now drain the deferred write callback (the blob finished parsing): reflowingHistory
    // clears, xterm resizes back, and the HARDENING runs fitSoon() + scrollToBottom().
    drainWrites();
    flushSync();
    // Advance past the 60ms fitSoon debounce so the REPLAYED (hardening) fit lands. Only
    // the callback's fitSoon can produce a fit now — the keyboard's was already dropped.
    await vi.advanceTimersByTimeAsync(100);

    // The widen-back to the captured current geometry happened.
    expect(resizes).toContainEqual([80, 24]);
    // The DROPPED keyboard fit was replayed AFTER the reflow window: fitAddon.fit() ran
    // again against the live container, and the pty resize was re-sent. Without the
    // hardening this count would not increase past the (gated) window.
    expect(fitCalls.n).toBeGreaterThan(fitsDuringWindow);
    expect(resizeCalls.length).toBeGreaterThan(0);
    expect(resizeCalls[resizeCalls.length - 1]).toEqual([TERM_ID, 80, 24]);
    // The prompt was re-pinned to the bottom so a re-wrapped buffer can't hide it behind
    // the keyboard.
    expect(scrollCalls.n).toBeGreaterThan(0);

    await unmount(component);
    flushSync();
  });

  it("does not wedge: a second reflow after a keyboard fit still completes", async () => {
    const viewport = installMobileViewport();
    const { transport, fire } = makeCloudTransport();
    const component = mount(TerminalView, {
      target: host,
      props: { transport, terminalId: TERM_ID },
    });
    await settle();
    resizes.length = 0;
    writes.length = 0;
    fitCalls.n = 0;

    // First reflow + keyboard event, fully drained.
    fire("\x1b[2Jfirst", 40, 20);
    flushSync();
    viewport.fireResize();
    await vi.advanceTimersByTimeAsync(100); // keyboard fit dropped inside the window
    drainWrites(); // reflow completes → hardening replays the fit
    flushSync();
    await vi.advanceTimersByTimeAsync(100);
    const fitsAfterFirst = fitCalls.n;
    expect(fitsAfterFirst).toBeGreaterThan(0);

    // reflowingHistory must be cleared — a second reflow must still run its sandwich and
    // a subsequent fit must NOT be gated off (proves the flag did not wedge true).
    resizes.length = 0;
    fire("\x1b[2Jsecond", 30, 18);
    flushSync();
    expect(resizes[0]).toEqual([30, 18]);
    drainWrites();
    flushSync();
    await vi.advanceTimersByTimeAsync(100);
    expect(resizes).toContainEqual([80, 24]);
    expect(fitCalls.n).toBeGreaterThan(fitsAfterFirst);

    await unmount(component);
    flushSync();
  });
});
