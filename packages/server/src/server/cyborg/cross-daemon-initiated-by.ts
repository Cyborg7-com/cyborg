// Cross-daemon `initiated_by` → global account id resolution.
//
// An agent's owner is `agent_bindings.initiated_by`, stamped at creation with
// the launching user's id IN THE OWNING DAEMON'S LOCAL SQLite id space
// (dispatcher.ts: "initiated_by is stored in the local id space"). When user R
// launches a session on user S's daemon, the row carries S-daemon's LOCAL id for
// R (e.g. `7d8395e3`), which is NOT R's GLOBAL cloud account id (e.g.
// `4871b232`). There is no PG table mapping local↔global; the namespaces are
// bridged by IDENTITY (email) — the same idiom the agent_prompt_forward path
// already uses (relay-standalone.ts: "bridge the two id namespaces by identity").
//
// The UI groups the agent list by owner (session-scope.ts `groupByOwner`),
// comparing each row's `initiatedBy` to the viewer's own (global) account id. A
// raw local id never matches, so a user's own cross-daemon sessions render under
// a phantom local id instead of "You". This pure transform fixes that: the daemon
// carries the initiator's email on each row (`initiatedByEmail`); this overlays
// the GLOBAL account id resolved from that email so the row groups correctly.

// Mutates the agent rows IN PLACE (the relay owns these objects) and returns them
// for convenience. For each row, if its `initiatedByEmail` resolves to a global
// account id, `initiatedBy` is overwritten with that global id. Rows with no
// email (legacy/unattributable) or an email absent from the map are LEFT AS-IS —
// preserving correct attribution: each distinct real user has a distinct email →
// a distinct global id, so a session genuinely owned by someone else can never be
// mis-merged into the viewer's "You".
export function resolveInitiatedByGlobalIds(
  agents: Record<string, unknown>[],
  emailToGlobalId: Map<string, string>,
): Record<string, unknown>[] {
  if (agents.length === 0 || emailToGlobalId.size === 0) return agents;
  for (const a of agents) {
    const email = a.initiatedByEmail;
    if (typeof email !== "string" || email === "") continue;
    const globalId = emailToGlobalId.get(email);
    if (globalId) a.initiatedBy = globalId;
  }
  return agents;
}

// Collect the distinct, non-empty `initiatedByEmail`s on a merged agent list, so
// the relay can resolve them to global ids with one PG lookup per distinct email.
export function collectInitiatedByEmails(agents: Record<string, unknown>[]): string[] {
  const emails = new Set<string>();
  for (const a of agents) {
    const email = a.initiatedByEmail;
    if (typeof email === "string" && email !== "") emails.add(email);
  }
  return [...emails];
}
