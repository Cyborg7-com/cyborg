// Pure helpers for the relay's list_agents OFFLINE fallback.
//
// The cloud relay lists a workspace's agent sessions by fanning out to its ONLINE
// daemons. A session created on a daemon that has since closed/restarted has no
// live daemon to answer, so it would vanish from the list. These helpers turn the
// PG-mirrored agent_bindings (db/pg-sync.getAgentBindingsByWorkspace) into the same
// list_agents row shape the daemon emits, applying the same private-session
// visibility filter — so the session stays listed (offline, not-live) and reappears
// resumable once the daemon is back.
//
// Dependency-free on purpose: the relay is Postgres-only and crash-loops if its
// startup graph value-imports storage.ts/better-sqlite3, so this module pulls in
// nothing from the daemon-local storage layer.

export interface OfflineAgentBinding {
  agentId: string;
  workspaceId: string;
  channelId: string | null;
  provider: string;
  model: string | null;
  systemPrompt: string | null;
  daemonId: string | null;
  cyboId: string | null;
  initiatedBy: string | null;
  initiatedByEmail: string | null;
  cwd: string | null;
  providerSessionId: string | null;
  // Optional ephemeral flag for the audit path. The PG mirror does NOT persist
  // ephemeral bindings (they're one-turn, torn down), so in practice this is
  // absent/false offline — but the audit row carries the field for parity.
  ephemeral?: boolean;
}

// Build the offline (owning-daemon-asleep) list_agents row for a mirrored binding.
// The shape matches the daemon dispatcher's toAgentListRow ⊕ liveAgentFields
// no-live branch, so the client renders it exactly like a non-live agent — just
// daemonLocal:false (its daemon is offline). cyboName/cyboAvatar are filled by the
// relay's enrichCyboFields; lifecycle stays "unknown" unless the relay's
// resolveCrossDaemonLifecycle overrides it from the persisted daemon_agents status.
export function buildOfflineAgentRow(b: OfflineAgentBinding): Record<string, unknown> {
  return {
    agentId: b.agentId,
    provider: b.provider,
    channelId: b.channelId,
    cyboId: b.cyboId,
    cyboName: null,
    cyboAvatar: null,
    initiatedBy: b.initiatedBy,
    // The relay resolves this email to the viewer's GLOBAL account id (and groups
    // the row under "You"), exactly like the live daemon rows' initiatedByEmail.
    initiatedByEmail: b.initiatedByEmail,
    lifecycle: "unknown",
    model: b.model,
    modeId: null,
    availableModes: [] as unknown[],
    thinkingOptionId: null,
    cwd: b.cwd,
    daemonLocal: false,
    daemonId: b.daemonId,
  };
}

// The ONE per-user agent-session visibility RULE, shared by the daemon's
// handleListAgents (id-space identity match) and the relay's OFFLINE path (email
// identity match). Each call site supplies its own ownership predicate via
// `isOwner`; the rule — which sessions are owner-scoped vs shared — lives here so
// the live and offline lists can never disagree.
//
// A session is visible to the requesting user when:
//   - it has NO initiator (legacy / system session — visible to all), OR
//   - the user IS its initiator (their own session, channel-bound or DM), OR
//   - it is a NON-ephemeral channel-bound session (a deliberately SHARED channel
//     agent — everyone in the channel sees it).
//
// EPHEMERAL sessions (@-mention / slash-command summons) are OWNER-SCOPED even when
// channel-bound: they belong to the user who triggered them and must appear ONLY in
// that user's list. Letting a channel-bound ephemeral through the "shared channel"
// branch is exactly the 2026-06-12 ghost-session leak (a member saw — and could
// resume — every other member's mention summons). So the channel short-circuit is
// reached ONLY for non-ephemeral bindings.
export function agentBindingVisibleCore(
  b: { channelId: string | null; initiatedBy: string | null; ephemeral: boolean },
  isOwner: () => boolean,
): boolean {
  if (!b.initiatedBy) return true;
  if (isOwner()) return true;
  // A non-ephemeral channel agent is shared with the whole channel; an ephemeral
  // one is private to its initiator (already admitted by the isOwner check above).
  if (b.channelId && !b.ephemeral) return true;
  return false;
}

// OFFLINE-path (relay) visibility. The binding's initiated_by id is daemon-scoped
// and meaningless to the relay, so ownership is matched on the stable email
// identity (case-insensitive). Ephemeral bindings are never mirrored to PG today
// (upsertAgentBinding skips them), so `ephemeral` is virtually always false here —
// but it is honored so an ephemeral row can NEVER leak via the offline list even if
// a future change starts mirroring them.
export function offlineBindingVisible(
  b: {
    channelId: string | null;
    initiatedBy: string | null;
    initiatedByEmail: string | null;
    ephemeral?: boolean;
  },
  guestEmail: string | null,
): boolean {
  return agentBindingVisibleCore(
    { channelId: b.channelId, initiatedBy: b.initiatedBy, ephemeral: b.ephemeral === true },
    () =>
      !!b.initiatedByEmail &&
      !!guestEmail &&
      b.initiatedByEmail.toLowerCase() === guestEmail.toLowerCase(),
  );
}

// Daemon-owner AUDIT row from a mirrored binding (sessions-daemon-audit-visibility
// / #993). Same projection as buildOfflineAgentRow PLUS the `ephemeral`/`internal`
// badges. internal is always false offline (no live agent to read it from), and
// ephemeral reflects the binding (in practice false — the PG mirror never stores
// ephemeral bindings). Used by the relay's OFFLINE audit fallback, where the
// admin-scope gate has ALREADY passed, so there is NO per-user visibility filter.
export function buildAuditAgentRow(b: OfflineAgentBinding): Record<string, unknown> {
  const row = buildOfflineAgentRow(b);
  row.ephemeral = b.ephemeral === true;
  row.internal = false;
  return row;
}

// ALL audit rows for a daemon's mirrored bindings — no `guestEmail` scoping and no
// ephemeral drop (the gate already authorized the caller). Filtered to the target
// daemon only.
export function auditAgentRows(
  bindings: OfflineAgentBinding[],
  daemonId: string,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const b of bindings) {
    if (b.daemonId !== daemonId) continue;
    rows.push(buildAuditAgentRow(b));
  }
  return rows;
}

// Visible offline rows for a workspace's mirrored bindings, EXCLUDING any agentId
// already present in the live fan-out (the live daemon row always wins on dedupe).
export function offlineAgentRows(
  bindings: OfflineAgentBinding[],
  guestEmail: string | null,
  liveAgentIds: ReadonlySet<string>,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const b of bindings) {
    if (liveAgentIds.has(b.agentId)) continue;
    if (!offlineBindingVisible(b, guestEmail)) continue;
    rows.push(buildOfflineAgentRow(b));
  }
  return rows;
}
