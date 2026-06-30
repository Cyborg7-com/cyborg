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
  // AUTONOMOUS (cron / scheduled / webhook) spawn — no human invoker. Unlike a
  // human-spawned interactive channel agent (a deliberately SHARED collaborative
  // resource), an autonomous session belongs PRIVATELY to whoever scheduled it and
  // must be OWNER-SCOPED in the session list (it still POSTS to its channel — only
  // the sidebar SESSION visibility is scoped). Persisted on the mirror so the
  // offline list scopes it the same way the live list does.
  autonomous?: boolean;
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
// resume — every other member's mention summons).
//
// AUTONOMOUS sessions (cron / scheduled / webhook fires — spawnCybo with
// autonomous:true) are LIKEWISE owner-scoped: a scheduled cybo (e.g. a per-user
// "market brief" cron) is a PRIVATE session of whoever scheduled it, not a shared
// channel resource — even though it is non-ephemeral and channel-bound (it posts
// its output INTO the channel). Without this an autonomous binding leaked into
// EVERY workspace member's sidebar via the channel short-circuit. So the channel
// short-circuit is reached ONLY for non-ephemeral, NON-autonomous bindings — i.e. a
// genuinely human-spawned, deliberately SHARED interactive channel agent.
export function agentBindingVisibleCore(
  b: {
    channelId: string | null;
    initiatedBy: string | null;
    ephemeral: boolean;
    autonomous: boolean;
  },
  isOwner: () => boolean,
): boolean {
  if (!b.initiatedBy) return true;
  if (isOwner()) return true;
  // A non-ephemeral, NON-autonomous channel agent is shared with the whole channel.
  // Ephemeral (mention/slash) and autonomous (cron/scheduled/webhook) channel
  // sessions are private to their initiator (already admitted by the isOwner check
  // above) and must NOT take this shared short-circuit.
  if (b.channelId && !b.ephemeral && !b.autonomous) return true;
  return false;
}

// OFFLINE-path (relay) visibility. Ownership is matched two ways, so BOTH new and
// old mirror rows attribute to their real owner (#810):
//   • by the stable EMAIL identity (case-insensitive) — sessions created on the
//     owner's OWN daemon carry their real email; new cloud sessions now store the
//     canonical email too (dispatcher/cybo-manager thread auth.user.email).
//   • by the viewer's GLOBAL account id == the binding's initiated_by — a
//     cloud-forwarded session stamps initiated_by with the global account id
//     (bootstrap overrides auth.user.id to the relay's guestId). OLD rows mirror
//     only the synthetic "<id>@remote.local" placeholder email (never matched), so
//     this id path is what re-attributes them to their owner instead of leaking.
// Ephemeral bindings are never mirrored to PG today (upsertAgentBinding skips
// them), so `ephemeral` is virtually always false here — but it is honored so an
// ephemeral row can NEVER leak via the offline list even if a future change starts
// mirroring them.
export function offlineBindingVisible(
  b: {
    channelId: string | null;
    initiatedBy: string | null;
    initiatedByEmail: string | null;
    ephemeral?: boolean;
    autonomous?: boolean;
  },
  guestEmail: string | null,
  viewerGlobalId: string | null,
): boolean {
  return agentBindingVisibleCore(
    {
      channelId: b.channelId,
      initiatedBy: b.initiatedBy,
      ephemeral: b.ephemeral === true,
      autonomous: b.autonomous === true,
    },
    () =>
      (!!b.initiatedByEmail &&
        !!guestEmail &&
        b.initiatedByEmail.toLowerCase() === guestEmail.toLowerCase()) ||
      (!!viewerGlobalId && !!b.initiatedBy && b.initiatedBy === viewerGlobalId),
  );
}

// Re-filter the relay's MERGED LIVE list_agents rows for per-user visibility
// (live-list IDOR gap). The daemon already scopes its OWN list (handleListAgents),
// but it matches `initiated_by` (a daemon-LOCAL id) against the GLOBAL guestId, so
// when the email->local-id bridge misses an AUTONOMOUS (cron/scheduled) live session
// can slip through -- and the relay merges live rows VERBATIM. Cross-reference the
// PG mirror (the SAME `autonomous` flag #1077 persists) and drop any autonomous row
// the viewer doesn't own (by canonical email OR global account id). Intentionally
// CONSERVATIVE: ONLY rows the mirror marks `autonomous` are re-checked, so a shared
// channel agent -- or the viewer's own private session the daemon legitimately
// included -- is NEVER wrongly hidden (no false-negative on the common path). Rows
// absent from the mirror (a fresh live spawn not yet mirrored) are kept and left to
// the daemon's own scoping. `mirror` maps agentId -> its owner-identity fields.
export function filterLiveRowsForViewer(
  rows: Record<string, unknown>[],
  mirror: Map<
    string,
    {
      channelId: string | null;
      initiatedBy: string | null;
      initiatedByEmail: string | null;
      autonomous: boolean;
    }
  >,
  guestEmail: string | null,
  viewerGlobalId: string | null,
): Record<string, unknown>[] {
  return rows.filter((row) => {
    const id = row.agentId as string | undefined;
    const b = id ? mirror.get(id) : undefined;
    // Not a mirrored autonomous session -> trust the daemon's own per-user scoping.
    if (!b || !b.autonomous) return true;
    return offlineBindingVisible(
      {
        channelId: b.channelId,
        initiatedBy: b.initiatedBy,
        initiatedByEmail: b.initiatedByEmail,
        autonomous: true,
      },
      guestEmail,
      viewerGlobalId,
    );
  });
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
  row.autonomous = b.autonomous === true;
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

// Whether the stale-binding GC (#810) may run for a single daemon's
// list_agents_response. The GC prunes the REQUESTER's bindings on the answering
// daemon that are absent from the live set, so it is ONLY safe on a list that is
// the COMPLETE set of the requester's visible live agents on that daemon:
//   • requestFiltered (e.g. a cyboId-scoped request) → the daemon answered with a
//     SUBSET (only that cybo's agents), so a binding absent from it may still be a
//     LIVE agent of the user — NEVER prune. Only an UNFILTERED list is complete.
//   • liveAgentCount === 0 → an empty response is ambiguous (it can be a transient
//     daemon error / timeout / cold start), and "no live agents ⇒ delete them all"
//     would wipe live bindings. Under-prune instead: skip (the user can still clear
//     a leftover manually via the offline-archive path).
export function shouldGcOwnerBindings(opts: {
  requestFiltered: boolean;
  liveAgentCount: number;
}): boolean {
  return !opts.requestFiltered && opts.liveAgentCount > 0;
}

// Authorization for CLEARING / ARCHIVING an agent session from the relay (the PG
// mirror). The SAME rule the daemon's handleArchiveAgent enforces: a SHARED channel
// agent (channel-bound; the PG mirror only ever holds NON-ephemeral bindings, so a
// channelId ⇒ shared) is clearable by ANY member. Otherwise the session is PRIVATE
// and clearable only by its INITIATOR (matched by canonical email, case-insensitive,
// OR by the global account id == initiated_by) OR a workspace OWNER/ADMIN. Shared by
// the relay's ONLINE owner-archive bypass and its OFFLINE clear path so the two can
// never disagree.
export function canClearAgentBinding(
  b: { channelId: string | null; initiatedBy: string | null; initiatedByEmail: string | null },
  caller: { userId: string; email: string | null; role: string | null },
): boolean {
  const isSharedChannelAgent = !!b.channelId;
  if (isSharedChannelAgent) return true;
  const isAdmin = caller.role === "owner" || caller.role === "admin";
  const isInitiator =
    (!!b.initiatedByEmail &&
      !!caller.email &&
      b.initiatedByEmail.toLowerCase() === caller.email.toLowerCase()) ||
    (!!b.initiatedBy && b.initiatedBy === caller.userId);
  return isAdmin || isInitiator;
}

// Authorization for READING a session's transcript / injected context from the
// relay (IDOR fix). STRICTER than canClearAgentBinding for the channel case: a
// transcript read requires ACTUAL channel MEMBERSHIP (the caller-supplied
// `isChannelMember`, a PG lookup), not mere workspace membership — a non-member
// must never read a private channel's cybo transcript. Beyond that the rule
// matches: the session INITIATOR (email- or id-bridged) OR a workspace OWNER/ADMIN
// may always read. Fail-closed: no channel membership AND not initiator/admin ⇒ deny.
export function canReadAgentSession(
  b: { channelId: string | null; initiatedBy: string | null; initiatedByEmail: string | null },
  caller: { userId: string; email: string | null; role: string | null; isChannelMember: boolean },
): boolean {
  if (b.channelId && caller.isChannelMember) return true;
  const isAdmin = caller.role === "owner" || caller.role === "admin";
  const isInitiator =
    (!!b.initiatedByEmail &&
      !!caller.email &&
      b.initiatedByEmail.toLowerCase() === caller.email.toLowerCase()) ||
    (!!b.initiatedBy && b.initiatedBy === caller.userId);
  return isAdmin || isInitiator;
}

// Routing decision for an authorized owner/admin archive (archiveOwnerBypass). A
// LIVE session is owned by its daemon's SQLite, NOT PG — so clearing only the PG
// mirror lets the still-online daemon re-advertise the live agent on the next
// list_agents fan-out (the reappearing-row bug). The relay must therefore defer to
// the daemon when it can reach the owning one:
//   • "daemon"  — the owning daemon is known AND reachable: forward the RPC and let
//     IT tear down its SQLite + kill the live agent + answer authoritatively. The
//     relay does NOT clear PG or fake success.
//   • "pg-clear" — the owning daemon is offline OR unresolved: no live daemon can
//     re-advertise, so clearing the PG mirror is correct and authoritative.
export function resolveOwnerArchiveRoute(opts: {
  owningDaemonId: string | undefined;
  daemonReachable: boolean;
}): "daemon" | "pg-clear" {
  return opts.owningDaemonId && opts.daemonReachable ? "daemon" : "pg-clear";
}

// Visible offline rows for a workspace's mirrored bindings, EXCLUDING any agentId
// already present in the live fan-out (the live daemon row always wins on dedupe).
export function offlineAgentRows(
  bindings: OfflineAgentBinding[],
  guestEmail: string | null,
  liveAgentIds: ReadonlySet<string>,
  viewerGlobalId: string | null,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const b of bindings) {
    if (liveAgentIds.has(b.agentId)) continue;
    if (!offlineBindingVisible(b, guestEmail, viewerGlobalId)) continue;
    rows.push(buildOfflineAgentRow(b));
  }
  return rows;
}
