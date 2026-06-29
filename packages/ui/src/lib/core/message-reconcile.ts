import type { Message } from "./types.js";

// Match an incoming server message to the optimistic `local-` row it settles
// (#501). Prefer the client-generated `clientMsgId` (exact — disambiguates two
// identical consecutive sends and retries); fall back to the legacy `(fromId,
// text)` content match for older relays that don't echo it. When the server DID
// echo a clientMsgId but no local row carries that id, only steal an UNTAGGED
// optimistic row — never collide with a different tagged send's bubble.
// Returns -1 when `msg` is itself a local row or no optimistic match exists.
//
// Pure (no Svelte runes) so it's unit-testable in isolation from the state store.
export function findOptimisticIndex(messages: Message[], msg: Message): number {
  if (msg.id.startsWith("local-")) return -1;
  if (msg.clientMsgId) {
    const exact = messages.findIndex(
      (m) => m.id.startsWith("local-") && m.clientMsgId === msg.clientMsgId,
    );
    if (exact >= 0) return exact;
    return messages.findIndex(
      (m) =>
        m.id.startsWith("local-") &&
        !m.clientMsgId &&
        m.fromId === msg.fromId &&
        m.text === msg.text,
    );
  }
  return messages.findIndex(
    (m) => m.id.startsWith("local-") && m.fromId === msg.fromId && m.text === msg.text,
  );
}
