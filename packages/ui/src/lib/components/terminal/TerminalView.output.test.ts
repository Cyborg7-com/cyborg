// @vitest-environment jsdom
//
// #793 regression — output must NEVER be swallowed. The ghost-text predictor
// routed ALL pty output through reconcile() in writeOutput(); on the cloud relay
// (subscribe + onSnapshot present) the gate was ALWAYS on, and reconcile returned
// an empty/partial `write` for normal output, freezing the terminal after the
// initial snapshot ("I type and nothing appears"). The fix forces predictionEnabled
// to false so writeOutput takes the pass-through `term.write(data)` path with the
// FULL authoritative output.
//
// This test drives a fake cloud-relay transport (subscribe + onSnapshot) — the
// exact shape that previously enabled prediction — fires an authoritative output
// frame, and asserts the FULL data reaches term.write. It must pass whether or not
// ghost text is ever re-enabled (the invariant is "the full data reaches xterm").
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import type { TerminalTransport } from "./terminal-transport.js";

// Capture every term.write across all Terminal instances the component creates.
const writes: string[] = [];

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

// A fake CLOUD-RELAY transport: it exposes subscribe() + onSnapshot, the exact
// shape that previously turned the predictor ON. We capture the onData handler so a
// test can push an authoritative output frame at the live session id.
function makeCloudTransport() {
  let onDataHandler: ((p: { id: string; data: string }) => void) | null = null;
  const transport: TerminalTransport = {
    start: async () => ({ id: "term-1" }),
    input: () => {},
    resize: () => {},
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
    fireData: (data: string) => onDataHandler?.({ id: "term-1", data }),
  };
}

describe("#793 regression — writeOutput delivers the FULL output to xterm", () => {
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

  it("a plain output frame reaches term.write VERBATIM under a cloud-relay transport", async () => {
    const { transport, fireData } = makeCloudTransport();
    const component = mount(TerminalView, { target: host, props: { transport } });
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    flushSync();

    const output = "hello\r\n$ ";
    fireData(output);
    flushSync();

    // The full output must appear among the writes — not dropped, not truncated.
    expect(writes).toContain(output);

    await unmount(component);
    flushSync();
  });

  it("a multi-line output frame is not partially swallowed", async () => {
    const { transport, fireData } = makeCloudTransport();
    const component = mount(TerminalView, { target: host, props: { transport } });
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    flushSync();

    const output = "line1\r\nline2\r\nline3\r\n$ ";
    fireData(output);
    flushSync();

    expect(writes).toContain(output);

    await unmount(component);
    flushSync();
  });
});
