// @vitest-environment jsdom
//
// #48 mobile→desktop terminal garble. When you reopen an old terminal (after an app
// restart, or a session last used at a NARROW mobile width) on a WIDER desktop window,
// the daemon replays the saved scrollback as RAW pty bytes captured at the OLD width.
// Written straight into an xterm now sized to the new width, those bytes — whose wrap
// points and cursor moves assume the old width — desync: rows overlap/mis-wrap and
// scroll dies.
//
// The fix: the daemon tags the history-replay frame with the width its bytes were
// captured at (`replayCols`/`replayRows`). The view reproduces them at THAT width
// first, then resizes xterm back to the current width so xterm's native reflow
// re-wraps the whole buffer to fit — exactly what a real terminal does on a window
// resize. These tests drive a cloud-relay transport, fire a tagged history frame, and
// assert the resize→write→resize sandwich (and that it no-ops when widths match).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import type { TerminalTransport } from "./terminal-transport.js";

// Capture every term.write and term.resize across all Terminal instances.
const writes: string[] = [];
const resizes: Array<[number, number]> = [];

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
    // Mirror xterm's write(data, callback?) — the reflow resizes back IN the callback,
    // so the double-arg form must be honored or the sandwich never completes.
    write(data: string, cb?: () => void) {
      writes.push(data);
      if (typeof cb === "function") cb();
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      resizes.push([cols, rows]);
    }
    scrollToBottom() {}
    focus() {}
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

// A cloud-relay transport (subscribe + onSnapshot present) so the view takes the
// (re)subscribe attach path — the path a reopened terminal uses. `fire` pushes an
// onData frame; the history frame carries the capture dims.
function makeCloudTransport() {
  let onDataHandler:
    | ((p: { id: string; data: string; replayCols?: number; replayRows?: number }) => void)
    | null = null;
  const transport: TerminalTransport = {
    start: async () => ({ id: TERM_ID }),
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
    fire: (data: string, replayCols?: number, replayRows?: number) =>
      onDataHandler?.({ id: TERM_ID, data, replayCols, replayRows }),
  };
}

async function settle() {
  await vi.runOnlyPendingTimersAsync();
  await Promise.resolve();
  flushSync();
}

describe("#48 history-replay reflow (mobile→desktop)", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    writes.length = 0;
    resizes.length = 0;
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

  it("reproduces history at the CAPTURE width first, then resizes back to reflow", async () => {
    const { transport, fire } = makeCloudTransport();
    const component = mount(TerminalView, {
      target: host,
      props: { transport, terminalId: TERM_ID },
    });
    await settle();
    // Ignore any attach-time bookkeeping; isolate the reflow sandwich.
    resizes.length = 0;
    writes.length = 0;

    // xterm is 80×24; the replay was captured at 40×20 (a narrow mobile session).
    const history = "\x1b[H\x1b[2J\x1b[3Jnarrow mobile scrollback";
    fire(history, 40, 20);
    flushSync();

    // 1) reproduced at the capture width BEFORE anything else
    expect(resizes[0]).toEqual([40, 20]);
    // 2) the authoritative history bytes were written verbatim
    expect(writes).toContain(history);
    // 3) widened back to the current geometry so xterm reflows the buffer
    expect(resizes[resizes.length - 1]).toEqual([80, 24]);

    await unmount(component);
    flushSync();
  });

  it("does NOT reflow when the capture width already matches the current width", async () => {
    const { transport, fire } = makeCloudTransport();
    const component = mount(TerminalView, {
      target: host,
      props: { transport, terminalId: TERM_ID },
    });
    await settle();
    resizes.length = 0;
    writes.length = 0;

    // Same-width re-attach (a WS blip): no reflow needed, just write the history.
    const history = "\x1b[H\x1b[2J\x1b[3Jsame-width scrollback";
    fire(history, 80, 24);
    flushSync();

    expect(resizes).toEqual([]);
    expect(writes).toContain(history);

    await unmount(component);
    flushSync();
  });

  it("a live output frame (no capture dims) writes normally with no resize", async () => {
    const { transport, fire } = makeCloudTransport();
    const component = mount(TerminalView, {
      target: host,
      props: { transport, terminalId: TERM_ID },
    });
    await settle();
    resizes.length = 0;
    writes.length = 0;

    fire("$ ls -la\r\n");
    flushSync();

    expect(resizes).toEqual([]);
    expect(writes).toContain("$ ls -la\r\n");

    await unmount(component);
    flushSync();
  });
});
