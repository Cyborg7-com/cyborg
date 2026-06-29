import { describe, expect, it } from "vitest";
import {
  bulletGlyphForDepth,
  continueList,
  indentSelectedListLines,
  isInsideCodeBlockAt,
  isListLine,
  lineDepth,
  leadingSpaces,
  listShortcut,
  reglyphListLine,
} from "./composer-list-indent.js";

// Caret helper: returns the index right after the FIRST occurrence of `marker`
// in `text` (keeps the list fixtures readable — "caret after this bit").
function caretAfter(text: string, marker: string): number {
  const i = text.indexOf(marker);
  if (i === -1) throw new Error(`marker not found: ${JSON.stringify(marker)}`);
  return i + marker.length;
}

describe("glyph + depth helpers (existing module — now covered)", () => {
  it("leadingSpaces counts only leading spaces", () => {
    expect(leadingSpaces("  hi")).toBe(2);
    expect(leadingSpaces("no")).toBe(0);
    expect(leadingSpaces("\thi")).toBe(0); // tabs are not indentation here
  });

  it("lineDepth maps leading spaces to a clamped depth (2 spaces / level, max 5)", () => {
    expect(lineDepth("• a")).toBe(0);
    expect(lineDepth("  • a")).toBe(1);
    expect(lineDepth("    • a")).toBe(2);
    expect(lineDepth(" ".repeat(20) + "• deep")).toBe(5); // clamped
  });

  it("bulletGlyphForDepth cycles • ◦ ▪ by depth modulo 3", () => {
    expect(bulletGlyphForDepth(0)).toBe("•");
    expect(bulletGlyphForDepth(1)).toBe("◦");
    expect(bulletGlyphForDepth(2)).toBe("▪");
    expect(bulletGlyphForDepth(3)).toBe("•"); // cycles
  });

  it("isListLine matches bullets / ordered markers with optional indent", () => {
    expect(isListLine("- a")).toBe(true);
    expect(isListLine("  • a")).toBe(true);
    expect(isListLine("◦ a")).toBe(true);
    expect(isListLine("12. a")).toBe(true);
    expect(isListLine("plain")).toBe(false);
  });

  it("reglyphListLine sets indent + depth glyph for bullets, keeps ordered numbers", () => {
    // Unordered bullet indented to depth 1 → "◦".
    expect(reglyphListLine("• a", 2)).toBe("  ◦ a");
    // Ordered keeps its literal number (Slack parity — never glyph-swapped).
    expect(reglyphListLine("1. a", 2)).toBe("  1. a");
    // Non-list line untouched.
    expect(reglyphListLine("plain", 2)).toBe("plain");
  });
});

describe("isInsideCodeBlockAt (now exported + shared)", () => {
  it("is false before any fence and inside an odd number of fences", () => {
    const src = "before\n```\ninside\n```\nafter\n";
    expect(isInsideCodeBlockAt(src, 0)).toBe(false); // before the first ```
    const insideAt = src.indexOf("inside");
    expect(isInsideCodeBlockAt(src, insideAt)).toBe(true); // 1 fence before → inside
    const afterAt = src.indexOf("after");
    expect(isInsideCodeBlockAt(src, afterAt)).toBe(false); // 2 fences before → outside
  });
});

describe("listShortcut — '- '+space converts a bare marker to a list line", () => {
  it("converts a bare '-' (caret right after it) into a '• ' bullet", () => {
    const text = "-";
    const r = listShortcut(text, caretAfter(text, "-"));
    expect(r).not.toBeNull();
    expect(r!.text).toBe("• ");
    expect(r!.caret).toBe(2); // after "• "
  });

  it("normalizes '*' and '+' bullets to '• ' too", () => {
    expect(listShortcut("*", 1)!.text).toBe("• ");
    expect(listShortcut("+", 1)!.text).toBe("• ");
  });

  it("keeps an ordered 'N.' marker as 'N. '", () => {
    const r = listShortcut("12.", 3);
    expect(r!.text).toBe("12. ");
    expect(r!.caret).toBe(4);
  });

  it("converts the marker on the CURRENT line only (preserves earlier lines)", () => {
    const text = "first line\n-";
    const r = listShortcut(text, text.length);
    expect(r!.text).toBe("first line\n• ");
  });

  it("only considers the text BEFORE the caret (marker + rest-of-line still fires)", () => {
    // Parity with the legacy tryListShortcut: it matches the marker before the
    // caret regardless of what follows it on the line. "- already" with the caret
    // right after "-" converts the marker; the rest of the line is left intact.
    const r = listShortcut("- already", 1);
    expect(r!.text).toBe("•  already");
  });

  it("returns null when the text before the caret is not exactly a bare marker", () => {
    expect(listShortcut("ab", 2)).toBeNull(); // letters, not a marker
    expect(listShortcut("1234.", 5)).toBeNull(); // > 3 digits
    expect(listShortcut("• x", 3)).toBeNull(); // already a list line, not a bare marker
  });

  it("is suppressed inside a fenced code block", () => {
    const text = "```\n-";
    expect(listShortcut(text, text.length)).toBeNull();
  });

  it("caret === 0 resolves to line 0 (empty before-caret → null, no leading-\\n mismatch)", () => {
    // Edge: caret at offset 0 over text starting with "\n". The caret>0 guard
    // keeps lineStart at 0; before-caret is empty so it correctly doesn't fire.
    expect(listShortcut("\n-", 0)).toBeNull();
  });
});

describe("continueList — Enter continues or exits a list", () => {
  it("Enter at the end of a '• ' item inserts the next bullet", () => {
    const text = "• apples";
    const r = continueList(text, text.length);
    expect(r).not.toBeNull();
    expect(r!.text).toBe("• apples\n• ");
    expect(r!.caret).toBe(text.length + 3); // after "\n• "
  });

  it("Enter at the end of an ordered item increments the number", () => {
    const text = "1. first";
    const r = continueList(text, text.length);
    expect(r!.text).toBe("1. first\n2. ");
  });

  it("an indented bullet continues with the DEPTH glyph, not the reused char", () => {
    // Depth-1 bullet (◦). Continuation keeps the indent + depth glyph.
    const text = "  ◦ nested";
    const r = continueList(text, text.length);
    expect(r!.text).toBe("  ◦ nested\n  ◦ ");
  });

  it("Enter on an EMPTY item drops the marker and exits the list", () => {
    const text = "• done\n• ";
    const r = continueList(text, text.length);
    expect(r).not.toBeNull();
    // The trailing empty "• " line is removed (exit the list).
    expect(r!.text).toBe("• done\n");
    expect(r!.caret).toBe("• done\n".length);
  });

  it("only continues from the END of the line (caret mid-item → null)", () => {
    const text = "• apples";
    expect(continueList(text, 3)).toBeNull(); // caret inside "apples"
  });

  it("returns null on a non-list line", () => {
    const text = "just a sentence";
    expect(continueList(text, text.length)).toBeNull();
  });

  it("is suppressed inside a fenced code block", () => {
    const text = "```\n- code";
    expect(continueList(text, text.length)).toBeNull();
  });

  it("caret === 0 resolves to line 0 (empty line → null, no leading-\\n mismatch)", () => {
    // Edge: caret at offset 0 over text starting with "\n". The caret>0 guard
    // keeps lineStart at 0 so the (empty) first line is read correctly → null.
    expect(continueList("\n• x", 0)).toBeNull();
  });
});

describe("indentSelectedListLines (existing — smoke coverage of the shared core)", () => {
  it("indents a single list line by one level and re-glyphs the bullet", () => {
    const text = "• a";
    const r = indentSelectedListLines(text, 0, 0, 1);
    expect(r).not.toBeNull();
    expect(r!.text).toBe("  ◦ a"); // +2 spaces, depth-1 glyph
  });

  it("outdents back to depth 0", () => {
    const text = "  ◦ a";
    const r = indentSelectedListLines(text, text.length, text.length, -1);
    expect(r!.text).toBe("• a");
  });

  it("returns null on a non-list line (let Tab move focus)", () => {
    expect(indentSelectedListLines("plain", 0, 0, 1)).toBeNull();
  });

  it("blockquote-style fence: a list line inside a code block is not indented", () => {
    const text = "```\n- inside\n```";
    const start = text.indexOf("- inside");
    expect(indentSelectedListLines(text, start, start, 1)).toBeNull();
  });
});
