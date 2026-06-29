// Cross-daemon agent lifecycle resolution.
//
// A daemon answering `cyborg:list_agents` reports every binding in the workspace,
// but it only holds a LIVE handle on its OWN agents. A peer daemon's agent is
// reported with `lifecycle: "unknown"` and `daemonLocal: false`
// (dispatcher.ts liveAgentFields) — so cross-daemon sessions rendered as
// "unknown" in the UI even though the owning daemon knew their real status.
//
// The relay owns `daemon_agents` and keeps `status` live from each daemon's
// `cyborg:agent_status` report, so it is the authoritative source for those rows.
// This pure transform overlays that status onto the merged agent list: it fills
// the "unknown" lifecycle and stamps the owning `daemonId` so the cross-daemon
// sidebar can badge the row by its daemon (PR #799 reads `agent.daemonId`).

export interface DaemonAgentBinding {
  daemonId: string;
  agentId: string;
  status: string;
}

// Mutates the agent rows IN PLACE (the relay owns these objects) and returns
// them for convenience. A local agent's already-resolved lifecycle/model/modes
// are NEVER downgraded — only a missing or "unknown" lifecycle is filled.
export function resolveAgentLifecycleFromBindings(
  agents: Record<string, unknown>[],
  bindings: DaemonAgentBinding[],
): Record<string, unknown>[] {
  if (agents.length === 0 || bindings.length === 0) return agents;
  const byAgent = new Map(bindings.map((b) => [b.agentId, b]));
  for (const a of agents) {
    const id = a.agentId as string | undefined;
    if (!id) continue;
    const owner = byAgent.get(id);
    if (!owner) continue;
    // Stamp the owning daemon when the responder didn't already (it tags its own
    // rows with its serverId; a peer's row may be untagged or carry the
    // responder's id — the binding is authoritative for ownership).
    if (a.daemonId == null) a.daemonId = owner.daemonId;
    // Only the lifecycle the responder couldn't resolve is filled — a live local
    // agent keeps its fine-grained lifecycle instead of the coarse persisted
    // idle/running/error status.
    const life = a.lifecycle as string | undefined;
    if (!life || life === "unknown") a.lifecycle = owner.status;
  }
  return agents;
}
