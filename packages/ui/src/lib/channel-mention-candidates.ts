// Channel @-mention candidates — extracted from MessageInput.svelte so the
// channel-scoping rule is testable.
//
// The bug it fixes: the composer suggested ALL workspace humans + cybos
// (workspaceState.members / cyboState.list) with no channel filter, while the
// channel "Members" tab shows only who's actually IN the channel (PG, via
// fetch_channel_members / fetch_channel_cybos). So a channel could list cybo
// "Apex test" as a member yet the @-autocomplete offered "Apex"/"Apex 2"
// (workspace cybos NOT in the channel) and omitted the real member.
//
// Rule: when a channel scope is known (the same PG truth the Members tab
// reads), suggest ONLY channel members — a non-member cybo isn't invokable
// there, so it must not be offered (and a non-member human can't read it). When
// the scope is null (a DM composer, or the roster hasn't loaded / the endpoint
// is unavailable), fall back to the workspace-wide list so mentions never break.

export interface MentionHuman {
  userId: string;
  name?: string | null;
  email: string;
  membershipType?: string;
}

export interface MentionAgent {
  id: string;
  name: string;
  role?: string | null;
}

// The channel's actual members (PG truth). null = unscoped (DM / not loaded).
export interface ChannelMentionScope {
  userIds: ReadonlySet<string>;
  cyboIds: ReadonlySet<string>;
}

export interface ScopedMentionCandidate {
  id: string;
  label: string;
  sublabel?: string;
  kind: "human" | "agent";
}

export function channelMentionCandidates(opts: {
  query: string;
  members: readonly MentionHuman[];
  cybos: readonly MentionAgent[];
  // null → workspace-wide (no channel context, or the channel roster isn't
  // loaded yet); a value → restrict to that channel's members.
  scope: ChannelMentionScope | null;
}): { humans: ScopedMentionCandidate[]; agents: ScopedMentionCandidate[] } {
  const q = opts.query.toLowerCase();
  const matchesQuery = (...fields: (string | null | undefined)[]): boolean =>
    !q || fields.some((f) => f?.toLowerCase().includes(q));

  const humans = opts.members
    .filter((m) => m.membershipType === "active")
    .filter((m) => !opts.scope || opts.scope.userIds.has(m.userId))
    .filter((m) => matchesQuery(m.name, m.email))
    .map(
      (m): ScopedMentionCandidate => ({
        id: m.userId,
        label: m.name ?? m.email.split("@")[0],
        sublabel: m.email,
        kind: "human",
      }),
    );

  const agents = opts.cybos
    .filter((c) => !opts.scope || opts.scope.cyboIds.has(c.id))
    .filter((c) => matchesQuery(c.name))
    .map(
      (c): ScopedMentionCandidate => ({
        id: `cybo:${c.id}`,
        label: c.name,
        sublabel: c.role ?? "Agent",
        kind: "agent",
      }),
    );

  return { humans, agents };
}

// The composer caps the merged @-mention list so agents (cybos) always survive
// even when many humans match — a flat `.slice(0, N)` put humans first and
// starved agents off the end. Reserve up to `agentReserve` slots for agents,
// fill the rest with humans, and keep the flat order everyone → humans → agents
// (no invented "Agents" header). Pure + generic so the composer (MessageInput)
// and its unit test share ONE policy instead of duplicating it.
export function applyMentionCap<T>(
  everyone: readonly T[],
  humans: readonly T[],
  agents: readonly T[],
  total = 12,
  agentReserve = 3,
): T[] {
  const humanCap = total - everyone.length - Math.min(agents.length, agentReserve);
  const pickedHumans = humans.slice(0, Math.max(0, humanCap));
  const agentCap = total - everyone.length - pickedHumans.length;
  const pickedAgents = agents.slice(0, Math.max(0, agentCap));
  return [...everyone, ...pickedHumans, ...pickedAgents];
}
