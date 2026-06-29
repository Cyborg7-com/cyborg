// Per-message author/recipient scoping for the relay's guest fan-out.
//
// `broadcastToGuestsLocal` (relay-standalone.ts) defaults to fanning a message to
// EVERY guest in the workspace. Some message types are PRIVATE (DMs, per-user
// thread events, personal ephemeral results, owner-scoped terminal streams, and
// author-only cybo mention/capability notices). Each must be narrowed to its
// intended audience, otherwise it leaks workspace-wide.
//
// This logic lived inline as a chain of `if (message.type === …)` blocks. A
// forgotten case there is silent — `allowedUsers` simply stays null and the
// message fans out (exactly the cybo_mention_notice leak, internal docs #1). It is
// extracted here, as a declarative rule table, so it is one tested unit shared by
// both the local and the Redis re-broadcast path, and adding a private type is a
// table entry rather than another easily-forgotten `if`.

export interface BroadcastScope {
  // When non-null, deliver ONLY to guests whose userId is in this set.
  allowedUsers: Set<string> | null;
  // When non-null, deliver ONLY to guests whose email matches (private agent
  // streams are tagged by email; guest ids diverge across stores).
  allowedEmail: string | null;
}

interface RelayMessage {
  type?: unknown;
  payload?: unknown;
}

// A scope rule maps message type(s) to the user ids that may receive it. Returns
// null to leave the scope unchanged (workspace-wide), or a set of ids to narrow.
interface UserScopeRule {
  types: string[];
  pick: (payload: Record<string, unknown> | undefined) => (string | undefined)[] | null;
}

function nonEmpty(...values: (string | undefined)[]): Set<string> {
  return new Set(values.filter((v): v is string => Boolean(v)));
}

// DM-style: scope to the two participants, but ONLY when toId is set (a channel
// variant of the same type — typing/unfurl without toId — fans out workspace-wide).
function dmPair(p: Record<string, unknown> | undefined): (string | undefined)[] | null {
  const toId = p?.toId as string | undefined;
  if (!toId) return null;
  return [p?.fromId as string | undefined, toId];
}

// Author/recipient scoping rules. Each entry narrows allowedUsers for its types.
const USER_SCOPE_RULES: UserScopeRule[] = [
  // DMs are private to their two participants — never fan a dm_broadcast out to
  // the whole workspace (that leaked content + produced phantom unread badges).
  { types: ["cyborg:dm_broadcast"], pick: (p) => [p?.fromId as string, p?.toId as string] },
  // DM typing / DM-message unfurls are private to the two participants; the
  // channel variants (no toId) fan out workspace-wide like the message they decorate.
  { types: ["cyborg:typing_broadcast", "cyborg:message_unfurled"], pick: dmPair },
  // Thread events are per-user (each follower gets their own unread values).
  {
    types: ["cyborg:thread_updated", "cyborg:thread_read_changed", "cyborg:thread_follow_changed"],
    pick: (p) => [p?.toUserId as string | undefined],
  },
  // /catchup digest is a PERSONAL ephemeral result — scope to the caller.
  { types: ["cyborg:catchup_result"], pick: (p) => [p?.toUserId as string | undefined] },
  // A cybo mention/capability notice (#736) is an AUTHOR-ONLY ephemeral notice
  // ("Rick can't reply here — run `claude login` on that machine…"). It is tagged
  // with payload.toUserId (the mention author). Without this entry allowedUsers
  // stays null and the notice fans workspace-wide, leaking the daemon's
  // login/capability gap to every member (internal docs #1).
  { types: ["cyborg:cybo_mention_notice"], pick: (p) => [p?.toUserId as string | undefined] },
  // A terminal stream (#654) is PRIVATE to whoever opened it — the daemon tags
  // every output/exit/snapshot frame with the owner's id; deliver only to them.
  {
    types: ["cyborg:terminal_output", "cyborg:terminal_exit", "cyborg:terminal_snapshot"],
    pick: (p) => [p?.toUserId as string | undefined],
  },
  // The terminal DIRECTORY feed is owner-scoped too — a terminal is private to
  // whoever opened it, so the change snapshot (which lists sessions + cwds) must
  // reach only the owner, never every workspace member.
  {
    types: ["cyborg:terminals_changed"],
    pick: (p) => [p?.toUserId as string | undefined],
  },
  // A terminal alias is a PER-USER cosmetic label (a terminal is private to its
  // owner), so the live cross-device rename broadcast must reach only that user's
  // other clients — never every workspace member.
  {
    types: ["cyborg:terminal_alias_changed"],
    pick: (p) => [p?.toUserId as string | undefined],
  },
  // A failed scheduled send (#607) is PERSONAL to its author.
  { types: ["cyborg:schedule_message_failed"], pick: (p) => [p?.fromId as string | undefined] },
];

// Compute the delivery scope for a relay broadcast. Default is workspace-wide
// (both fields null). A type that is private narrows the audience here.
export function computeBroadcastScope(message: RelayMessage): BroadcastScope {
  const type = typeof message.type === "string" ? message.type : "";
  const payload = (message.payload ?? undefined) as Record<string, unknown> | undefined;

  let allowedUsers: Set<string> | null = null;
  const rule = USER_SCOPE_RULES.find((r) => r.types.includes(type));
  if (rule) {
    const picked = rule.pick(payload);
    // Fail open: a private type that arrives WITHOUT its scoping id (e.g. a notice
    // missing toUserId) keeps allowedUsers null → delivered to everyone, never an
    // empty set that silently drops it to no one. This matches the original inline
    // `if (p?.toUserId) allowedUsers = …` guard.
    const scoped = picked ? nonEmpty(...picked) : null;
    if (scoped && scoped.size > 0) allowedUsers = scoped;
  }

  // A private (DM) agent's stream/status is tagged by the daemon with the
  // initiator's email; scope delivery to that user. Fail-open: no tag → deliver
  // to everyone (unchanged). Email-scoped (not userId) because guest ids diverge
  // across stores while the email tag is stable.
  let allowedEmail: string | null = null;
  if (type === "cyborg:agent_stream" || type === "cyborg:agent_status") {
    const email = (payload as { privateToEmail?: string | null } | undefined)?.privateToEmail;
    if (email) allowedEmail = email;
  }

  return { allowedUsers, allowedEmail };
}
