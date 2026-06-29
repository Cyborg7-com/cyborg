// Pure markdown-insertion core for the composer (MessageInput.svelte), extracted
// as a TEST SEAM. The component's toolbar buttons + ⌘B/⌘I shortcuts mutate the
// live <textarea> (read selectionStart/End, splice `text`, reposition the
// caret); the iOS native pill runs the SAME edits on a mirrored (text, caret)
// pair. Both paths are now thin adapters over the pure transforms here, so the
// fiddly string maths (wrap, toggle-prefix, caret landing) is unit-testable in
// isolation and the web/native paths can't drift.
//
// Contract: every op takes the FULL `text` plus the selection [start, end] and
// returns the new text + the new selection [selStart, selEnd]. The web adapter
// keeps the range selected (selStart..selEnd); the native pill takes a single
// caret and uses selEnd (the end of the inserted run). For a collapsed input
// selection (start === end) the result is also collapsed (selStart === selEnd).

export type MarkdownOp =
  | {
      // Wrap the selection with `before`/`after` markers (bold/italic/strike/
      // code/code-block). `trimSelection` keeps surrounding whitespace OUTSIDE
      // the markers (`_ hi _` is invalid markdown — the marker must touch a
      // non-space char); the web textarea path passes false (byte-for-byte
      // legacy behavior), the native pill passes true.
      kind: "wrap";
      before: string;
      after: string;
      trimSelection: boolean;
    }
  | {
      // Replace the selection with literal `content` (emoji, a [text](url)
      // link, an "@"). Caret lands after the inserted content.
      kind: "insert";
      content: string;
    }
  | {
      // Toggle a line PREFIX (bullet "• ", ordered "1. ", blockquote "> ") on
      // the line the selection START sits on: add it if absent, strip it if the
      // line already begins with it. The caret shifts by ±prefix.length.
      kind: "linePrefix";
      prefix: string;
    };

export interface MarkdownResult {
  text: string;
  /** Selection anchor after the edit (web textarea keeps anchor..head). */
  selStart: number;
  /** Selection head / single caret after the edit (native pill uses this). */
  selEnd: number;
}

/**
 * Apply a markdown op to `text` over the selection [start, end]. PURE — no DOM.
 * `start`/`end` are byte offsets; they are normalized so start ≤ end (a backward
 * selection is handled). Returns the new text and the new selection.
 */
export function applyMarkdown(
  text: string,
  start: number,
  end: number,
  op: MarkdownOp,
): MarkdownResult {
  // Clamp into [0, text.length] so an out-of-range or negative offset can't
  // drive a bad slice. DOM selectionStart/End are always in range, so this is
  // defensive only — behavior is unchanged for any valid selection.
  const len = text.length;
  const lo = Math.max(0, Math.min(len, Math.min(start, end)));
  const hi = Math.max(0, Math.min(len, Math.max(start, end)));

  switch (op.kind) {
    case "wrap":
      return wrap(text, lo, hi, op.before, op.after, op.trimSelection);
    case "insert": {
      const next = text.slice(0, lo) + op.content + text.slice(hi);
      const pos = lo + op.content.length;
      return { text: next, selStart: pos, selEnd: pos };
    }
    case "linePrefix":
      return linePrefix(text, lo, op.prefix);
  }
}

function wrap(
  text: string,
  lo: number,
  hi: number,
  before: string,
  after: string,
  trimSelection: boolean,
): MarkdownResult {
  let start = lo;
  let end = hi;
  if (trimSelection) {
    // Pull leading/trailing whitespace OUT of the wrapped range so the markers
    // hug the text. Only matters for a non-empty selection.
    const raw = text.slice(lo, hi);
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    start = lo + lead;
    end = hi - trail;
  }
  const selected = text.slice(start, end);
  if (selected) {
    // Inline emphasis must NOT span a newline: render-markdown.ts parses markdown
    // line-by-line (split("\n")), so a single `before…after` pair wrapped around a
    // multi-line selection straddles the `\n` and the markers render literally
    // (the same cross-newline defect as the iOS serializer). When the selection
    // spans lines, wrap EACH line in its own balanced pair; the `\n` separators and
    // any empty / whitespace-only line stay unwrapped (no stray `**` on a blank
    // line). A single-line selection keeps the exact legacy output below.
    // Only inline emphasis markers get per-line balancing. A fenced code block's
    // markers (before="```\n", after="\n```") legitimately span newlines and the
    // renderer reads the fenced body across lines, so it must stay one pair.
    const isInlineMarker = !before.includes("\n") && !after.includes("\n");
    if (selected.includes("\n") && isInlineMarker) {
      const wrapped = selected
        .split("\n")
        .map((line) => {
          if (line.trim() === "") return line; // blank/whitespace line → no markers
          const lead = line.length - line.trimStart().length;
          const trail = line.length - line.trimEnd().length;
          // Hug: markers touch the non-space core, edge spaces stay outside.
          return (
            line.slice(0, lead) +
            before +
            line.slice(lead, line.length - trail) +
            after +
            line.slice(line.length - trail)
          );
        })
        .join("\n");
      const next = text.slice(0, start) + wrapped + text.slice(end);
      // Keep the wrapped block selected: anchor after the first opening marker,
      // head at the end of the wrapped text minus the final closing marker.
      return {
        text: next,
        selStart: start + before.length,
        selEnd: start + wrapped.length - after.length,
      };
    }
    const next = text.slice(0, start) + before + selected + after + text.slice(end);
    // Keep the original text selected (now shifted right by the opening marker);
    // the native pill collapses to selEnd = end of the inserted run.
    return { text: next, selStart: start + before.length, selEnd: end + before.length };
  }
  // Empty selection: drop both markers and place the caret between them so the
  // user can type inside.
  const next = text.slice(0, start) + before + after + text.slice(end);
  const pos = start + before.length;
  return { text: next, selStart: pos, selEnd: pos };
}

function linePrefix(text: string, caret: number, prefix: string): MarkdownResult {
  // caret === 0 → caret - 1 === -1, and lastIndexOf clamps -1 to index 0, which
  // would WRONGLY match a leading "\n" and push lineStart to 1. Guard so a caret
  // at the very start always resolves to line 0.
  const lineStart = caret > 0 ? text.lastIndexOf("\n", caret - 1) + 1 : 0;
  const currentLine = text.slice(lineStart, caret);
  if (currentLine.startsWith(prefix)) {
    // Toggle off: strip the prefix from the line start, pull the caret back.
    const next = text.slice(0, lineStart) + currentLine.slice(prefix.length) + text.slice(caret);
    const pos = caret - prefix.length;
    return { text: next, selStart: pos, selEnd: pos };
  }
  // Toggle on: insert the prefix at the line start, push the caret forward.
  const next = text.slice(0, lineStart) + prefix + text.slice(lineStart);
  const pos = caret + prefix.length;
  return { text: next, selStart: pos, selEnd: pos };
}
