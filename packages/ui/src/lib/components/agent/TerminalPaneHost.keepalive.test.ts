// Tab-change keep-alive (internal docs Layer 1) with a BOUNDED renderer
// footprint (internal docs §#10 — the "kills the Mac" RAM fix). A terminal "tab"
// is a SvelteKit route (/workspace/<ws>/terminal/<id>); switching away used to
// UNMOUNT the live TerminalView. PR #818 fixed that by keeping every pane MOUNTED
// across tab switches (display:none, never unmount), so returning is INSTANT and
// stays `live` — a mounted pane stays FULLY LIVE (xterm + subscription intact).
// The only RAM concern is the UNBOUNDED count of mounted panes (the session list
// is uncapped + persisted). The host now keeps a small LRU of MOUNTED (live) panes
// and unmounts the rest; the daemon pty survives, so a pane beyond the cap
// re-attaches from the daemon snapshot on return.
//
// Two layers of proof (the host couples to $app/state, so it isn't mountable in
// the node-only UI unit harness — same constraint the #673 wiring test works
// around with a source guard):
//   1. UNIT — the pure policy helpers (terminal-pane-host.ts) decide which panes
//      mount (active + LRU, capped) and which is visible.
//   2. STRUCTURE — the .svelte template renders only the MOUNTED subset (the cap),
//      keeping every mounted pane live (display toggle, never an {#if} unmount).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeTerminalId,
  bumpLru,
  mountedTerminalIds,
  paneDisplay,
  hostDisplay,
  MAX_MOUNTED_PANES,
} from "./terminal-pane-host.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = "ws-1";

describe("terminal-pane-host visibility helpers (internal docs)", () => {
  it("activeTerminalId picks the routed terminal only on a terminal route in this workspace", () => {
    expect(activeTerminalId(`/workspace/${WS}/terminal/term-1`, { terminalId: "term-1" }, WS)).toBe(
      "term-1",
    );
    // A channel route → no active terminal (host hides, mounted panes survive).
    expect(activeTerminalId(`/workspace/${WS}/channel/c1`, {}, WS)).toBeNull();
    // A terminal route in a DIFFERENT workspace must not light up our pane.
    expect(
      activeTerminalId(`/workspace/other/terminal/term-1`, { terminalId: "term-1" }, WS),
    ).toBeNull();
    // No workspace yet → nothing active.
    expect(
      activeTerminalId(`/workspace/${WS}/terminal/term-1`, { terminalId: "term-1" }, undefined),
    ).toBeNull();
  });

  it("paneDisplay shows ONLY the active terminal; every other mounted pane is hidden", () => {
    expect(paneDisplay("term-1", "term-1")).toBe("block");
    // An inactive (but mounted) pane is display:none — hidden but still MOUNTED +
    // live (not removed), so returning to it is instant. This is the keep-alive
    // contract: hiding must never tear down a live xterm + daemon subscription.
    expect(paneDisplay("term-2", "term-1")).toBe("none");
    // When NO terminal route is active, every pane is hidden (mounted ones survive).
    expect(paneDisplay("term-1", null)).toBe("none");
    expect(paneDisplay("term-2", null)).toBe("none");
  });

  it("hostDisplay overlays only on a terminal route, hides (but keeps panes) elsewhere", () => {
    expect(hostDisplay("term-1")).toBe("flex");
    expect(hostDisplay(null)).toBe("none");
  });
});

describe("LRU mount policy (internal docs §#10 — RAM bound)", () => {
  it("bumpLru moves the active id to the front and de-dupes", () => {
    expect(bumpLru([], "a")).toEqual(["a"]);
    expect(bumpLru(["a", "b"], "b")).toEqual(["b", "a"]);
    expect(bumpLru(["b", "a"], "c")).toEqual(["c", "b", "a"]);
    // A null active (left the terminal area) leaves recency untouched.
    expect(bumpLru(["b", "a"], null)).toEqual(["b", "a"]);
  });

  it("always mounts the active terminal", () => {
    const ids = ["a", "b", "c"];
    expect(mountedTerminalIds(ids, "b", ["b"]).has("b")).toBe(true);
  });

  it("never mounts more than the cap, even with many sessions", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const lru = ids.toReversed();
    const mounted = mountedTerminalIds(ids, "t0", lru, MAX_MOUNTED_PANES);
    expect(mounted.size).toBe(MAX_MOUNTED_PANES);
    // The active one is always in.
    expect(mounted.has("t0")).toBe(true);
  });

  it("HYDRATE prune: a launch with N persisted sessions mounts at most the cap (no N xterms)", () => {
    // Cold start: no active route yet, no LRU. The host renders only the mounted
    // subset, so even 50 persisted sessions never spawn 50 xterms at startup.
    const ids = Array.from({ length: 50 }, (_, i) => `t${i}`);
    const mounted = mountedTerminalIds(ids, null, [], MAX_MOUNTED_PANES);
    expect(mounted.size).toBeLessThanOrEqual(MAX_MOUNTED_PANES);
  });

  it("fills remaining slots by recency after the active pane", () => {
    const ids = ["a", "b", "c", "d", "e"];
    // active=a, recently viewed b then c; cap 3 → {a, b, c}, NOT d/e.
    const mounted = mountedTerminalIds(ids, "a", ["a", "b", "c", "d", "e"], 3);
    expect(mounted.has("a")).toBe(true);
    expect(mounted.has("b")).toBe(true);
    expect(mounted.has("c")).toBe(true);
    expect(mounted.has("d")).toBe(false);
    expect(mounted.has("e")).toBe(false);
  });

  it("drops a stale LRU id whose session was removed", () => {
    // 'gone' is in the LRU but no longer a session → must not be mounted.
    const mounted = mountedTerminalIds(["a", "b"], "a", ["a", "gone", "b"], 4);
    expect(mounted.has("gone")).toBe(false);
    expect(mounted.has("a")).toBe(true);
    expect(mounted.has("b")).toBe(true);
  });

  it("never pre-mounts a never-visited session hidden (the black-terminal bug)", () => {
    // REGRESSION GUARD (2026-06-21): a pane mounted BEFORE it is ever the active
    // route opens its xterm against a 0×0 (display:none) element and consumes the
    // daemon's one-shot ring replay at zero geometry → black on show. So with no
    // active terminal and an empty LRU, NOTHING mounts; the session mounts on first
    // navigation, while VISIBLE, at correct geometry.
    expect(mountedTerminalIds(["solo"], null, [], 4).size).toBe(0);
    // Same rule when ON a terminal route: only the active pane mounts — its
    // siblings are NOT pre-warmed hidden (they'd hit the same 0×0 bug).
    const onRoute = mountedTerminalIds(["a", "b", "c"], "a", ["a"], 4);
    expect(onRoute.has("a")).toBe(true);
    expect(onRoute.has("b")).toBe(false);
    expect(onRoute.has("c")).toBe(false);
  });

  it("mounts a pane only once it has been the active (visible) terminal", () => {
    // First nav to "solo": it becomes active → mounts (visible). After leaving to a
    // channel (active=null) it stays mounted via the LRU (already opened visible, so
    // keep-alive is safe) — that's the ONLY way a pane is ever mounted while hidden.
    expect(mountedTerminalIds(["solo"], "solo", ["solo"], 4).has("solo")).toBe(true);
    expect(mountedTerminalIds(["solo"], null, ["solo"], 4).has("solo")).toBe(true);
  });
});

describe("TerminalPaneHost bounded keep-alive structure (internal docs §#10)", () => {
  const source = readFileSync(resolve(HERE, "TerminalPaneHost.svelte"), "utf8");

  it("renders only the MOUNTED subset (bounded), not every tracked session", () => {
    // {#each mountedSessions} (the capped subset), NOT {#each sessions} (all of
    // them) — the latter is exactly the unbounded-RAM regression #818 introduced.
    expect(source).toMatch(/\{#each\s+mountedSessions\s+as\s+session/);
    // No {#if} gating a pane on the active id (that would unmount inactive panes
    // we DO want kept warm within the cap).
    expect(source).not.toMatch(/\{#if[^}]*activeId/);
  });

  it("toggles pane visibility with `display` (hidden = mounted + still live), never unmounting", () => {
    // A hidden pane is display:none (still mounted + live) rather than removed.
    expect(source).toMatch(/style:display=\{paneDisplay\(/);
    expect(source).toMatch(/style:display=\{hostDisplay\(/);
    // The live emulator renders inside the keep-alive loop (one per mounted
    // session), so it survives navigation within the cap.
    expect(source).toMatch(/<TerminalSessionView/);
  });

  it("does NOT detach a hidden pane (no `active` prop): every mounted pane stays live", () => {
    // The "right-sized" contract: within the cap, a hidden pane keeps its xterm +
    // subscription so switching to it is instant — NO per-tab-switch detach. The
    // detach-on-hide `active` prop (the regression we removed) must not return.
    expect(source).not.toMatch(/active=\{session\.terminalId === activeId\}/);
    expect(source).not.toMatch(/\bactive=/);
  });

  it("each keep-alive pane fills its parent so a shown pane has nonzero size (sizing bug)", () => {
    expect(source).toMatch(/class="absolute inset-0 h-full w-full"/);
  });
});
