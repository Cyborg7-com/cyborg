// Session scoping — the single client-side source of truth for "whose session
// is this, and which surface should it appear on" (#706).
//
// THE PROBLEM: on a daemon shared by several users, the chat sidebar's live
// Agents list (`workspaceState.agents`) shows EVERY user's sessions, so it
// floods and stops being scrollable. The fix moves OTHER users' personal
// sessions out of the chat sidebar into dedicated surfaces (daemon-detail for
// the per-daemon lens; Settings → Logs for the workspace-wide audit), while
// keeping MY sessions and the shared, channel-bound cybos where they belong.
//
// Pure + dependency-free so the predicates are unit-testable without a DOM and
// every surface (sidebar "mine" view, daemon-detail "daemon" view) shares the
// SAME definition of mine/daemon/channel-bound — mirrors the daemon-scopes.ts
// idiom (#705).

// The identity/binding fields this module reasons about. A structural subset of
// the agent row (plugins/agents/types.ts `Agent`) so callers can pass the live
// row straight through.
export interface SessionScopeFields {
  // The user id that LAUNCHED the session (server `agent_bindings.initiated_by`).
  // Null/absent on legacy rows the daemon couldn't attribute.
  initiatedBy?: string | null;
  // The channel this agent posts into, when it is channel-bound. Null/absent for
  // a personal/ephemeral session that isn't wired to a shared channel.
  channelId?: string | null;
  // The daemon the session runs on.
  daemonId?: string | null;
}

// Which surface a session list is rendered on:
//   mine      — the chat sidebar, filtered to the current user (+ shared cybos).
//   daemon    — daemon-detail, ALL users on ONE daemon (grouped by owner).
//   workspace — the workspace-wide audit (Settings → Logs, #704). Kept here so
//               the scope union is exhaustive; this module does no filtering for
//               it (the Logs tab owns the firehose) but the type documents it.
export type SessionScope = "mine" | "daemon" | "workspace";

// Is this MY session? `initiatedBy` is the launching user id.
export function isMine(session: SessionScopeFields, currentUserId: string | undefined): boolean {
  return !!currentUserId && session.initiatedBy === currentUserId;
}

// Is this a SHARED, channel-bound agent? An agent wired to a channel posts into
// the shared workspace, so it belongs wherever the channel is — it must NOT be
// hidden from the sidebar just because someone else launched it. This is the
// conservative side of the #706 trade-off: a channel binding keeps a session
// visible to the whole team.
export function isChannelBound(session: SessionScopeFields): boolean {
  return session.channelId != null && session.channelId !== "";
}

// The "moved out" set: another user's PERSONAL session (not mine, not
// channel-bound). Conservative on attribution — a row with NO `initiatedBy`
// (legacy/unattributable) is NOT treated as "someone else's", so it stays
// visible in the sidebar rather than silently vanishing. This is the single
// predicate that decides what LEAVES the sidebar; everything else stays.
export function isOthersPersonalSession(
  session: SessionScopeFields,
  currentUserId: string | undefined,
): boolean {
  if (isChannelBound(session)) return false; // shared → stays
  if (session.initiatedBy == null || session.initiatedBy === "") return false; // unattributable → stays
  return session.initiatedBy !== currentUserId;
}

// Does this session belong in the chat sidebar's filtered "mine" view? Stays
// unless it's specifically another user's PERSONAL session — so mine, shared
// channel-bound cybos (the trade-off), AND unattributable legacy rows all stay
// visible; only other users' personal/ephemeral sessions move to the
// daemon/workspace surfaces.
export function belongsInMineSidebar(
  session: SessionScopeFields,
  currentUserId: string | undefined,
): boolean {
  return !isOthersPersonalSession(session, currentUserId);
}

// Filter a list to the chat sidebar's "mine" view (mine + shared channel cybos).
// NOTE: this filters by USER only — never by daemon. The "my sessions" view is
// deliberately CROSS-DAEMON: my sessions on every (online) daemon aggregate into
// one list, each row tagged with its daemon (see remoteDaemonLabel). Scoping the
// sidebar to a single daemon was a regression — my sessions on other machines
// would silently vanish until I switched daemons.
export function filterMine<T extends SessionScopeFields>(
  sessions: readonly T[],
  currentUserId: string | undefined,
): T[] {
  return sessions.filter((s) => belongsInMineSidebar(s, currentUserId));
}

// The daemon tag for a session row in the cross-daemon "mine" view, or null when
// the session runs on this client's own local/default daemon (local rows need no
// badge). `daemonLocal === false` is the authoritative server signal that a
// session lives on ANOTHER machine; `nameFor` resolves its daemon id → a
// friendly label, falling back to "Remote" when the daemon name is unknown. This
// is what makes the aggregated list legible: without it a remote session is
// indistinguishable from a local one and the list reads as "one daemon".
export function remoteDaemonLabel(
  session: { daemonLocal?: boolean; daemonId?: string | null },
  nameFor: (daemonId: string) => string | null | undefined,
): string | null {
  if (session.daemonLocal !== false) return null; // local/default daemon → no badge
  const name = session.daemonId ? nameFor(session.daemonId) : null;
  return name && name.trim() ? name : "Remote";
}

// How many of OTHER users' personal sessions were filtered out — drives the
// sidebar's "N sessions from others → view in the daemon" redirect hint, so the
// move reads as a redirection, not a silent disappearance.
export function countOthersPersonalSessions(
  sessions: readonly SessionScopeFields[],
  currentUserId: string | undefined,
): number {
  let n = 0;
  for (const s of sessions) if (isOthersPersonalSession(s, currentUserId)) n++;
  return n;
}

// The single distinct daemon that the filtered-out "others" sessions run on, or
// null when there are zero or they span multiple daemons. Lets the sidebar hint
// deep-link straight to that daemon's detail when it's unambiguous.
export function soleOthersDaemonId(
  sessions: readonly SessionScopeFields[],
  currentUserId: string | undefined,
): string | null {
  let daemonId: string | null | undefined;
  for (const s of sessions) {
    if (!isOthersPersonalSession(s, currentUserId)) continue;
    if (daemonId === undefined) daemonId = s.daemonId ?? null;
    else if ((s.daemonId ?? null) !== daemonId) return null; // spans >1 daemon
  }
  return daemonId === undefined ? null : (daemonId ?? null);
}

// ─── Daemon scope (daemon-detail) ─────────────────────────────────────────

// Sessions on ONE daemon, ALL users (the daemon owner's "what ran on my
// machine" lens). Same predicate as DaemonDetail's existing activeSessions.
export function filterByDaemon<T extends SessionScopeFields>(
  sessions: readonly T[],
  daemonId: string,
): T[] {
  return sessions.filter((s) => s.daemonId === daemonId);
}

// A group of one user's sessions on a daemon — the daemon-detail view leads each
// group with the owner's avatar + name (not cybo/cwd), so the daemon owner
// recognizes whose sessions these are at a glance.
export interface SessionOwnerGroup<T> {
  // The launching user id, or null for unattributable/legacy rows.
  userId: string | null;
  sessions: T[];
}

// Group a daemon's sessions by their owner (`initiatedBy`). MY group sorts first
// (so the owner sees their own sessions at the top), then other users
// alphabetically by their resolved display name, then the unattributable group
// last. `nameFor` resolves a user id → display name for the stable ordering;
// null-id rows collate to the end.
export function groupByOwner<T extends SessionScopeFields>(
  sessions: readonly T[],
  currentUserId: string | undefined,
  nameFor: (userId: string) => string,
): SessionOwnerGroup<T>[] {
  const groups = new Map<string | null, T[]>();
  for (const s of sessions) {
    const key = s.initiatedBy != null && s.initiatedBy !== "" ? s.initiatedBy : null;
    const bucket = groups.get(key);
    if (bucket) bucket.push(s);
    else groups.set(key, [s]);
  }
  return [...groups.entries()]
    .map(([userId, list]) => ({ userId, sessions: list }))
    .sort((a, b) => {
      // Mine first.
      const aMine = a.userId != null && a.userId === currentUserId;
      const bMine = b.userId != null && b.userId === currentUserId;
      if (aMine !== bMine) return aMine ? -1 : 1;
      // Unattributable last.
      if ((a.userId === null) !== (b.userId === null)) return a.userId === null ? 1 : -1;
      if (a.userId === null || b.userId === null) return 0;
      // Otherwise alphabetical by display name.
      return nameFor(a.userId).localeCompare(nameFor(b.userId));
    });
}
