// Channel visibility helpers (#608) — group DMs are hidden group_dm channels.
// Centralized + side-effect-free so the "is this a browsable channel vs. a group
// DM" rule can't drift between the sidebar, the quick switcher, the message
// search scope, and the channel browser, and stays unit-testable.

import type { Channel } from "$lib/core/types";

// A group DM is a channel whose kind is "group_dm". Older payloads omit `type`
// (→ "regular"); some only carry `isHidden` — treat either signal as a group DM
// so a hidden channel never leaks into a browse/search/channel surface.
export function isGroupDm(channel: Pick<Channel, "type" | "isHidden">): boolean {
  return channel.type === "group_dm" || channel.isHidden === true;
}

// The ordinary, browsable channels — everything that is NOT a group DM. Use this
// wherever the UI lists "channels" (sidebar project groups, quick switcher
// channel section, message-search channel scope, channel browser).
export function visibleChannels<T extends Pick<Channel, "type" | "isHidden">>(
  channels: readonly T[],
): T[] {
  return channels.filter((c) => !isGroupDm(c));
}

// The group DMs the user belongs to — they list under the sidebar's DM section,
// never under Channels. fetch_channels is already member-scoped, so every group
// DM returned here is one the current user is a member of.
export function groupDmChannels<T extends Pick<Channel, "type" | "isHidden">>(
  channels: readonly T[],
): T[] {
  return channels.filter((c) => isGroupDm(c));
}
