// Seq-gap recovery orchestration (#499 + #639), extracted from app.svelte.ts so
// the behavior is testable with spies (app.svelte.ts can't be imported under the
// plain-node vitest env — Svelte runes), exactly like channel-roster-refresh.ts.
//
// A forward jump in the per-workspace broadcast seq means events may have been
// lost on an OPEN socket (multi-instance relay). Recover the active channel + DM
// MESSAGES *and* the ROSTER panels (#639 — channel_cybo_added/member_added and the
// cybo_* broadcasts ride the same seq), instead of waiting for a real reconnect.
//
// COALESCED: the global seq counter is SPARSE per client (a DM between other users
// consumes a seq we never receive), so a "gap" is often benign. A per-workspace
// in-flight guard + min-interval bound this to at most one burst per interval, and
// every dep refetch-and-replaces, so a false trigger is harmless (idempotent).

export interface SeqGapDeps {
  /** workspaceState.current?.id === wsId — re-checked after each await yields. */
  isActiveWorkspace: (wsId: string) => boolean;
  /** drainSync(wsId, channelState.lastSeq) — recover the active channel's messages. */
  drainMessages: (wsId: string) => Promise<void>;
  /** catchUpDm for the active peer if any (no-op otherwise) — recover DM messages. */
  catchUpDm: (wsId: string) => Promise<void>;
  /** reconcileWorkspacePanels — refetch+replace channels/members/agents/daemons (#639). */
  reconcilePanels: (wsId: string) => Promise<void>;
  /** Injected clock for deterministic rate-limit tests. */
  now: () => number;
}

export interface SeqGapState {
  inFlight: Set<string>;
  lastRun: Map<string, number>;
}

export function createSeqGapState(): SeqGapState {
  return { inFlight: new Set(), lastRun: new Map() };
}

/**
 * Recover from a seq-gap for one workspace. Drains messages, then reconciles the
 * roster panels (#639), each behind a fresh active-workspace check. Guarded by an
 * in-flight lock + min-interval so repeated/false gaps coalesce into one burst.
 */
export async function recoverSeqGap(
  wsId: string,
  deps: SeqGapDeps,
  state: SeqGapState,
  minIntervalMs: number,
): Promise<void> {
  if (!deps.isActiveWorkspace(wsId)) return;
  if (state.inFlight.has(wsId)) return;
  if (deps.now() - (state.lastRun.get(wsId) ?? 0) < minIntervalMs) return;
  state.inFlight.add(wsId);
  state.lastRun.set(wsId, deps.now());
  try {
    await deps.drainMessages(wsId);
    if (deps.isActiveWorkspace(wsId)) await deps.catchUpDm(wsId);
    // #639: roster broadcasts ride the same seq, so reconcile the panels too —
    // re-check the workspace since the awaits above could have yielded.
    if (deps.isActiveWorkspace(wsId)) await deps.reconcilePanels(wsId);
  } catch {
    // best-effort — the next reconnect/foreground resync covers anything missed
  } finally {
    state.inFlight.delete(wsId);
  }
}
