import { describe, expect, it } from "vitest";
import { applyMarkdown, type MarkdownOp } from "./composer-markdown.js";

// Web-textarea ops (no whitespace trimming — the byte-for-byte legacy path).
const bold: MarkdownOp = { kind: "wrap", before: "*", after: "*", trimSelection: false };
const code: MarkdownOp = { kind: "wrap", before: "`", after: "`", trimSelection: false };
const codeBlock: MarkdownOp = {
  kind: "wrap",
  before: "```\n",
  after: "\n```",
  trimSelection: false,
};
const quotePrefix: MarkdownOp = { kind: "linePrefix", prefix: "> " };
const bulletPrefix: MarkdownOp = { kind: "linePrefix", prefix: "• " };

describe("applyMarkdown — wrap (bold/italic/strike/code)", () => {
  it("bold wraps the selection and keeps it selected (shifted past the marker)", () => {
    // "hello WORLD" — select "WORLD" [6,11].
    const r = applyMarkdown("hello WORLD", 6, 11, bold);
    expect(r.text).toBe("hello *WORLD*");
    // The wrapped word stays selected: anchor after the opening marker, head
    // after the word but before the closing marker.
    expect(r.selStart).toBe(7);
    expect(r.selEnd).toBe(12);
  });

  it("caret lands AFTER the inserted run on the native (collapse to selEnd)", () => {
    const r = applyMarkdown("hello WORLD", 6, 11, bold);
    // Native pill uses selEnd as its single caret — sits right after "WORLD",
    // before the closing "*".
    expect(r.text.slice(0, r.selEnd)).toBe("hello *WORLD");
  });

  it("empty selection inserts both markers and parks the caret BETWEEN them", () => {
    const r = applyMarkdown("hi ", 3, 3, bold);
    expect(r.text).toBe("hi **");
    expect(r.selStart).toBe(4); // after the opening "*"
    expect(r.selEnd).toBe(4); // collapsed — caret sits inside the markers
    // Caret between the two markers so the user can type inside.
    expect(r.text.slice(0, r.selEnd)).toBe("hi *");
  });

  it("toggling bold twice wraps a second time (legacy wrap has no unwrap)", () => {
    // Documents ACTUAL behavior: wrapSelection adds markers, it does not detect
    // existing ones. (Prefix toggles unwrap — see linePrefix below.)
    const once = applyMarkdown("WORD", 0, 4, bold);
    expect(once.text).toBe("*WORD*");
    // Re-select the inner word [1,5] and bold again.
    const twice = applyMarkdown(once.text, 1, 5, bold);
    expect(twice.text).toBe("**WORD**");
  });

  it("normalizes a backward selection (start > end)", () => {
    // Same range as the forward case but anchored the other way.
    const r = applyMarkdown("hello WORLD", 11, 6, bold);
    expect(r.text).toBe("hello *WORLD*");
    expect(r.selStart).toBe(7);
    expect(r.selEnd).toBe(12);
  });

  it("inline code wraps with backticks", () => {
    const r = applyMarkdown("run x now", 4, 5, code);
    expect(r.text).toBe("run `x` now");
  });

  it("code block wraps with a fenced multi-line marker", () => {
    const r = applyMarkdown("abc", 0, 3, codeBlock);
    expect(r.text).toBe("```\nabc\n```");
    // selStart sits just past the opening "```\n" (4 chars).
    expect(r.selStart).toBe(4);
    expect(r.selEnd).toBe(7);
  });

  it("trimSelection pulls surrounding spaces OUTSIDE the markers (native parity)", () => {
    // "a  hi  b" — select "  hi  " [1,7] with the inner spaces.
    const trimmed: MarkdownOp = { kind: "wrap", before: "_", after: "_", trimSelection: true };
    const r = applyMarkdown("a  hi  b", 1, 7, trimmed);
    // Markers hug "hi"; the leading/trailing spaces stay outside.
    expect(r.text).toBe("a  _hi_  b");
  });

  it("without trimSelection the spaces are wrapped verbatim (web path)", () => {
    const untrimmed: MarkdownOp = { kind: "wrap", before: "_", after: "_", trimSelection: false };
    // Select "  hi  " (indices 1..6). The web textarea path wraps exactly what
    // was selected — surrounding spaces land INSIDE the markers.
    const r = applyMarkdown("a  hi  b", 1, 7, untrimmed);
    expect(r.text).toBe("a_  hi  _b");
  });

  it("trimSelection on an all-whitespace selection collapses to an empty marker pair", () => {
    const trimmed: MarkdownOp = { kind: "wrap", before: "_", after: "_", trimSelection: true };
    const r = applyMarkdown("a   b", 1, 4, trimmed);
    // After trimming, start(4) > end(1) → empty selection; the markers are
    // inserted at the trimmed start. Byte-for-byte parity with the legacy native
    // wrapSelection (same slice math), so the inner spaces stay before "b".
    expect(r.text).toBe("a   __   b");
    expect(r.selEnd).toBe(5);
  });
});

describe("applyMarkdown — insert", () => {
  it("replaces the selection with the literal content, caret after it", () => {
    const r = applyMarkdown("see X here", 4, 5, { kind: "insert", content: "[t](u)" });
    expect(r.text).toBe("see [t](u) here");
    expect(r.selEnd).toBe(10); // after the inserted link
    expect(r.selStart).toBe(r.selEnd); // collapsed
  });

  it("inserts at a collapsed caret without removing anything", () => {
    const r = applyMarkdown("ab", 1, 1, { kind: "insert", content: "@" });
    expect(r.text).toBe("a@b");
    expect(r.selEnd).toBe(2);
  });
});

describe("applyMarkdown — linePrefix (blockquote / list toggle)", () => {
  it("blockquote prefixes the line the caret sits on", () => {
    const r = applyMarkdown("hello", 5, 5, quotePrefix);
    expect(r.text).toBe("> hello");
    expect(r.selEnd).toBe(7); // caret pushed right by "> "
  });

  it("blockquote prefixes only the CURRENT line (the one with the caret)", () => {
    // Two lines; caret on the second line (offset 8 = within "world").
    const text = "first\nworld";
    const r = applyMarkdown(text, 8, 8, quotePrefix);
    expect(r.text).toBe("first\n> world");
  });

  it("toggling the prefix a second time strips it (unwrap) and pulls the caret back", () => {
    const on = applyMarkdown("task", 4, 4, bulletPrefix);
    expect(on.text).toBe("• task");
    expect(on.selEnd).toBe(6);
    // Caret now after "• task"; toggle again removes the "• ".
    const off = applyMarkdown(on.text, on.selEnd, on.selEnd, bulletPrefix);
    expect(off.text).toBe("task");
    expect(off.selEnd).toBe(4);
  });

  it("prefix is added at the line start regardless of caret column within the line", () => {
    // Caret in the middle of the word; prefix still lands at column 0.
    const r = applyMarkdown("hello", 2, 2, quotePrefix);
    expect(r.text).toBe("> hello");
  });

  it("caret === 0 prefixes the FIRST line even when the text starts with a newline", () => {
    // Edge: collapsed caret at offset 0 over text whose first char is "\n".
    // lastIndexOf("\n", -1) clamps to index 0 and would wrongly match that
    // leading newline, landing the prefix on line 2. The caret>0 guard keeps
    // lineStart at 0 so "> " prepends the empty first line.
    const r = applyMarkdown("\nsecond", 0, 0, quotePrefix);
    expect(r.text).toBe("> \nsecond");
    expect(r.selEnd).toBe(2); // caret pushed right by "> ", still on line 1
    expect(r.selStart).toBe(2);
  });

  it("caret === 0 prefixes a plain first line (no leading newline)", () => {
    // Same caret=0 path without a leading "\n": lineStart resolves to 0 either
    // way, so this pins the non-regressing case alongside the edge above.
    const r = applyMarkdown("hello", 0, 0, quotePrefix);
    expect(r.text).toBe("> hello");
    expect(r.selEnd).toBe(2);
  });
});
