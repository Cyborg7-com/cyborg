// Pure audit-stream filters (#995). No Svelte deps — unit-testable in isolation,
// and the CLI-first proof that the Logs audit stream is queryable by
// session / cybo / daemon / kind / level. `LogsPane` wires these to its dropdowns;
// the read-only session viewer (sibling spec `sessions-readonly-viewer`) deep-links
// into the Logs tab via `filterAuditBySession`.

import type { LogEntry } from "./state.svelte.js";

export interface AuditFilterCriteria {
  // The provider sessionId == agentId — the session-viewer deep-link contract.
  session?: string | null;
  cybo?: string | null;
  daemon?: string | null;
  kind?: string | null;
  level?: LogEntry["level"] | null;
}

// Treat "", null, undefined, and the UI's "all" sentinel as "no constraint".
function isAny(v: string | null | undefined): boolean {
  return v == null || v === "" || v === "all";
}

/**
 * Filter audit entries by session / cybo / daemon / kind / level. ANDs every
 * SUPPLIED criterion; an omitted (or "all"/empty) criterion does not constrain.
 * PURE — returns a new array, never mutates the input.
 */
export function filterAudit(entries: LogEntry[], criteria: AuditFilterCriteria): LogEntry[] {
  return entries.filter((e) => {
    if (!isAny(criteria.session) && e.agentId !== criteria.session) return false;
    if (!isAny(criteria.cybo) && e.cyboId !== criteria.cybo) return false;
    if (!isAny(criteria.daemon) && e.daemonId !== criteria.daemon) return false;
    if (!isAny(criteria.kind) && e.kind !== criteria.kind) return false;
    if (!isAny(criteria.level) && e.level !== criteria.level) return false;
    return true;
  });
}

/**
 * The session deep-link contract: only the audit entries whose `agentId` (==
 * provider sessionId) equals the given id. PURE.
 */
export function filterAuditBySession(entries: LogEntry[], agentId: string): LogEntry[] {
  return filterAudit(entries, { session: agentId });
}
