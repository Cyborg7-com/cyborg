import { describe, it, expect } from "vitest";
import { isExternalSlack, resolveAvatarSource } from "./utils.js";

describe("resolveAvatarSource", () => {
  // The ONE rule, so the chat header / agents roster / session avatar never
  // disagree on what a cybo avatar IS (the bug: divergent emoji regexes).

  it("a single emoji → kind 'emoji'", () => {
    const s = resolveAvatarSource("🤖", "Apex");
    expect(s).toEqual({ kind: "emoji", value: "🤖" });
  });

  it("a multi-codepoint flag emoji → 'emoji' (the anchored /^\\p{Emoji}$/ regex got this WRONG)", () => {
    // 🇲🇽 is two regional-indicator code points; the old anchored single-char
    // regex rejected it → roster fell back to a broken photo while the header
    // showed the flag. The shared rule must classify it as emoji.
    const s = resolveAvatarSource("🇲🇽", "Mexico");
    expect(s.kind).toBe("emoji");
    expect(s.value).toBe("🇲🇽");
  });

  it("a ZWJ-sequence emoji → 'emoji' (also multi-codepoint)", () => {
    const family = "👨‍👩‍👧"; // man+ZWJ+woman+ZWJ+girl
    const s = resolveAvatarSource(family, "Family");
    expect(s.kind).toBe("emoji");
    expect(s.value).toBe(family);
  });

  it("a digit keycap emoji → 'emoji' (the URL guard's [0-9] must not eat it)", () => {
    // `0️⃣` is ASCII digit `0` (U+0030) + U+FE0F + U+20E3. It STARTS with a
    // digit, so the naive URL guard `^[a-z0-9/:.]` misclassified it as an
    // image. The guard now exempts the keycap sequence.
    for (const keycap of ["0️⃣", "5️⃣", "9️⃣"]) {
      const s = resolveAvatarSource(keycap, "Keycap");
      expect(s.kind).toBe("emoji");
      expect(s.value).toBe(keycap);
    }
  });

  it("symbol keycap emoji (#️⃣ / *️⃣) → 'emoji'", () => {
    for (const keycap of ["#️⃣", "*️⃣"]) {
      expect(resolveAvatarSource(keycap, "Sym").kind).toBe("emoji");
    }
  });

  it("a digit-led filename → 'image' (keycap exemption must NOT leak to paths)", () => {
    // Guards the regression boundary: a leading digit that is NOT a keycap
    // (a plain path/filename) stays an image.
    expect(resolveAvatarSource("10.png", "X").kind).toBe("image");
    expect(resolveAvatarSource("2024-avatar.png", "X").kind).toBe("image");
  });

  it("an https image URL → 'image'", () => {
    const url = "https://assets.cyborg7.com/avatars/abc.png";
    expect(resolveAvatarSource(url, "Apex")).toEqual({ kind: "image", value: url });
  });

  it("a URL that starts emoji-adjacent → 'image' (the URL guard)", () => {
    // Without the guard, a path/slug starting with a digit-or-letter that is
    // ALSO an Emoji code point (e.g. a leading digit) could be mistaken for an
    // emoji. Anything beginning like a URL/path/slug/data-URI stays an image.
    expect(resolveAvatarSource("0abc.png", "X").kind).toBe("image");
    expect(resolveAvatarSource("data:image/png;base64,iVBOR", "X").kind).toBe("image");
    expect(resolveAvatarSource("/uploads/cybo.png", "X").kind).toBe("image");
    expect(resolveAvatarSource("avatars/cybo.png", "X").kind).toBe("image");
  });

  it("a plain name (no avatar) → 'initials' of the name", () => {
    expect(resolveAvatarSource(null, "Apex Researcher")).toEqual({ kind: "initials", value: "AR" });
    expect(resolveAvatarSource(undefined, "Solo")).toEqual({ kind: "initials", value: "S" });
    expect(resolveAvatarSource("", "Solo")).toEqual({ kind: "initials", value: "S" });
  });

  it("no avatar AND no name → '?' initials (never throws)", () => {
    expect(resolveAvatarSource(null, "")).toEqual({ kind: "initials", value: "?" });
  });
});

describe("isExternalSlack", () => {
  // Synthetic Slack guest users have ids of the form `slack:<team>:<user>`; only
  // an id that STARTS with the `slack:` prefix is one. Everything else — real
  // uuid-ish member ids, empty strings, or ids that merely contain "slack:"
  // somewhere in the middle — is a normal user.

  it("a slack guest id (slack:<team>:<user>) → true", () => {
    expect(isExternalSlack("slack:T123:U456")).toBe(true);
  });

  it("a normal uuid-ish id → false", () => {
    expect(isExternalSlack("9f8b2c1a-4d5e-6789-abcd-ef0123456789")).toBe(false);
  });

  it("an empty string → false", () => {
    expect(isExternalSlack("")).toBe(false);
  });

  it("an id that only CONTAINS 'slack:' (not a prefix) → false", () => {
    expect(isExternalSlack("user:slack:x")).toBe(false);
  });
});
