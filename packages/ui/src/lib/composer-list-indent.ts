// Single source of truth for Mattermost-style list indentation, shared by the
// composer (MessageInput.svelte — Tab/Shift+Tab to indent/outdent a list line)
// and the renderer (render-markdown.ts — display the indentation as a nested
// sub-list). Both files MUST agree on this contract, so the constants and the
// depth/glyph maths live here and nowhere else.
//
// Contract:
//   - INDENT_UNIT = 2 spaces = one nesting level. Indentation is leading spaces.
//   - MAX_DEPTH = 5. Never indent past 5 levels (10 leading spaces).
//   - depth(line) = min(MAX_DEPTH, floor(leadingSpaces / INDENT_UNIT)).
//   - Unordered glyph BY DEPTH: 0 → "•", 1 → "◦", 2 → "▪", then the cycle
//     repeats (3 → "•", 4 → "◦", 5 → "▪"). WYSIWYG — the SOURCE text carries
//     the depth glyph so the composer textarea looks exactly like the render
//     (a native textarea can't restyle a glyph). The •/◦/▪ glyphs are all single
//     UTF-16 code units, so swapping one for another is LENGTH-NEUTRAL: only the
//     ±INDENT_UNIT leading spaces change a line's length, leaving the caret maths
//     below untouched.
//   - Ordered lists keep their literal "N." at every depth (Slack-parity — never
//     renumber/restart, never glyph-swapped).

/** Spaces per nesting level. Indentation is leading spaces on the line. */
export const INDENT_UNIT = 2;

/** Deepest nesting level (10 leading spaces). Indent never goes past this. */
export const MAX_DEPTH = 5;

/** Unordered bullet glyphs, cycled by depth modulo 3. */
const BULLET_GLYPHS = ["•", "◦", "▪"] as const;

/** Count the leading spaces on a single line (tabs are not indentation here). */
export function leadingSpaces(line: string): number {
  const m = line.match(/^( *)/);
  return m ? m[1].length : 0;
}

/** Nesting depth of a line from its leading spaces, clamped to MAX_DEPTH. */
export function lineDepth(line: string): number {
  return Math.min(MAX_DEPTH, Math.floor(leadingSpaces(line) / INDENT_UNIT));
}

/** Unordered bullet glyph for a depth (renderer-facing; source keeps "• "). */
export function bulletGlyphForDepth(depth: number): string {
  return BULLET_GLYPHS[depth % BULLET_GLYPHS.length];
}

// A list line is a bullet ("- "/"• "/"◦ "/"▪ ") or an ordered ("1." … "999.")
// marker, allowing leading spaces (the indentation). The ◦/▪ glyphs are matched
// because the source text now carries the depth glyph (WYSIWYG). Mirrors the
// renderer's matchers.
const LIST_LINE_RE = /^( *)([-•◦▪]|\d{1,3}\.)\s+/;

/** True when `line` (ignoring leading spaces) starts with a list marker. */
export function isListLine(line: string): boolean {
  return LIST_LINE_RE.test(line);
}

// Split a list line into (marker, gap, rest): the bare bullet glyph/dash or
// "N." ordered marker, the run of whitespace after it, and the remaining text.
// Leading spaces are excluded (the caller supplies the new indent). The gap is
// preserved verbatim so re-glyphing stays length-neutral. Returns null for a
// non-list line — callers gate on isListLine first, so this only narrows the type.
function splitListLine(line: string): { marker: string; gap: string; rest: string } | null {
  const m = line.match(/^ *([-•◦▪]|\d{1,3}\.)(\s+)(.*)$/s);
  if (!m) return null;
  return { marker: m[1], gap: m[2], rest: m[3] };
}

/**
 * Rewrite a list line so its leading indent is `newSpaces` and — for UNORDERED
 * bullets only — its glyph is `bulletGlyphForDepth(depth(newSpaces))`. Ordered
 * lines keep their literal "N." (Slack-parity). The glyph swap is length-neutral
 * (all glyphs are one UTF-16 unit) and the inter-marker whitespace is preserved,
 * so only the leading-space count changes the line length. PURE + exported so
 * the depth-glyph rule is unit-testable.
 */
export function reglyphListLine(line: string, newSpaces: number): string {
  const parts = splitListLine(line);
  if (!parts) return line; // not a list line — leave untouched
  const indent = " ".repeat(newSpaces);
  const isOrdered = /^\d/.test(parts.marker);
  const marker = isOrdered
    ? parts.marker
    : bulletGlyphForDepth(Math.min(MAX_DEPTH, Math.floor(newSpaces / INDENT_UNIT)));
  return `${indent}${marker}${parts.gap}${parts.rest}`;
}

/**
 * True if the line at byte `lineStart` sits inside an open ``` fenced block,
 * counting fence lines before it (odd count = inside). EXPORTED so the
 * composer's list-continuation / list-shortcut helpers (and the markdown
 * shortcuts) all gate on this ONE fence detector instead of re-implementing it.
 */
export function isInsideCodeBlockAt(src: string, lineStart: number): boolean {
  let fences = 0;
  for (const line of src.slice(0, lineStart).split("\n")) {
    if (/^\s*```/.test(line)) fences += 1;
  }
  return fences % 2 === 1;
}

export interface IndentResult {
  text: string;
  selStart: number;
  selEnd: number;
}

// Indent (dir = 1) or outdent (dir = -1) every list line touched by the
// selection [selStart, selEnd]. PURE — no DOM — so it's unit-testable and could
// be reused by the iOS native path later.
//
//   - A collapsed caret covers exactly its own line; a selection may span
//     several lines, and (Mattermost-parity) every list line in range is shifted.
//   - Non-list lines and lines inside a fenced code block are left untouched.
//   - Indent adds INDENT_UNIT spaces, capped at MAX_DEPTH (deeper lines skip).
//   - Outdent removes up to INDENT_UNIT leading spaces (clamped at 0).
//   - selStart/selEnd are adjusted so the same text stays selected / the caret
//     keeps its relative column within its line.
//   - Returns null when NO line in range is a list line (so the caller lets Tab
//     fall through to default focus movement — keyboard a11y) or when nothing
//     actually changed.
export function indentSelectedListLines(
  src: string,
  selStart: number,
  selEnd: number,
  dir: 1 | -1,
): IndentResult | null {
  // Expand the selection to whole-line boundaries.
  const firstLineStart = src.lastIndexOf("\n", selStart - 1) + 1;
  const nextNl = src.indexOf("\n", selEnd);
  const lastLineEnd = nextNl === -1 ? src.length : nextNl;

  const block = src.slice(firstLineStart, lastLineEnd);
  const lines = block.split("\n");

  let changed = false;
  let sawListLine = false;
  // Per-line signed delta (chars added/removed at the line start), so the caret
  // offsets can be recomputed precisely from the line a position falls on.
  const deltas: number[] = [];
  // Fence state carried incrementally (O(L+M) instead of re-scanning the whole
  // prefix per line). Seeded once with the open/closed state BEFORE the first
  // line, then toggled as we pass each ``` fence — matching isInsideCodeBlockAt:
  // a line's "inside" status is the state BEFORE it, so a fence line itself is
  // evaluated pre-toggle and the flip applies to SUBSEQUENT lines.
  let insideCodeBlock = isInsideCodeBlockAt(src, firstLineStart);

  const newLines = lines.map((line) => {
    const currentLineIsInside = insideCodeBlock;
    if (/^\s*```/.test(line)) {
      insideCodeBlock = !insideCodeBlock; // toggle for SUBSEQUENT lines
    }
    if (!isListLine(line) || currentLineIsInside) {
      deltas.push(0);
      return line;
    }
    sawListLine = true;
    const spaces = leadingSpaces(line);
    if (dir === 1) {
      // Indent — but never past MAX_DEPTH. Re-glyph the (now deeper) bullet to
      // its new depth's glyph; the swap is length-neutral so the delta stays
      // +INDENT_UNIT. Ordered lines keep their number (reglyphListLine handles).
      if (lineDepth(line) >= MAX_DEPTH) {
        deltas.push(0);
        return line;
      }
      changed = true;
      deltas.push(INDENT_UNIT);
      return reglyphListLine(line, spaces + INDENT_UNIT);
    }
    // Outdent — drop up to INDENT_UNIT leading spaces (clamped at 0), then
    // re-glyph the (now shallower) bullet. Length-neutral swap → delta = -remove.
    const remove = Math.min(INDENT_UNIT, spaces);
    if (remove === 0) {
      deltas.push(0);
      return line;
    }
    changed = true;
    deltas.push(-remove);
    return reglyphListLine(line, spaces - remove);
  });

  if (!sawListLine) return null; // not on a list → let Tab move focus (a11y)
  if (!changed) return null;

  const rebuilt = newLines.join("\n");
  const newText = src.slice(0, firstLineStart) + rebuilt + src.slice(lastLineEnd);

  // Adjust a caret position. Spaces are added/removed at the START of each line,
  // so a position on a shifted line moves by that line's delta (indent pushes the
  // caret right; outdent pulls it left, clamped to the new line start so a caret
  // that was inside the removed prefix lands at column 0). Positions on earlier
  // lines accumulate those lines' deltas via `shift`.
  const adjust = (pos: number): number => {
    let cursor = firstLineStart;
    let shift = 0;
    for (let i = 0; i < lines.length; i++) {
      const len = lines[i].length;
      const lineEnd = cursor + len; // exclusive of the trailing "\n"
      if (pos <= lineEnd) {
        const offsetInLine = pos - cursor;
        const applied = Math.max(0, offsetInLine + deltas[i]);
        return cursor + shift + applied;
      }
      shift += deltas[i];
      cursor = lineEnd + 1; // skip the "\n"
    }
    return pos + shift;
  };

  return { text: newText, selStart: adjust(selStart), selEnd: adjust(selEnd) };
}

// ─── List continuation + the "- "+space shortcut (PURE) ──────────────────────
// The composer's Enter / Space list editing lived inside the textarea KeyboardEvent
// handler (web) AND was duplicated for the iOS native pill, so the fiddliest code
// in the composer had ZERO coverage. These pure (text, caret) → {text, caret} | null
// cores are now the single source for BOTH paths. They REUSE this module's
// bulletGlyphForDepth / lineDepth (WYSIWYG depth glyphs) and isInsideCodeBlockAt
// (fence gating) so the continuation glyphs match the Tab-indent + render output.

export interface ListEdit {
  text: string;
  caret: number;
}

// Marker matchers shared by continuation (a FULL list line: indent, marker,
// gap, then the rest) — the ◦/▪ glyphs are matched because continued/indented
// bullets carry the depth glyph in the source (WYSIWYG).
const BULLET_LINE_RE = /^(\s*)([-•◦▪])\s+(.*)$/;
const ORDERED_LINE_RE = /^(\s*)(\d+)\.\s+(.*)$/;

/**
 * Enter pressed with the caret at the END of a list line. If that line is a
 * bullet / ordered item with CONTENT, continue the list: insert "\n" + the next
 * marker (next number for ordered; the depth-glyph bullet for unordered, so a
 * sub-bullet keeps its •/◦/▪). If the item is EMPTY, exit the list: drop the
 * marker line and leave a plain line. Returns null when the caret isn't at a
 * list line's end (caller lets Enter submit / insert a newline).
 *
 *   - `caret` must equal the line end (Slack parity — only continue from the end).
 *   - Lines inside a fenced ``` block are NOT list lines here (no continuation).
 */
export function continueList(text: string, caret: number): ListEdit | null {
  // caret === 0 → caret - 1 === -1, and lastIndexOf clamps -1 to index 0, which
  // would WRONGLY match a leading "\n" and push lineStart to 1. Guard so a caret
  // at the very start always resolves to line 0.
  const lineStart = caret > 0 ? text.lastIndexOf("\n", caret - 1) + 1 : 0;
  const nextNl = text.indexOf("\n", caret);
  const lineEnd = nextNl === -1 ? text.length : nextNl;
  if (caret !== lineEnd) return null; // only continue from the end of the line
  const line = text.slice(lineStart, lineEnd);
  const bullet = line.match(BULLET_LINE_RE);
  const ordered = line.match(ORDERED_LINE_RE);
  if (!bullet && !ordered) return null;
  if (isInsideCodeBlockAt(text, lineStart)) return null;

  const content = bullet ? bullet[3] : ordered![3];
  if (content.trim() === "") {
    // Empty item → drop the marker and exit the list.
    return { text: text.slice(0, lineStart) + text.slice(caret), caret: lineStart };
  }
  const marker = bullet
    ? `${bullet[1]}${bulletGlyphForDepth(lineDepth(line))} `
    : `${ordered![1]}${Number(ordered![2]) + 1}. `;
  const insert = `\n${marker}`;
  return { text: text.slice(0, caret) + insert + text.slice(caret), caret: caret + insert.length };
}

/**
 * The "- "+space markdown list shortcut. When the current line is EXACTLY a bare
 * marker ("-", "*", "+", or "1."–"999.") and the caret sits right after it (the
 * space being typed completes it), convert the line into a list line: ordered
 * keeps "N. ", bullets normalize to "• " (the toolbar/render glyph). Returns the
 * edited text with the caret after the new marker, or null when it doesn't apply
 * (not a bare marker, or inside a fenced code block). The caller is responsible
 * for only invoking this on a collapsed caret with no popup open and for
 * suppressing the space it would otherwise insert.
 */
export function listShortcut(text: string, caret: number): ListEdit | null {
  // caret === 0 → caret - 1 === -1, and lastIndexOf clamps -1 to index 0, which
  // would WRONGLY match a leading "\n" and push lineStart to 1. Guard so a caret
  // at the very start always resolves to line 0.
  const lineStart = caret > 0 ? text.lastIndexOf("\n", caret - 1) + 1 : 0;
  const beforeCaret = text.slice(lineStart, caret);
  const m = beforeCaret.match(/^([-+*]|\d{1,3}\.)$/);
  if (!m) return null;
  if (isInsideCodeBlockAt(text, lineStart)) return null;
  const marker = m[1];
  const replacement = /^\d/.test(marker) ? `${marker} ` : "• ";
  return {
    text: text.slice(0, lineStart) + replacement + text.slice(caret),
    caret: lineStart + replacement.length,
  };
}
