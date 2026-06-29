// Authoritative unread reconcile on foreground (#672), extracted from
// app.svelte.ts so the behavior is testable with spies (app.svelte.ts can't be
// imported under the plain-node vitest env — Svelte runes), exactly like
// seq-gap-recovery.ts.
//
// THE BUG (#672): the red unread badge lives in PERSISTED localStorage
// (notificationState._counts) and is only corrected when a fetch_unread reseed
// runs for that workspace. onForeground() previously rode that reseed on
// handleReconnect(), which fires ONLY when away ≥ 30s AND the socket needed a
// reconnect. So: read a DM/mention on desktop while the phone is backgrounded
// <30s (or read a DIFFERENT conversation than the one badged) → on resume the
// phone keeps the stale persisted badge until a 30s+ away cycle or a hard
// reconnect. The cross-device read_broadcast only helps on a LIVE socket; the
// stuck case is the disconnected/zombie-socket + persisted-cache path.
//
// THE FIX: on EVERY foreground, re-fetch the authoritative unread snapshot and
// reseed. notificationState.seedCounts already REPLACES the whole workspace map
// (dropping now-read entries) — the fix is just to CALL it on foreground, not
// only after a 30s+ away or a hard reconnect. This does NOT touch the
// zombie-socket reconnect logic (still away-gated) nor the status path (#671).
//
// COALESCED: a rapid background/foreground flap must not spam fetch_unread. A
// single in-flight guard + min-interval (mirroring recoverSeqGap) bounds this to
// at most one reconcile per interval. The reseed is an authoritative
// refetch-and-replace, so a coalesced/duplicate trigger is harmless (idempotent).

export interface UnreadReconcileDeps {
  /** workspaceState.list — every workspace whose persisted badge may be stale. */
  listWorkspaceIds: () => string[];
  /**
   * fetchUnread → seedUnreadSignals → readCursorState.seed for the ACTIVE
   * workspace, and a counts-only reseed for the rest. Implemented in
   * app.svelte.ts against the live client/state; throws on a transport failure
   * so the orchestrator can leave lastRun unbumped (next foreground retries).
   */
  reconcileWorkspaceUnread: (wsId: string) => Promise<void>;
  /** Injected clock for deterministic min-interval tests. */
  now: () => number;
}

export interface UnreadReconcileState {
  inFlight: boolean;
  lastRun: number;
}

export function createUnreadReconcileState(): UnreadReconcileState {
  return { inFlight: false, lastRun: 0 };
}

/**
 * Re-fetch authoritative unread/read-state for every workspace and clear badges
 * the server no longer considers unread. Safe to call on every foreground:
 * guarded by an in-flight lock + min-interval so a background/foreground flap
 * coalesces to ≤1 reconcile per window.
 *
 * On a transport failure the badge is NOT durably stranded: `lastRun` is only
 * advanced after a SUCCESSFUL pass, so the next foreground retries immediately
 * (no min-interval wait) instead of leaving the persisted-stale cache as truth.
 */
export async function reconcileUnread(
  deps: UnreadReconcileDeps,
  state: UnreadReconcileState,
  minIntervalMs: number,
): Promise<void> {
  if (state.inFlight) return;
  if (deps.now() - state.lastRun < minIntervalMs) return;
  state.inFlight = true;
  const startedAt = deps.now();
  try {
    const ids = deps.listWorkspaceIds();
    // Reconcile each workspace independently — one failing must not strand the
    // others' badges. Settle all, then decide success below.
    const results = await Promise.allSettled(
      ids.map((wsId) => deps.reconcileWorkspaceUnread(wsId)),
    );
    // Only bump lastRun (arming the min-interval) when EVERY workspace reconciled.
    // A partial/total failure leaves lastRun untouched so the next foreground
    // forces a fresh reconcile instead of letting the persisted-stale badge
    // outlive a successful server reconcile (#672 no-swallow).
    const allOk = results.every((r) => r.status === "fulfilled");
    if (allOk) state.lastRun = startedAt;
  } finally {
    state.inFlight = false;
  }
}
