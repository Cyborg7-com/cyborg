// Terminal directory fan-out merge (the "CLI terminals don't show in the sidebar"
// fix, PR #838 follow-up).
//
// THE BUG: the sidebar pulls the workspace terminal directory with
// `cyborg:list_terminals` and NO daemonId. The relay used to reject that pull
// ("daemonId required"), so a CLI-created terminal — known only to the daemon that
// spawned it — never reached the UI and the Terminals section never rendered.
//
// THE FIX: the relay now fans `list_terminals` out to every workspace daemon the
// caller can list on (mirroring `list_agents` / `list_archived_sessions`) and
// merges the per-daemon responses here before replying once. The terminal
// directory lives in each daemon's OWN controller (never in PG), so each daemon
// only knows ITS sessions — the merge is what reunites them.
//
// This module holds the PURE merge so it's deterministically testable in isolation
// from the relay's WebSocket plumbing:
//   - mergeTerminalDirectoryResponse: fold one daemon's response into the running
//     aggregate (dedupe by terminalId; stamp the answering daemon's id, since the
//     daemon doesn't know its own relay id — same idiom as the archived-session
//     daemonId stamp).
//   - finalizeTerminalDirectory: flatten + sort newest-first for the single reply.

// One directory row as it crosses the relay. Mirrors CyborgTerminalDirEntrySchema
// but stays a loose record because the relay never re-validates the daemon's rows
// (it only deduplicates + stamps them).
export type TerminalDirectoryRow = Record<string, unknown>;

// Fold one daemon's `cyborg:list_terminals_response.terminals` into the running
// aggregate map (keyed by terminalId). First write wins on a terminalId collision
// — terminal ids are unique per daemon and a session lives on exactly one daemon,
// so a collision can only be a duplicate, never a real second session. When the
// answering daemon's relay id is known, it's stamped onto each row so the sidebar
// can route control ops (input/resize/kill) back to the owning daemon (the daemon
// can't self-report its relay id).
export function mergeTerminalDirectoryResponse(
  aggregate: Map<string, TerminalDirectoryRow>,
  terminals: TerminalDirectoryRow[],
  fromDaemonId: string | undefined,
): void {
  for (const t of terminals) {
    if (fromDaemonId && fromDaemonId !== "guest") t.daemonId = fromDaemonId;
    const id = t.terminalId as string | undefined;
    if (id && !aggregate.has(id)) aggregate.set(id, t);
  }
}

// Flatten the merged aggregate into the array the guest receives, newest-first.
// Merged across daemons there's no global order, and the user expects the most
// recently started terminal at the top.
export function finalizeTerminalDirectory(
  aggregate: Map<string, TerminalDirectoryRow>,
): TerminalDirectoryRow[] {
  const terminals = Array.from(aggregate.values());
  terminals.sort((a, b) => ((b.startedAt as number) ?? 0) - ((a.startedAt as number) ?? 0));
  return terminals;
}
