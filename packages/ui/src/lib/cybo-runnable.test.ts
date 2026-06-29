import { describe, it, expect } from "vitest";
import {
  isCyboRunnable,
  shouldProbeCliStatus,
  FOCUS_REPROBE_MIN_INTERVAL_MS,
  shouldReprobeOnFocus,
} from "./cybo-runnable.js";

describe("isCyboRunnable", () => {
  it("is false with no online daemon, even if installed", () => {
    expect(isCyboRunnable(0, false, true)).toBe(false);
    expect(isCyboRunnable(0, true, true)).toBe(false);
  });

  it("is true when the provider snapshot reports pi available", () => {
    expect(isCyboRunnable(1, true, false)).toBe(true);
  });

  // The reported bug: snapshot lags a fresh install (pi still unavailable), but the
  // direct cybo --version / install confirms it — the banner must NOT claim "isn't
  // installed".
  it("is true when installed-here even though the snapshot still says unavailable", () => {
    expect(isCyboRunnable(1, false, true)).toBe(true);
  });

  it("is false when genuinely not installed and the snapshot agrees", () => {
    expect(isCyboRunnable(1, false, false)).toBe(false);
  });
});

describe("shouldProbeCliStatus", () => {
  const base = {
    onCyboTab: true,
    shownDaemonOnline: true,
    shownDaemonId: "d1",
    cliLoadedFor: null as string | null,
  };

  it("probes on a cybo tab for an online, not-yet-loaded daemon", () => {
    expect(shouldProbeCliStatus(base)).toBe(true);
  });

  // The fix: it probes in the ROSTER too (caller passes onCyboTab for "cybos"|"daemon").
  it("does NOT probe on an unrelated tab", () => {
    expect(shouldProbeCliStatus({ ...base, onCyboTab: false })).toBe(false);
  });

  // Cache / no-loop: once the shown daemon is loaded, returning to the pane or
  // switching sub-tabs must NOT re-probe.
  it("does NOT re-probe a daemon that is already loaded", () => {
    expect(shouldProbeCliStatus({ ...base, cliLoadedFor: "d1" })).toBe(false);
  });

  it("probes again after a daemon SWITCH (loaded for a different daemon)", () => {
    expect(shouldProbeCliStatus({ ...base, cliLoadedFor: "d-other" })).toBe(true);
  });

  it("never probes an offline daemon, or when none is shown", () => {
    expect(shouldProbeCliStatus({ ...base, shownDaemonOnline: false })).toBe(false);
    expect(shouldProbeCliStatus({ ...base, shownDaemonId: null })).toBe(false);
  });
});

// Focus-driven re-probe (external `cybo login` heal): user-driven + throttled,
// so a stuck "needs setup" banner heals on returning to the app without loops.
describe("shouldReprobeOnFocus", () => {
  const base = {
    onCyboTab: true,
    shownDaemonOnline: true,
    shownDaemonId: "d1",
    lastProbeAt: null,
    now: 100_000,
  };

  it("first focus on an eligible pane probes", () => {
    expect(shouldReprobeOnFocus(base)).toBe(true);
  });

  it("throttles: a focus within the interval does NOT re-probe", () => {
    expect(
      shouldReprobeOnFocus({ ...base, lastProbeAt: base.now - FOCUS_REPROBE_MIN_INTERVAL_MS + 1 }),
    ).toBe(false);
  });

  it("re-probes once the interval elapsed", () => {
    expect(
      shouldReprobeOnFocus({ ...base, lastProbeAt: base.now - FOCUS_REPROBE_MIN_INTERVAL_MS }),
    ).toBe(true);
  });

  it("never probes off the cybo tabs, offline daemons, or without a daemon", () => {
    expect(shouldReprobeOnFocus({ ...base, onCyboTab: false })).toBe(false);
    expect(shouldReprobeOnFocus({ ...base, shownDaemonOnline: false })).toBe(false);
    expect(shouldReprobeOnFocus({ ...base, shownDaemonId: null })).toBe(false);
  });
});
