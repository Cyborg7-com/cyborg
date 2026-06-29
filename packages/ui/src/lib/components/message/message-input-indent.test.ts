// Unit tests for the PURE list-indent helper that backs the composer's
// Tab/Shift+Tab (MessageInput.svelte → indentSelectedListLines). Imported from
// the shared module (NOT the .svelte file) so it's testable without a DOM.
import { describe, expect, it } from "vitest";
import {
  bulletGlyphForDepth,
  indentSelectedListLines,
  INDENT_UNIT,
  lineDepth,
  MAX_DEPTH,
  reglyphListLine,
} from "$lib/composer-list-indent.js";

describe("indentSelectedListLines", () => {
  it("indents a single bullet line, swaps the depth glyph, shifts caret +INDENT_UNIT", () => {
    // Caret in the middle of "• hey" (after "• h" → index 3).
    const res = indentSelectedListLines("• hey", 3, 3, 1);
    expect(res).not.toBeNull();
    // Depth 0 → 1: the glyph becomes ◦ (WYSIWYG). Length-neutral swap, so the
    // caret offsets are UNCHANGED from the pre-glyph behavior (regression guard).
    expect(res!.text).toBe("  ◦ hey");
    expect(res!.selStart).toBe(3 + INDENT_UNIT);
    expect(res!.selEnd).toBe(3 + INDENT_UNIT);
  });

  it("indents regardless of caret column (caret at line start)", () => {
    const res = indentSelectedListLines("• hey", 0, 0, 1);
    expect(res!.text).toBe("  ◦ hey");
    // A caret at column 0 rides the inserted spaces to keep its place in the text.
    expect(res!.selStart).toBe(INDENT_UNIT);
  });

  it("a second indent goes • → ◦ → ▪ at depth 2", () => {
    // Start already at depth 1 ("  ◦ deeper"); indent again to depth 2 → "▪".
    const res = indentSelectedListLines("  ◦ deeper", 4, 4, 1);
    expect(res!.text).toBe("    ▪ deeper");
    expect(res!.selStart).toBe(4 + INDENT_UNIT);
  });

  it("outdents an indented line back, swapping ◦ → • and clamping caret to start", () => {
    // Caret at column 1 (inside the 2-space prefix) of "  ◦ hey".
    const res = indentSelectedListLines("  ◦ hey", 1, 1, -1);
    expect(res!.text).toBe("• hey");
    // The removed prefix swallowed the caret → clamps to column 0.
    expect(res!.selStart).toBe(0);
    expect(res!.selEnd).toBe(0);
  });

  it("outdents shift the caret left when it sits past the removed prefix", () => {
    // Caret after "  ◦ h" (index 5) in "  ◦ hey"; outdent → "• hey".
    const res = indentSelectedListLines("  ◦ hey", 5, 5, -1);
    expect(res!.text).toBe("• hey");
    expect(res!.selStart).toBe(5 - INDENT_UNIT);
  });

  it("outdent reverses the glyph back toward • by depth (▪ → ◦)", () => {
    // Depth 2 ("    ▪ x") → depth 1 ("  ◦ x").
    const res = indentSelectedListLines("    ▪ x", 6, 6, -1);
    expect(res!.text).toBe("  ◦ x");
    expect(res!.selStart).toBe(6 - INDENT_UNIT);
  });

  it("indent at MAX_DEPTH is a no-op (returns null) — no glyph rewrite", () => {
    const maxIndent = " ".repeat(MAX_DEPTH * INDENT_UNIT);
    const src = `${maxIndent}• deep`;
    expect(lineDepth(src)).toBe(MAX_DEPTH);
    expect(indentSelectedListLines(src, src.length, src.length, 1)).toBeNull();
  });

  it("Tab on a non-list line returns null (lets Tab move focus)", () => {
    expect(indentSelectedListLines("just text", 4, 4, 1)).toBeNull();
  });

  it("outdent of a 1-space line removes that single (clamped) space", () => {
    // Only 1 leading space — outdent removes up to INDENT_UNIT, so just the 1.
    // Still depth 0 after, so the glyph stays •.
    const res = indentSelectedListLines(" • x", 3, 3, -1);
    expect(res!.text).toBe("• x");
    expect(res!.selStart).toBe(2);
  });

  it("outdent of an already-flush line returns null (nothing to remove)", () => {
    expect(indentSelectedListLines("• x", 2, 2, -1)).toBeNull();
  });

  it("indents EVERY list line in a multi-line selection, glyphing each by depth", () => {
    const src = "• a\n• b\n• c";
    // Select from the start through into the third line.
    const res = indentSelectedListLines(src, 0, src.length, 1);
    // Each line moves to depth 1 → ◦.
    expect(res!.text).toBe("  ◦ a\n  ◦ b\n  ◦ c");
    expect(res!.selStart).toBe(INDENT_UNIT); // caret rode the first line's inserted spaces
    // selEnd shifts by all three lines' inserted spaces (3 × INDENT_UNIT) —
    // unchanged from pre-glyph (length-neutral swap).
    expect(res!.selEnd).toBe(src.length + 3 * INDENT_UNIT);
  });

  it("mixed bullet + ordered selection: bullet glyphs swap, ordered keeps its N.", () => {
    const src = "- a\nplain\n1. b";
    const res = indentSelectedListLines(src, 0, src.length, 1);
    // The "-" bullet becomes the depth-1 glyph ◦; the ordered "1." is preserved.
    expect(res!.text).toBe("  ◦ a\nplain\n  1. b");
  });

  it("returns null when the selection has no list line at all", () => {
    expect(indentSelectedListLines("hello\nworld", 0, 11, 1)).toBeNull();
  });

  it("skips list lines inside a fenced code block", () => {
    const src = "```\n- not a list\n```";
    // Caret on the "- not a list" line (inside the fence).
    const at = src.indexOf("- not");
    expect(indentSelectedListLines(src, at, at, 1)).toBeNull();
  });

  it("indents ordered list lines too (keeps the literal number)", () => {
    const res = indentSelectedListLines("1. first", 0, 0, 1);
    expect(res!.text).toBe("  1. first");
  });
});

describe("depth + glyph contract", () => {
  it("derives depth from leading spaces, clamped at MAX_DEPTH", () => {
    expect(lineDepth("• a")).toBe(0);
    expect(lineDepth("  • a")).toBe(1);
    expect(lineDepth("    • a")).toBe(2);
    expect(lineDepth(" ".repeat(100) + "• a")).toBe(MAX_DEPTH);
  });

  it("cycles bullet glyphs •→◦→▪ by depth", () => {
    expect(bulletGlyphForDepth(0)).toBe("•");
    expect(bulletGlyphForDepth(1)).toBe("◦");
    expect(bulletGlyphForDepth(2)).toBe("▪");
    expect(bulletGlyphForDepth(3)).toBe("•"); // cycle repeats
    expect(bulletGlyphForDepth(4)).toBe("◦");
    expect(bulletGlyphForDepth(5)).toBe("▪");
  });
});

describe("reglyphListLine", () => {
  it("re-glyphs a bullet to the glyph for its NEW indent (depth-driven)", () => {
    expect(reglyphListLine("• x", INDENT_UNIT)).toBe("  ◦ x"); // depth 0 → 1
    expect(reglyphListLine("  ◦ x", 2 * INDENT_UNIT)).toBe("    ▪ x"); // 1 → 2
    expect(reglyphListLine("    ▪ x", INDENT_UNIT)).toBe("  ◦ x"); // 2 → 1
    expect(reglyphListLine("  ◦ x", 0)).toBe("• x"); // 1 → 0
  });

  it("accepts a literal '-' bullet and normalizes it to the depth glyph", () => {
    expect(reglyphListLine("- x", INDENT_UNIT)).toBe("  ◦ x");
    expect(reglyphListLine("- x", 0)).toBe("• x");
  });

  it("keeps the ordered marker's literal number (no glyph)", () => {
    expect(reglyphListLine("1. x", INDENT_UNIT)).toBe("  1. x");
    expect(reglyphListLine("  3. x", 0)).toBe("3. x");
  });

  it("preserves the inter-marker whitespace (length-neutral)", () => {
    // Two spaces after the marker survive the re-glyph; only the indent grows.
    expect(reglyphListLine("•  x", INDENT_UNIT)).toBe("  ◦  x");
  });

  it("leaves a non-list line untouched", () => {
    expect(reglyphListLine("just text", INDENT_UNIT)).toBe("just text");
  });
});
