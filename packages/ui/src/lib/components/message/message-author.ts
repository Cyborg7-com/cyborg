// One shared author-identity renderer for messages (#507).
//
// Before this, ChatMessage inlined the author identity (isAgent / displayName /
// the webhook-card avatar split) and MessageList / ThreadPanel each shaped their
// typing-indicator authors differently ({fromName?} vs {fromId, fromName}). The
// rules were the same everywhere; the code wasn't. This resolves the parts of an
// author's identity that live ON the message itself — no reactive app state — so
// the row header, the typing indicator, and <AuthorAvatar> all agree.
//
// What's intrinsic to a message (pure, resolvable here):
//   - userId : message.fromId
//   - name   : message.fromName, else the fromId prefix (the header fallback)
//   - type   : message.fromType ("human" | "agent" | "system")
//   - image  : ONLY the webhook-card author avatar. A webhook post must never
//              show the token owner's face, so its avatar is the release/event
//              card author's own GitHub avatar — and that travels on the message.
//
// What is NOT resolved here (it needs reactive state, so it stays in
// <AuthorAvatar>): a human's member image (getMemberImage), a cybo's roster
// avatar/provider glyph (cyboState / workspaceState.agents). Keeping those out
// is what makes this a pure, unit-testable function.

import type { Message } from "$lib/types.js";

export type MessageAuthorType = "human" | "agent" | "system";

export interface MessageAuthor {
  userId: string;
  name: string;
  type: MessageAuthorType;
  // Message-intrinsic avatar: the webhook card author's image, or null. Reactive
  // images (member photo, cybo avatar) are resolved by <AuthorAvatar>, not here.
  image: string | null;
}

// Display name resolution, identical to ChatMessage's old `displayName`:
// fromName when present, else the first 8 chars of the fromId.
export function authorName(message: Pick<Message, "fromName" | "fromId">): string {
  return message.fromName ?? message.fromId.slice(0, 8);
}

// The message-intrinsic author image. Only webhook posts carry one: the
// release/event card author's GitHub avatar (approval cards (#600) have no
// author). Everything else → null (the component resolves the live image).
function intrinsicImage(message: Message): string | null {
  if (message.source !== "webhook") return null;
  const c = message.card;
  return (c && c.kind !== "approval" ? c.author?.avatarUrl : null) ?? null;
}

export function messageAuthor(message: Message): MessageAuthor {
  return {
    userId: message.fromId,
    name: authorName(message),
    type: message.fromType,
    image: intrinsicImage(message),
  };
}

// Typing-indicator authors arrive in two shapes — MessageList passes
// `{ fromName? }`, ThreadPanel passes `{ fromId, fromName }` — but both resolve
// the SAME way: the sender's name, or "Someone" when it's unknown (a typing
// event can arrive before the roster has the name). Unify both callers through
// this so the fallback lives in one place.
export function typingAuthorName(author?: { fromName?: string } | null): string {
  return author?.fromName ?? "Someone";
}
