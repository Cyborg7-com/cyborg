// Usage-metrics (round 1): pure counting helpers behind the daemon's heartbeat
// usage snapshots. Extracted from bootstrap.ts so the counting logic can be
// unit-tested without standing up a daemon. The call site keeps its
// try/catch → 0 guard around these.

/** A binding's usage-relevant fields. Matches StoredAgentBinding's shape. */
interface UsageBinding {
  agent_id: string;
  // 1 = ephemeral summon (one turn, torn down on completion); 0 = persistent.
  ephemeral: number;
}

/**
 * Count active sessions across the daemon's workspaces: NON-ephemeral agent
 * bindings whose agent is currently live in the agent manager.
 *
 * Mirrors `list_agents`' accessor (getAgentsByWorkspace) so the count tracks
 * the same set of agents.
 */
export function countActiveSessions(
  workspaceIds: string[],
  getBindings: (workspaceId: string) => Array<UsageBinding>,
  liveAgentIds: ReadonlySet<string>,
): number {
  let count = 0;
  for (const wsId of workspaceIds) {
    for (const binding of getBindings(wsId)) {
      if (!binding.ephemeral && liveAgentIds.has(binding.agent_id)) count++;
    }
  }
  return count;
}
