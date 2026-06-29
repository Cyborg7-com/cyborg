import { describe, expect, it, vi } from "vitest";
import {
  refreshChannelRosterOnMembershipChange,
  shouldRefreshChannelRoster,
} from "./channel-roster-refresh.js";

// #635: the asymmetric sibling of #633. The channel_member_removed handler must
// bump the affected channel's mention-roster version for actor≠self removals
// (someone ELSE removed from a channel I'm in) so the ex-member drops from
// @-autocomplete live — not just for self-removal. This exercises the REAL gate
// the handler runs (refreshChannelRosterOnMembershipChange) with a spy standing
// in for channelRosterState.bump, rather than the downstream pure scope→
// candidates filter. app.svelte.ts itself can't be imported under the plain-node
// vitest env (Svelte runes), so the gate is extracted here — same pattern as
// channel-mention-candidates.ts.

const WS = "ws_1";
const CH = "ch_general";
// The channels I'm currently a member of (workspaceState.channels ids).
const MY_CHANNELS = ["ch_general", "ch_random"];

describe("refreshChannelRosterOnMembershipChange — the handler bump gate (#635)", () => {
  it("actor≠self removal from a channel I'm in → bump IS called for that channel", () => {
    const bump = vi.fn();
    // Simulate the broadcast: another user (u_bob) removed from #general, which I
    // am still a member of. The handler passes my current channel ids unchanged.
    refreshChannelRosterOnMembershipChange(
      {
        eventWorkspaceId: WS,
        channelId: CH,
        currentWorkspaceId: WS,
        myChannelIds: MY_CHANNELS,
      },
      bump,
    );
    expect(bump).toHaveBeenCalledTimes(1);
    expect(bump).toHaveBeenCalledWith(CH);
  });

  it("self-removal from a PRIVATE channel (already dropped from my list) → bump NOT called", () => {
    const bump = vi.fn();
    // The self/private branch upstream removes the channel from my list FIRST, so
    // by the time the gate runs, CH ∉ myChannelIds → no refresh (channel is gone).
    refreshChannelRosterOnMembershipChange(
      {
        eventWorkspaceId: WS,
        channelId: CH,
        currentWorkspaceId: WS,
        myChannelIds: ["ch_random"], // CH already removed
      },
      bump,
    );
    expect(bump).not.toHaveBeenCalled();
  });

  it("event for a different workspace → bump NOT called", () => {
    const bump = vi.fn();
    refreshChannelRosterOnMembershipChange(
      {
        eventWorkspaceId: "ws_other",
        channelId: CH,
        currentWorkspaceId: WS,
        myChannelIds: MY_CHANNELS,
      },
      bump,
    );
    expect(bump).not.toHaveBeenCalled();
  });

  it("removal in a channel I'm not a member of → bump NOT called", () => {
    const bump = vi.fn();
    refreshChannelRosterOnMembershipChange(
      {
        eventWorkspaceId: WS,
        channelId: "ch_i_am_not_in",
        currentWorkspaceId: WS,
        myChannelIds: MY_CHANNELS,
      },
      bump,
    );
    expect(bump).not.toHaveBeenCalled();
  });

  it("no workspace selected (currentWorkspaceId null) → bump NOT called", () => {
    const bump = vi.fn();
    refreshChannelRosterOnMembershipChange(
      { eventWorkspaceId: WS, channelId: CH, currentWorkspaceId: null, myChannelIds: MY_CHANNELS },
      bump,
    );
    expect(bump).not.toHaveBeenCalled();
  });

  it("symmetry: the SAME gate backs add / cybo-add / cybo-remove (any member change in my channel bumps)", () => {
    // The add and cybo handlers route through this same function, so a true gate
    // here is what makes add/remove × human/cybo symmetric.
    expect(
      shouldRefreshChannelRoster({
        eventWorkspaceId: WS,
        channelId: CH,
        currentWorkspaceId: WS,
        myChannelIds: MY_CHANNELS,
      }),
    ).toBe(true);
  });
});
