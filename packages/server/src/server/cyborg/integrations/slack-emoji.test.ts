import { describe, it, expect } from "vitest";
import { slackNameToEmoji, emojiToSlackName } from "./slack-emoji.js";

describe("slackNameToEmoji", () => {
  it("maps common Slack reaction names to their Unicode emoji", () => {
    expect(slackNameToEmoji("thumbsup")).toBe("👍");
    expect(slackNameToEmoji("heart")).toBe("❤️");
    expect(slackNameToEmoji("joy")).toBe("😂");
    expect(slackNameToEmoji("fire")).toBe("🔥");
    expect(slackNameToEmoji("tada")).toBe("🎉");
  });

  it("resolves aliases to the same emoji as the primary name", () => {
    // "+1" and "thumbsup" are the same reaction.
    expect(slackNameToEmoji("+1")).toBe("👍");
    expect(slackNameToEmoji("thumbsup")).toBe("👍");
    // "rofl" alias of "rolling_on_the_floor_laughing".
    expect(slackNameToEmoji("rofl")).toBe("🤣");
    expect(slackNameToEmoji("100")).toBe("💯");
  });

  it("strips a ::skin-tone-N modifier and maps the base", () => {
    expect(slackNameToEmoji("thumbsup::skin-tone-3")).toBe("👍");
    expect(slackNameToEmoji("wave::skin-tone-5")).toBe("👋");
  });

  it("tolerates surrounding colons and case", () => {
    expect(slackNameToEmoji(":thumbsup:")).toBe("👍");
    expect(slackNameToEmoji("ThumbsUp")).toBe("👍");
  });

  it("returns null for a custom/uncurated emoji (no destructive drop)", () => {
    expect(slackNameToEmoji("party_blob_custom")).toBeNull();
    expect(slackNameToEmoji("")).toBeNull();
  });
});

describe("emojiToSlackName", () => {
  it("maps a Unicode emoji to its primary Slack name", () => {
    expect(emojiToSlackName("👍")).toBe("+1");
    expect(emojiToSlackName("❤️")).toBe("heart");
    expect(emojiToSlackName("😂")).toBe("joy");
    expect(emojiToSlackName("🚀")).toBe("rocket");
  });

  it("strips a skin-tone modifier and maps the base emoji", () => {
    expect(emojiToSlackName("👍🏽")).toBe("+1");
    expect(emojiToSlackName("👋🏻")).toBe("wave");
  });

  it("strips a VS16 presentation selector", () => {
    // "❤" (no VS16) and "❤️" (with VS16) both resolve.
    expect(emojiToSlackName("❤️")).toBe("heart");
    expect(emojiToSlackName("❤")).toBe("heart");
  });

  it("returns null for an emoji absent from the curated table", () => {
    expect(emojiToSlackName("🫥")).toBeNull();
    expect(emojiToSlackName("")).toBeNull();
  });
});

describe("round-trip", () => {
  it("emoji → Slack name → emoji is stable for curated entries", () => {
    for (const emoji of ["👍", "❤️", "😂", "🎉", "🔥", "🚀", "👀", "🙏"]) {
      const name = emojiToSlackName(emoji);
      expect(name).not.toBeNull();
      expect(slackNameToEmoji(name as string)).toBe(emoji);
    }
  });
});
