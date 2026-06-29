// @vitest-environment jsdom
//
// TerminalView lifecycle wiring for the session-lifecycle model (internal docs,
// internal docs P0b). Proves the behavior the daemon depends on:
//   teardown (unmount WITHOUT an explicit close) UNSUBSCRIBES the live session —
//   it sends cyborg:unsubscribe_terminal and NEVER cyborg:kill_terminal, so the
//   pty survives for re-subscribe (#738/#762) but the daemon drops this view's
//   viewer (and its Paseo subscription). No heartbeat is sent — the daemon reaper
// keys off pty liveness, not a keep-alive ping (internal docs P0b deleted it).
//
// xterm + the fit addon are mocked (no real canvas in jsdom); the component drives
// a fake TerminalTransport whose calls we assert.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import type { TerminalTransport } from "./terminal-transport.js";

// ── Mock the heavy xterm deps: a Terminal that records nothing but satisfies the
// component's calls (open/loadAddon/onData/write/focus/dispose/reset + cols/rows).
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    // makeReadOnly() flips options.disableStdin; tests assert it (internal docs B.5).
    options: { disableStdin?: boolean } = {};
    // writeOutput() reads buffer.active.type only when prediction is on; provide a
    // stable shape so it never throws under the cloud-relay transport.
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

// A fake transport that records the control calls we assert on. start() resolves
// a fixed live pty id so the component reaches the "started" state and heartbeats.
function makeTransport() {
  const calls: { type: string; id?: string; attachId?: string }[] = [];
  let onExitHandler: ((p: { id: string; exitCode: number }) => void) | null = null;
  const transport: TerminalTransport = {
    start: async () => {
      calls.push({ type: "start" });
      return { id: "term-1" };
    },
    input: () => {},
    resize: () => {},
    kill: (id) => {
      calls.push({ type: "kill", id });
    },
    unsubscribe: (id, attachId) => {
      calls.push({ type: "unsubscribe", id, attachId });
    },
    onData: () => () => {},
    onExit: (handler) => {
      onExitHandler = handler;
      return () => {};
    },
  };
  return {
    transport,
    calls,
    fireExit: (code: number) => onExitHandler?.({ id: "term-1", exitCode: code }),
  };
}

describe("TerminalView lifecycle (internal docs GAP-1, internal docs P0b)", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom lacks these; the component observes/uses them on mount.
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    vi.useRealTimers();
    host.remove();
  });

  it("teardown on unmount UNSUBSCRIBES the live session and never kills it", async () => {
    const { transport, calls } = makeTransport();
    const component = mount(TerminalView, { target: host, props: { transport } });
    // Let the dynamic import + start() resolve, then flush reactive effects.
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    flushSync();

    await unmount(component);
    flushSync();

    const unsub = calls.find((c) => c.type === "unsubscribe");
    expect(unsub).toBeDefined();
    expect(unsub!.id).toBe("term-1");
    // A per-mount attachId was minted and carried into the unsubscribe.
    expect(typeof unsub!.attachId).toBe("string");
    expect(unsub!.attachId!.length).toBeGreaterThan(0);
    // unsubscribe is NOT kill — the pty must survive for re-subscribe (#738/#762).
    expect(calls.some((c) => c.type === "kill")).toBe(false);
  });

  it("never sends a heartbeat (the daemon reaper keys off pty liveness, not a ping)", async () => {
    const { transport, calls } = makeTransport();
    const component = mount(TerminalView, { target: host, props: { transport } });
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    flushSync();

    // Advance well past the old heartbeat cadence — no keep-alive frame is ever sent.
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.some((c) => c.type === "heartbeat")).toBe(false);

    await unmount(component);
    flushSync();
  });

  it("a process exit before unmount means no unsubscribe is sent (the pty is already gone)", async () => {
    const { transport, calls, fireExit } = makeTransport();
    const component = mount(TerminalView, { target: host, props: { transport } });
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    flushSync();

    // The shell exits on its own → sessionId clears in the onExit handler.
    fireExit(0);
    flushSync();

    await unmount(component);
    flushSync();
    // No unsubscribe (sessionId was null at teardown) and never a kill.
    expect(calls.some((c) => c.type === "unsubscribe")).toBe(false);
    expect(calls.some((c) => c.type === "kill")).toBe(false);
  });
});
