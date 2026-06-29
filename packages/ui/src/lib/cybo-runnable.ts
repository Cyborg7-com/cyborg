// "Can the workspace run cybos here?" reconciled across the TWO signals the agents
// pane has, which can disagree right after an install:
//
//  - `piAvailable` — from the daemon's PROVIDER SNAPSHOT (`pi` provider
//    `isAvailable()`), which probes the `pi` binary against the daemon process's
//    PATH/env captured at launch. After `npm i -g @cyborg7/cybo@latest` lands the
//    binary, this can keep reporting unavailable until the daemon restarts.
//  - `installedHere` — from the DIRECT `cybo --version` probe (cyboCliStatus) and
//    the install round-trip, which see the freshly-installed binary immediately.
//
// The bug: the "Cybo (PI) isn't installed" banner keyed only on `piAvailable`, so it
// stayed up — contradicting the "cybo X installed" success message — even though the
// install succeeded. Treat a confirmed install on an online daemon as runnable too.
export function isCyboRunnable(
  onlineDaemons: number,
  piAvailable: boolean,
  installedHere: boolean,
): boolean {
  return onlineDaemons > 0 && (piAvailable || installedHere);
}

// Whether to (re-)probe `cybo --version` for the shown daemon. The agents pane
// probes on load for EVERY sub-tab where the "isn't installed" banner / install CTA
// can appear (the cybos roster AND the daemon sub-tab) — not just "daemon", which
// was the bug (the roster never validated install state and showed a false banner).
// CACHED by daemon: returns false once `cliLoadedFor === shownDaemonId`, so leaving
// and returning to the pane / switching sub-tabs never re-probes (no loop) — only a
// daemon switch (or an explicit force re-probe, handled separately) triggers one.
// Never probes an offline daemon (the `cybo --version` RPC shells out on its host).
export function shouldProbeCliStatus(opts: {
  onCyboTab: boolean;
  shownDaemonOnline: boolean;
  shownDaemonId: string | null;
  cliLoadedFor: string | null;
}): boolean {
  const { onCyboTab, shownDaemonOnline, shownDaemonId, cliLoadedFor } = opts;
  return onCyboTab && shownDaemonOnline && !!shownDaemonId && cliLoadedFor !== shownDaemonId;
}

// Re-probe when the WINDOW regains focus — the external-login flow: the user
// ran `cybo login` in a terminal and came back to the app. Without this, the
// per-daemon cache above (correctly) suppresses re-probes forever, so a
// "needs setup" banner sticks until a full reload even though the runtime is
// now authenticated. Focus events are user-driven (no programmatic loop) and
// further throttled per daemon so a focus flurry probes at most once per
// interval.
export const FOCUS_REPROBE_MIN_INTERVAL_MS = 30_000;

export function shouldReprobeOnFocus(opts: {
  onCyboTab: boolean;
  shownDaemonOnline: boolean;
  shownDaemonId: string | null;
  // Last focus-driven probe for THIS daemon (epoch ms), or null if never.
  lastProbeAt: number | null;
  now: number;
}): boolean {
  const { onCyboTab, shownDaemonOnline, shownDaemonId, lastProbeAt, now } = opts;
  if (!onCyboTab || !shownDaemonOnline || !shownDaemonId) return false;
  return lastProbeAt === null || now - lastProbeAt >= FOCUS_REPROBE_MIN_INTERVAL_MS;
}
