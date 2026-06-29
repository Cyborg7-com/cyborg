import { describe, expect, it } from "vitest";
import type { Message } from "./core/types.js";
import { isSelfSendForDivider, isUnreadForDivider } from "./unread-divider.js";

const ME = "me";

function msg(o: Partial<Message>): Message {
  return {
    id: "m1",
    channelId: "c1",
    fromId: ME,
    fromType: "human",
    text: "hi",
    createdAt: 100,
    ...o,
  } as Message;
}

// The bug: a webhook/CI card is injected under the creator's user id, so a
// webhook YOU created has fromId === you yet must still trip the unread divider
// (it isn't your own typing). Mirrors the notify path's isAutomation fix.
describe("isSelfSendForDivider", () => {
  it("treats a normal own-typed message as a self-send (excluded)", () => {
    expect(isSelfSendForDivider(msg({ fromId: ME }), ME)).toBe(true);
  });

  it("does NOT treat my own webhook card as a self-send (divider-eligible)", () => {
    expect(isSelfSendForDivider(msg({ fromId: ME, source: "webhook" }), ME)).toBe(false);
  });

  it("never treats another user's message as a self-send", () => {
    expect(isSelfSendForDivider(msg({ fromId: "other" }), ME)).toBe(false);
    expect(isSelfSendForDivider(msg({ fromId: "other", source: "webhook" }), ME)).toBe(false);
  });
});

describe("isUnreadForDivider", () => {
  const cursor = 100;

  it("counts a webhook card I created (fromId === me) as unread/divider-eligible", () => {
    expect(
      isUnreadForDivider(msg({ fromId: ME, source: "webhook", createdAt: 150 }), cursor, ME),
    ).toBe(true);
  });

  it("excludes my own genuinely-typed message even when newer than the cursor", () => {
    expect(isUnreadForDivider(msg({ fromId: ME, source: null, createdAt: 150 }), cursor, ME)).toBe(
      false,
    );
  });

  it("counts a peer's newer message as unread (unchanged behaviour)", () => {
    expect(isUnreadForDivider(msg({ fromId: "other", createdAt: 150 }), cursor, ME)).toBe(true);
  });

  it("excludes anything at or before the cursor, including a webhook card", () => {
    expect(isUnreadForDivider(msg({ fromId: "other", createdAt: 100 }), cursor, ME)).toBe(false);
    expect(
      isUnreadForDivider(msg({ fromId: ME, source: "webhook", createdAt: 90 }), cursor, ME),
    ).toBe(false);
  });
});
