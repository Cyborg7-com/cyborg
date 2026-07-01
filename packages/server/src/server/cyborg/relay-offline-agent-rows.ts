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
// PRIVACY (2026-06-30): EVERY cybo agent SESSION is OWNER-SCOPED (private to its
// initiator). A session is visible to the requesting user ONLY when:
//   - it has NO initiator (legacy / system session — visible to all), OR
//   - the user IS its initiator (their own session, channel-bound or DM).
//
// A channel-bound session is NO LONGER shared with the whole channel. It was: a
// human-spawned, non-ephemeral, non-autonomous channel cybo used to short-circuit
// to `return true` for every channel member — so all members saw (and could resume
// / archive) each other's cybo sessions. That is the privacy incident this fixes.
// The cybo still POSTS to its channel; only the agent-session LIST visibility is
// scoped. This does NOT touch channel messages / message routing.
//
// EPHEMERAL (@-mention / slash summons) and AUTONOMOUS (cron / scheduled / webhook)
// sessions were already owner-scoped by the removed short-circuit's guards; they
// stay owner-scoped here via the same isOwner gate. The `ephemeral`/`autonomous`
// flags no longer change the outcome (all channel sessions are owner-scoped now)
// but are kept in the signature for compat with #1077's plumbing and callers.
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
  // Fail-closed: a channel-bound session is NOT shared — only its initiator (above)
  // or a legacy/system no-initiator session (above) is visible.
  return false;
}

// The ONE initiator-equality check, shared by every "is the caller the session's
// initiator?" gate (dispatcher's canReadLiveSession / handleArchiveAgent /
// handleSendAgentPrompt, and any relay-side sibling). Two identities can name the
// same person: the raw account id (same id-space) OR the canonical email (bridged
// across the local/cloud id namespaces — initiated_by is a LOCAL SQLite id while a
// cloud caller's id is a CLOUD id). The email match is CASE-INSENSITIVE (a
// mixed-case `Seb@x.com` must not be denied against a stored `seb@x.com`), and
// NULL-guarded on BOTH sides so two null emails never collide into a false match.
export function isAuthorizedInitiator(
  initiator: { id: string | null; email: string | null },
  caller: { id: string | null; email: string | null },
): boolean {
  if (!!initiator.id && !!caller.id && initiator.id === caller.id) return true;
  return (
    !!initiator.email &&
    !!caller.email &&
    initiator.email.toLowerCase() === caller.email.toLowerCase()
  );
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
// but it matches `initiated_by` (a daemon-LOCAL id) against the GLOBAL guestId, so a
// live session the email->local-id bridge misses slips through -- and the relay
// merges live rows VERBATIM. Worse, an OWNING DAEMON still on OLD code returns
// UNSCOPED rows entirely, so a non-owner sees a peer's session until every daemon
// updates. So the RELAY enforces the SAME owner rule (agentBindingVisibleCore, via
// offlineBindingVisible) here, the moment IT deploys -- no waiting on the daemon.
//
// For EVERY row the PG mirror knows, drop it unless the viewer is its owner (matched
// by canonical email OR global account id) or it has no initiator (legacy/system).
// This scopes channel-bound + non-ephemeral rows regardless of `autonomous` --
// closing the non-autonomous channel-session hole the earlier autonomous-only check
// left open. The viewer's OWN session is kept (no false-positive), a peer's is
// dropped (no false-negative). Rows ABSENT from the mirror are kept and left to the
// daemon's own scoping: that's a fresh live spawn not yet mirrored, OR an EPHEMERAL
// session (never mirrored) whose one-turn ownership the daemon already gates.
// `mirror` maps agentId -> its owner-identity fields.
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
    // Not mirrored (fresh spawn or ephemeral) -> trust the daemon's per-user scoping.
    if (!b) return true;
    return offlineBindingVisible(
      {
        channelId: b.channelId,
        initiatedBy: b.initiatedBy,
        initiatedByEmail: b.initiatedByEmail,
        autonomous: b.autonomous,
      },
      guestEmail,
      viewerGlobalId,
    );
  });
}

// Live-list owner scoping via agent_sessions (the table that is ACTUALLY
// populated; the agent_bindings mirror is empty in prod so filterLiveRowsForViewer
// is a no-op there). This is the REGULAR sidebar list, which is OWNER-SCOPED for
// EVERYONE — admins included. An admin's personal sidebar shows THEIR sessions
// only; the admin AUDIT view (see-all) is a SEPARATE, admin-gated endpoint
// (cyborg:list_daemon_sessions -> auditAgentRows/buildAuditAgentRow) that does NOT
// route through this filter. So there is NO admin bypass here. A CYBO session
// (cyboId != null) is visible iff the viewer is EITHER:
//   - the session INITIATOR (userId == viewerGlobalId), OR
//   - the CYBO OWNER        (cyboOwnerId == viewerGlobalId)
//   else -> dropped
// Owner-less (userId == null) is NOT an automatic drop: an autonomous/cron cybo
// spawn has no initiator, but its OWNER must still see it -- dropped only for a
// viewer who is neither initiator nor cybo owner. Both ids are GLOBAL account ids
// (direct compare, no email bridge). This lets a user start their own conversation
// with a shared cybo and see it, WITHOUT seeing the cybo owner's other sessions.
// A NON-cybo session (cyboId == null, e.g. a human's own coding session) and any
// agentId ABSENT from agent_sessions are LEFT to the daemon's own per-user scoping
// (kept here) — this filter only closes the cybo-session leak.
// `sessions` maps agentId -> { userId, cyboId, cyboOwnerId }.
export function filterLiveRowsByAgentSessionOwner(
  rows: Record<string, unknown>[],
  sessions: Map<
    string,
    { userId: string | null; cyboId: string | null; cyboOwnerId: string | null }
  >,
  viewerGlobalId: string | null,
): Record<string, unknown>[] {
  return rows.filter((row) => {
    const id = row.agentId as string | undefined;
    const s = id ? sessions.get(id) : undefined;
    if (!s) return true; // not in agent_sessions -> trust daemon scoping
    if (s.cyboId == null) return true; // non-cybo session -> out of scope of this fix
    if (!viewerGlobalId) return false; // fail-closed: no viewer id -> no cybo session
    // visible to the session initiator OR the cybo owner; else dropped.
    return s.userId === viewerGlobalId || s.cyboOwnerId === viewerGlobalId;
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
// mirror). The SAME rule the daemon's handleArchiveAgent enforces.
//
// PRIVACY (2026-06-30): a channel-bound session is NO LONGER clearable by any
// member. It was — a channelId short-circuited to `return true`, so any member
// could globally archive+kill another user's channel cybo session. Now EVERY
// session (channel-bound or DM) is clearable ONLY by its INITIATOR (matched by
// canonical email, case-insensitive, OR by the global account id == initiated_by)
// OR a workspace OWNER/ADMIN. Fail-closed: a non-owner/non-initiator is DENIED.
// Shared by the relay's ONLINE owner-archive bypass and its OFFLINE clear path so
// the two can never disagree.
export function canClearAgentBinding(
  b: { channelId: string | null; initiatedBy: string | null; initiatedByEmail: string | null },
  caller: { userId: string; email: string | null; role: string | null },
): boolean {
  const isAdmin = caller.role === "owner" || caller.role === "admin";
  const isInitiator =
    (!!b.initiatedByEmail &&
      !!caller.email &&
      b.initiatedByEmail.toLowerCase() === caller.email.toLowerCase()) ||
    (!!b.initiatedBy && b.initiatedBy === caller.userId);
  return isAdmin || isInitiator;
}

// Authorization for DRIVING (prompting) a session over the cloud relay forward
// (`cyborg:agent_prompt_forward`). The cloud relay gates send_agent_prompt on
// workspace-membership + `chat` scope only (NO initiator check), so the OWNING
// DAEMON is the sole initiator gate — this is that gate. The relay-parity of the
// local handleSendAgentPrompt drive check.
//
// PRIVACY (2026-06-30): EVERY cybo session is owner-scoped now — channel-bound ones
// included. A channel-bound session used to short-circuit to `return true` (any
// member with chat scope could drive another user's channel cybo — the incident
// hijack); that short-circuit is GONE. A session with an initiator is drivable ONLY
// by that initiator, matched by the forwarded cloud id (== initiated_by) OR by the
// initiator's canonical email (case-insensitive). initiated_by is a LOCAL SQLite id
// and the forward's fromUserId is a CLOUD id for the same person, so the caller
// resolves the initiator's email (via storage) and passes it as `initiatorEmail`.
// FAIL-CLOSED: a forward that can't prove it's the initiator (no fromUserId AND no
// matching email) is DENIED. A session with NO recorded initiator has nobody to
// restrict against ⇒ allowed (mirrors handleSendAgentPrompt).
export function isPromptFromInitiatorForward(
  binding: { initiatedBy: string | null },
  initiatorEmail: string | null,
  fwd: { fromUserId?: string; fromEmail?: string | null },
): boolean {
  if (!binding.initiatedBy) return true;
  if (fwd.fromUserId && binding.initiatedBy === fwd.fromUserId) return true;
  return (
    !!initiatorEmail &&
    !!fwd.fromEmail &&
    initiatorEmail.toLowerCase() === fwd.fromEmail.toLowerCase()
  );
}

// Authorization for READING a session's transcript / injected context from the
// relay (IDOR fix). Cybo sessions are OWNER-SCOPED now — channel-bound included
// (privacy incident 2026-06-30) — so a transcript is readable ONLY by the session
// INITIATOR (email- or id-bridged) OR a workspace OWNER/ADMIN. Channel membership
// NO LONGER grants a read: a channel-bound session is one user's private
// conversation, not the channel's. Fail-closed: not initiator/admin ⇒ deny.
// `isChannelMember` is retained in the signature for call-site compatibility but is
// deliberately unused now that membership no longer authorizes a read (the relay
// caller passes `false` and skips the getChannelMemberRole lookup entirely).
export function canReadAgentSession(
  b: { channelId: string | null; initiatedBy: string | null; initiatedByEmail: string | null },
  caller: { userId: string; email: string | null; role: string | null; isChannelMember: boolean },
): boolean {
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
