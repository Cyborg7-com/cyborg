// Math expression parser for message content — pure, zero-dep.
//
// Ported VERBATIM from the Math Library (math-library/src/lib/utils/math-parser.ts).
// Detects inline ($...$) and block ($$...$$ / \[...\] / \(...\) / \begin{}…\end{})
// LaTeX math expressions, handling overlap (block math takes precedence over
// inline). Used by the KaTeX pre-pass in render-markdown.ts.
//
// This file has NO dependencies and emits no HTML — it only locates math spans.
// KaTeX rendering + DOMPurify sanitization happen downstream.

/** Matches inline math: $...$ (not preceded/followed by $ or digit, no leading space) */
export const INLINE_MATH_RE =
  /(?<!\$)(?<![0-9\\])\$(?![$\s])([^$\\]*(?:\\.[^$\\]*)*)\$(?!\$)(?![0-9])/g;

/** Matches block math: $$...$$ (no leading space, no trailing backslash+space) */
export const BLOCK_MATH_RE = /\$\$(?!\s)([\s\S]*?[^\\\s])\$\$/g;

/** Matches display math: \[...\] (standard LaTeX) */
const BRACKET_DISPLAY_RE = /\\\[([\s\S]*?)\\\]/g;

/** Matches inline math: \(...\) (standard LaTeX) */
const PAREN_INLINE_RE = /\\\(([\s\S]*?)\\\)/g;

/** Matches LaTeX environments: \begin{align}...\end{align} etc. */
const BEGIN_END_RE = /(\\begin\{([a-z*]+)\}[\s\S]+?\\end\{\2\})/gm;

/** Strip leading blockquote markers (>) from multiline math content */
function stripBlockquoteMarkers(latex: string): string {
  return latex.replace(/^\s*>/gm, "");
}

export interface MathMatch {
  /** Start index in the source string */
  index: number;
  /** Total length of the matched text including delimiters */
  length: number;
  /** The LaTeX content (without delimiters) */
  latex: string;
  /** Whether this is display/block math ($$...$$) vs inline ($...$) */
  display: boolean;
}

/**
 * Find all math expressions in a string.
 * Block math ($$...$$) takes precedence — overlapping inline matches are discarded.
 * Returns matches sorted by index (ascending).
 */
export function parseMathExpressions(text: string): MathMatch[] {
  const matches: MathMatch[] = [];
  const used = new Set<number>();

  function markUsed(start: number, length: number) {
    for (let i = start; i < start + length; i++) used.add(i);
  }

  function isOverlapping(start: number, length: number): boolean {
    for (let i = start; i < start + length; i++) {
      if (used.has(i)) return true;
    }
    return false;
  }

  // Block math first (higher precedence): $$...$$, \[...\], \begin{env}...\end{env}
  let m: RegExpExecArray | null = null;

  BLOCK_MATH_RE.lastIndex = 0;
  while ((m = BLOCK_MATH_RE.exec(text)) !== null) {
    const latex = stripBlockquoteMarkers(m[1]).trim();
    if (!latex) continue;
    matches.push({ index: m.index, length: m[0].length, latex, display: true });
    markUsed(m.index, m[0].length);
  }

  BRACKET_DISPLAY_RE.lastIndex = 0;
  while ((m = BRACKET_DISPLAY_RE.exec(text)) !== null) {
    const latex = stripBlockquoteMarkers(m[1]).trim();
    if (!latex) continue;
    if (isOverlapping(m.index, m[0].length)) continue;
    matches.push({ index: m.index, length: m[0].length, latex, display: true });
    markUsed(m.index, m[0].length);
  }

  BEGIN_END_RE.lastIndex = 0;
  while ((m = BEGIN_END_RE.exec(text)) !== null) {
    const latex = stripBlockquoteMarkers(m[1]).trim();
    if (!latex) continue;
    if (isOverlapping(m.index, m[0].length)) continue;
    matches.push({ index: m.index, length: m[0].length, latex, display: true });
    markUsed(m.index, m[0].length);
  }

  // Inline math — skip overlaps: $...$ and \(...\)
  INLINE_MATH_RE.lastIndex = 0;
  while ((m = INLINE_MATH_RE.exec(text)) !== null) {
    const latex = m[1].trim();
    if (!latex) continue;
    if (isOverlapping(m.index, m[0].length)) continue;
    matches.push({ index: m.index, length: m[0].length, latex, display: false });
    markUsed(m.index, m[0].length);
  }

  PAREN_INLINE_RE.lastIndex = 0;
  while ((m = PAREN_INLINE_RE.exec(text)) !== null) {
    const latex = m[1].trim();
    if (!latex) continue;
    if (isOverlapping(m.index, m[0].length)) continue;
    matches.push({ index: m.index, length: m[0].length, latex, display: false });
    markUsed(m.index, m[0].length);
  }

  matches.sort((a, b) => a.index - b.index);
  return matches;
}

/**
 * Serialize a math expression back to markdown.
 * Inline math → $latex$, display math → $$latex$$
 */
export function serializeMath(latex: string, display: boolean): string {
  return display ? `$$${latex}$$` : `$${latex}$`;
}

/**
 * Roundtrip test helper: parse math from text, then reconstruct the string
 * by replacing matches with their serialized form.
 */
export function roundtrip(text: string): string {
  const matches = parseMathExpressions(text);
  if (matches.length === 0) return text;

  let result = "";
  let cursor = 0;
  for (const m of matches) {
    result += text.slice(cursor, m.index);
    result += serializeMath(m.latex, m.display);
    cursor = m.index + m.length;
  }
  result += text.slice(cursor);
  return result;
}
