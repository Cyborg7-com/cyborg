import type { Message } from "./core/types.js";

// The "New messages" / "New replies" divider freezes at the first loaded message
// newer than the viewer's read cursor that ISN'T the viewer's own send (the
// server cursor already excludes my sends, so my own typing never trips a line
// for myself). The naive self-check is `fromId === myId`, but a webhook/CI card
// is INJECTED under its creator's user id — so a webhook you created carries
// `fromId === myId` while not actually being your own typing. Treating it as a
// self-send (the bug) meant your own deploy/CI cards never got an unread divider.
//
// This mirrors the notify path's `isAutomation` fix (app.svelte.ts): a
// `source: "webhook"` message is an automation, not a self-send, so for divider
// purposes it counts as a normal incoming message and CAN be the first-unread
// the line sits above. Genuine own-typed messages (any non-webhook source with
// `fromId === myId`) stay excluded.
//
// Pure + side-effect-free so both divider sites (MessageList channel/DM,
// ThreadPanel replies) share ONE rule and can't drift, and so it's unit-testable.
export function isSelfSendForDivider(
  msg: Pick<Message, "fromId" | "source">,
  myId: string,
): boolean {
  return msg.fromId === myId && msg.source !== "webhook";
}

// True when `msg` is the kind of message the unread divider can sit above:
// strictly newer than the frozen `cursor` (epoch ms) and not the viewer's own
// send (webhook cards excluded from "own" — see isSelfSendForDivider).
export function isUnreadForDivider(
  msg: Pick<Message, "fromId" | "source" | "createdAt">,
  cursor: number,
  myId: string,
): boolean {
  return msg.createdAt > cursor && !isSelfSendForDivider(msg, myId);
}
