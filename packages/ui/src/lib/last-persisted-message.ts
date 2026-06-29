import type { Message } from "./core/types.js";

// Local ephemera (slash arg-warning notes, the #210 "no daemon" alerts) carry
// seq:0, which compareMessages pins to the bottom of the list. They must be
// invisible to the slash-progress indicator: anchoring on one (MessageInput's
// dispatch capture) or comparing against one (MessageList's clear effect) leaves
// the "is summarizing…" indicator stranded until the note's TTL instead of
// clearing when the real reply lands. The last REAL message is the last one
// with a non-zero seq (every persisted message carries its server-assigned seq).
export function lastPersistedMessage(messages: readonly Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i].seq ?? 0) !== 0) return messages[i];
  }
  return undefined;
}

// The slash-progress clear rule (MessageList's effect): the reply has landed
// when the last PERSISTED message is a non-human message with a different id
// than the one captured at dispatch. Id-based, so client/server clock skew
// can't strand it; persisted-only, so a pinned seq:0 note can't either.
export function shouldClearSlashProgress(
  messages: readonly Message[],
  anchorLastMessageId: string | undefined,
): boolean {
  const last = lastPersistedMessage(messages);
  return !!last && last.fromType !== "human" && last.id !== anchorLastMessageId;
}
