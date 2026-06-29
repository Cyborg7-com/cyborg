// Unit tests for the PURE message-author identity helper (#507). Imported from
// the shared .ts module (NOT AuthorAvatar.svelte) so it runs without a DOM —
// it resolves only the parts of an author's identity that travel ON the message
// (userId / name / type / the webhook-card author image). The reactive image
// resolution (member photo, cybo avatar) lives in <AuthorAvatar> and is out of
// scope here.
import { describe, expect, it } from "vitest";
import type { Message } from "$lib/types.js";
import { authorName, messageAuthor, typingAuthorName } from "./message-author.js";

// Minimal valid Message; tests override the author-relevant fields.
function msg(overrides: Partial<Message>): Message {
  return {
    id: "m1",
    channelId: "c1",
    fromId: "user-123",
    fromType: "human",
    text: "hi",
    seq: 1,
    createdAt: 0,
    ...overrides,
  };
}

describe("authorName", () => {
  it("uses fromName when present", () => {
    expect(authorName({ fromName: "Ada", fromId: "user-123" })).toBe("Ada");
  });

  it("falls back to the first 8 chars of fromId (the header fallback)", () => {
    // No fromName → the fromId prefix, exactly as the ChatMessage header did.
    expect(authorName({ fromName: undefined, fromId: "abcdef0123456789" })).toBe("abcdef01");
  });
});

describe("messageAuthor", () => {
  it("carries userId / name / type for a human, with no intrinsic image", () => {
    // Humans resolve their photo via getMemberImage in <AuthorAvatar>, NOT here,
    // so the pure helper reports image: null.
    const a = messageAuthor(msg({ fromId: "u1", fromName: "Ada", fromType: "human" }));
    expect(a).toEqual({ userId: "u1", name: "Ada", type: "human", image: null });
  });

  it("reports type 'agent' and no intrinsic image for an agent message", () => {
    // Agent avatars (cybo photo/emoji/provider glyph) are reactive → resolved in
    // the component; the pure helper has no image for them.
    const a = messageAuthor(msg({ fromId: "cybo-1", fromName: "Apex", fromType: "agent" }));
    expect(a).toEqual({ userId: "cybo-1", name: "Apex", type: "agent", image: null });
  });

  it("preserves the system type", () => {
    expect(messageAuthor(msg({ fromType: "system", fromName: "System" })).type).toBe("system");
  });

  it("name falls back to the fromId prefix when fromName is absent", () => {
    expect(messageAuthor(msg({ fromId: "ABCDEFGHIJ", fromName: undefined })).name).toBe("ABCDEFGH");
  });

  // Webhook posts must NOT show the token owner's face — their avatar is the
  // release/event card author's own GitHub image, which travels on the message.
  it("a webhook release-card post resolves the card author's avatar as the intrinsic image", () => {
    const a = messageAuthor(
      msg({
        fromType: "human",
        fromName: "acme/repo",
        source: "webhook",
        card: {
          kind: "release",
          author: { login: "octocat", avatarUrl: "https://gh/oct.png" },
        } as Message["card"],
      }),
    );
    expect(a.image).toBe("https://gh/oct.png");
    expect(a.name).toBe("acme/repo");
  });

  it("a webhook event-card post with a null card author yields no image", () => {
    const a = messageAuthor(
      msg({
        source: "webhook",
        card: { kind: "pull_request", author: null } as Message["card"],
      }),
    );
    expect(a.image).toBeNull();
  });

  // Approval cards (#600) have no author field — must not be read for an image.
  it("a webhook approval-card post yields no image (approval cards carry no author)", () => {
    const a = messageAuthor(
      msg({
        source: "webhook",
        card: { kind: "approval" } as Message["card"],
      }),
    );
    expect(a.image).toBeNull();
  });

  it("a non-webhook message never reports a card image", () => {
    // Same card shape, but without source==="webhook" the helper ignores it.
    const a = messageAuthor(
      msg({
        source: "mcp",
        card: {
          kind: "release",
          author: { login: "octocat", avatarUrl: "https://gh/oct.png" },
        } as Message["card"],
      }),
    );
    expect(a.image).toBeNull();
  });
});

describe("typingAuthorName", () => {
  it("uses fromName when the typing event carries it (ThreadPanel's {fromId, fromName})", () => {
    expect(typingAuthorName({ fromName: "Ada" })).toBe("Ada");
  });

  it("falls back to 'Someone' when the name is unknown (MessageList's {fromName?})", () => {
    expect(typingAuthorName({})).toBe("Someone");
    expect(typingAuthorName({ fromName: undefined })).toBe("Someone");
  });

  // Null-safe: a typing author can be absent entirely (an unresolved roster
  // lookup hands the helper null/undefined) — it must still resolve "Someone"
  // rather than throw on a missing object.
  it("returns 'Someone' for an absent author ({}, { fromName: undefined }, null, undefined)", () => {
    expect(typingAuthorName({})).toBe("Someone");
    expect(typingAuthorName({ fromName: undefined })).toBe("Someone");
    expect(typingAuthorName(null)).toBe("Someone");
    expect(typingAuthorName(undefined)).toBe("Someone");
  });
});
