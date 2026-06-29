// Which open agent/cybo sessions to re-hydrate on a reconnect (#518).
//
// Two callers: the CLIENT's own reconnect (re-hydrate every open session) and an
// owner-DAEMON reconnect (re-hydrate only the sessions that daemon owns — the
// others' daemons never dropped, so re-fetching them is wasted work). Pure +
// exported so the scoping decision is unit-tested without app.svelte.ts.

export interface CatchUpAgent {
  agentId: string;
  daemonId?: string | null;
}

// Filter the open agent ids down to the ones that should catch up.
//   - no `daemonId` (client reconnect) → ALL open sessions.
//   - a `daemonId` (that daemon reconnected) → sessions owned by it, PLUS any
//     session whose owner is unknown or null. A null/absent daemonId is a
//     solo/local session that belongs to whatever single daemon is running, and
//     an unknown owner (agent row not loaded yet) is re-fetched defensively —
//     the rule only EXCLUDES sessions provably owned by a DIFFERENT daemon, so a
//     stale session can never be missed.
export function agentIdsForDaemonCatchUp(
  openAgentIds: readonly string[],
  agents: readonly CatchUpAgent[],
  daemonId?: string | null,
): string[] {
  if (!daemonId) return [...openAgentIds];
  const ownerOf = new Map<string, string | null | undefined>(
    agents.map((a) => [a.agentId, a.daemonId]),
  );
  return openAgentIds.filter((id) => {
    const owner = ownerOf.get(id);
    // owner == null covers BOTH null (solo) and undefined (unknown/not-in-list).
    return owner == null || owner === daemonId;
  });
}
