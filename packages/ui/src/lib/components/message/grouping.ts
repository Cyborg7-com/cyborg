import { isSameDay } from "$lib/utils.js";

// Shared message grouping + day-boundary predicates. The channel MessageList and
// the DM page both consume these so the two surfaces can't drift (DMs used to
// carry an inferior copy that ignored the time gap and had no date separator).

// Slack/Mattermost POST_COLLAPSE_TIMEOUT parity: consecutive same-author messages
// collapse under one avatar only when sent within this window.
export const GROUPING_WINDOW_MS = 300_000; // 5 min

// Minimal shape both callers satisfy (Message has all three).
interface Groupable {
  fromId: string;
  fromType: string;
  createdAt: number;
}

// True when `curr` should render grouped under `prev`: same author + type, within
// the collapse window, AND on the same calendar day. Encapsulating the day check
// here means every surface just asks `isGroupedWith` — no caller has to remember to
// also break the group at a date separator.
export function isGroupedWith(
  prev: Groupable,
  curr: Groupable,
  windowMs = GROUPING_WINDOW_MS,
): boolean {
  // Guard the gap's sign: an out-of-order pair (curr before prev, e.g. an
  // optimistic send with a skewed clock) yields a negative delta that would
  // otherwise slip under the window and wrongly group. Ordered lists always
  // have gap >= 0, so this is a no-op on the real render path.
  const gap = curr.createdAt - prev.createdAt;
  return (
    prev.fromId === curr.fromId &&
    prev.fromType === curr.fromType &&
    gap >= 0 &&
    gap < windowMs &&
    !isNewDay(prev, curr)
  );
}

// True when `curr` falls on a different calendar day than `prev` (local time) —
// the trigger for a date separator between them. Reuses the shared `isSameDay`
// helper so every surface uses one day-boundary definition.
export function isNewDay(prev: Groupable, curr: Groupable): boolean {
  return !isSameDay(prev.createdAt, curr.createdAt);
}
