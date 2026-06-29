// The bump-gate shared by the channel_member_added / channel_member_removed /
// channel_cybo_added / channel_cybo_removed handlers (app.svelte.ts) — extracted
// here so the decision is testable (app.svelte.ts can't be imported under the
// plain-node vitest env because of Svelte runes), exactly like
// channel-mention-candidates.ts was extracted from MessageInput.svelte.
//
// The rule (#630/#635): when a member or cybo is added/removed to a channel I'm
// still a member of in the current workspace, bump that channel's mention-roster
// version so an open composer re-fetches fetch_channel_members / fetch_channel_
// cybos and the @-autocomplete updates live. This is SYMMETRIC across add/remove
// × human/cybo, and crucially fires for actor≠self removals (someone else removed
// from a channel I'm in) — the gap #635 reported.
//
// Self-removal from a PRIVATE channel is handled upstream by dropping the channel
// from my list FIRST; this gate then sees channelId ∉ myChannelIds and does not
// bump (correct — the channel is gone, there's no composer to refresh).

export interface RosterRefreshContext {
  /** Workspace the membership event is for. */
  eventWorkspaceId: string;
  /** Channel whose membership changed. */
  channelId: string;
  /** The workspace currently selected in the client (null if none). */
  currentWorkspaceId: string | null | undefined;
  /** Channels I'm currently a member of (workspaceState.channels ids). */
  myChannelIds: readonly string[];
}

// True when a membership change should refresh that channel's mention roster:
// the event is for my current workspace AND I'm still a member of the channel.
export function shouldRefreshChannelRoster(ctx: RosterRefreshContext): boolean {
  return (
    ctx.currentWorkspaceId === ctx.eventWorkspaceId && ctx.myChannelIds.includes(ctx.channelId)
  );
}

// Invoke `bump(channelId)` iff the membership change should refresh the roster.
// `bump` is injected (channelRosterState.bump in app.svelte.ts) so this stays a
// pure, testable seam.
export function refreshChannelRosterOnMembershipChange(
  ctx: RosterRefreshContext,
  bump: (channelId: string) => void,
): void {
  if (shouldRefreshChannelRoster(ctx)) bump(ctx.channelId);
}
