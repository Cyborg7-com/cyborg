// Slack-style message renderer — hand-ported from cyborg7-core's
// src/lib/renderMarkdown.tsx for behavior parity. Emits an HTML string
// (the original emitted React nodes). The caller MUST sanitize the output
// with DOMPurify before injecting it (see MessageRenderer.svelte) — text and
// attribute values are escaped here, but sanitize is the security boundary.
//
// Slack-parity rules that differ from stock markdown (this is the whole point):
//   *text*   → BOLD   (NOT italic)
//   **text** → BOLD   (markdown muscle-memory still works)
//   _text_   → ITALIC (with snake_case guard so identifiers aren't italicized)
//   __text__ → UNDERLINE (rare, back-compat with old messages)
//   ~~text~~ → strikethrough
// Ordered/unordered lists render as flat <div> lines (like Slack) — not as
// nested <ul>/<ol> — but leading-space indentation IS honored: each list line
// carries a `md-depth-N` class (N = nesting level, see composer-list-indent.ts)
// so the composer's Tab-to-indent shows as a real visual sub-list. Unordered
// bullets pick their glyph from the depth; ordered lines keep their literal "N.".
// `:shortcode:` emoji (both colons) are resolved to the glyph up front.

import { renderToString as katexRenderToString } from "katex";
import { resolveShortcodes } from "./emoji.js";
import { highlightCode } from "./highlight.js";
import { bulletGlyphForDepth, INDENT_UNIT, MAX_DEPTH } from "./composer-list-indent.js";
import { parseMathExpressions } from "./math-parser.js";

export interface MentionMeta {
  role?: string;
  type?: "agent" | "human";
  isParticipant?: boolean;
}

export interface RenderOptions {
  /** Display name(s) of the current user, so their own @mention stands out. */
  selfNames?: string[];
  /** lowercase-name → meta, for tooltips + external-mention styling. */
  mentionLookup?: Map<string, MentionMeta>;
}

interface NormalizedOptions {
  selfSet: Set<string>;
  mentionLookup?: Map<string, MentionMeta>;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function mentionSpan(name: string, opts: NormalizedOptions): string {
  const lower = name.toLowerCase();
  const isSelf = opts.selfSet.has(lower);
  const meta = opts.mentionLookup?.get(lower);
  const isExternal = meta?.isParticipant === false;
  const cls = ["mention", isSelf && "mention-self", isExternal && "mention-external"]
    .filter(Boolean)
    .join(" ");
  const tooltip = meta
    ? `${name} — ${meta.type === "agent" ? `Agent${meta.role ? ` (${meta.role})` : ""}` : "Member"}`
    : name;
  const ext = isExternal ? `<span class="mention-external-icon"> ↗</span>` : "";
  // data-mention carries the raw name so the message container's click
  // delegation (see ChatMessage.svelte) can resolve it to a profile.
  return `<span class="${cls}" data-mention="${escapeHtml(name)}" title="${escapeHtml(tooltip)}">@${escapeHtml(name)}${ext}</span>`;
}

// Master inline regex — kept VERBATIM in sync with cyborg7-core's renderMarkdown.tsx
// and the server-side mention extractor. Groups: 1=full, 2=**bold**, 3=*bold*,
// 4=~~strike~~, 5=__underline__, 6=_italic_, 7=`code`, 8=@[bracket], 9=bracket name,
// 10=email, 11=@word, 12=md link, 13=link text, 14=link url, 15=bare url (http(s)://
// or www./bare domain), 16=#channel.
// NOTE: the email branch (10) is ordered BEFORE the @word mention branch (11) so a
// full "user@host.tld" linkifies as a whole and the trailing local-part isn't
// half-parsed as an @mention. The @word branch keeps its (?<!\w) guard so the bit
// after the "@" in an email is never matched as a mention on its own.
const INLINE_RE =
  /(\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|__(.+?)__|(?<![A-Za-z0-9_])_([^_\s][^_]*?[^_\s]|[^_\s])_(?![A-Za-z0-9_])|`([^`]+?)`|(@\[([^\]]+)\])|((?<![\w.+-])[\w.+-]+@[\w-]+\.[\w.-]+)|((?<!\w)@[\w-]+(?:\s*\(\d+\))?)(?=\s|$|[,!?;:]|\.(?!\w))|(!\[([^\]]*)\]\(([^)\s]+)\))|(\[([^\]]+)\]\(([^)]+)\))|((?:https?:\/\/|www\.)[^\s<>]+|(?<![\w.@/-])[\w-]+(?:\.[\w-]+)+\/[^\s<>]*)|(#[\w-]+)(?=\s|$|[.,!?;:]))/g;

// Trusted host for INLINE images: ONLY our own S3 asset bucket renders as an
// inline <img>. Every other ![alt](url) degrades to a safe link (the renderer
// has historically had NO image rule precisely to avoid embedding arbitrary
// remote images — tracking pixels / mixed content). Pinned to the exact
// `cyborg7-shared-assets` bucket (the same one avatars + agent-images use) — a
// broad `*.s3.amazonaws.com` match would let ANY attacker-controlled bucket embed
// images. Matches S3 virtual-hosted-style URLs:
// https://cyborg7-shared-assets.s3[.<region>].amazonaws.com/<key>
const TRUSTED_IMAGE_HOST_RE =
  /^https:\/\/cyborg7-shared-assets\.s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com\//i;

export function isTrustedInlineImageUrl(url: string): boolean {
  return TRUSTED_IMAGE_HOST_RE.test(url);
}

// Pre-pass: convert bare multi-word @mentions to bracket syntax so the regex
// picks them up. e.g. "@Rick Sanchez" → "@[Rick Sanchez]" when "rick sanchez"
// is known. Uses indexOf scanning (not dynamic RegExp) to avoid ReDoS risk.
function expandMultiWordMentions(text: string, lookup: Map<string, MentionMeta>): string {
  let processed = text;
  const knownNames = Array.from(lookup.keys()).sort((a, b) => b.length - a.length);
  for (const lowerName of knownNames) {
    if (!lowerName.includes(" ")) continue;
    let cursor = 0;
    while (cursor < processed.length) {
      // Recompute on each pass — `processed` grows by 2 chars ("[" + "]") on
      // every replacement, so a hoisted `lower` would misalign indices and
      // corrupt subsequent mentions in the same message.
      const lower = processed.toLowerCase();
      const idx = lower.indexOf(`@${lowerName}`, cursor);
      if (idx === -1) break;
      const end = idx + 1 + lowerName.length;
      const alreadyBracketed = processed[idx + 1] === "[";
      const badBoundary = end < processed.length && !/[\s.,!?;:]/.test(processed[end]);
      if (alreadyBracketed || badBoundary) {
        cursor = idx + 2;
        continue;
      }
      const originalName = processed.slice(idx + 1, end);
      processed = `${processed.slice(0, idx)}@[${originalName}]${processed.slice(end)}`;
      cursor = idx + originalName.length + 3;
    }
  }
  return processed;
}

// Map one INLINE_RE match to its HTML. Returns "" for an unrecognized match.
function inlineToken(match: RegExpExecArray, opts: NormalizedOptions): string {
  if (match[2]) return `<strong>${escapeHtml(match[2])}</strong>`; // **bold**
  if (match[3]) return `<strong>${escapeHtml(match[3])}</strong>`; // *bold* (Slack)
  if (match[4]) return `<del>${escapeHtml(match[4])}</del>`;
  if (match[5]) return `<u>${escapeHtml(match[5])}</u>`;
  if (match[6]) return `<em>${escapeHtml(match[6])}</em>`; // _italic_ (Slack)
  if (match[7]) return `<code>${escapeHtml(match[7])}</code>`;
  if (match[8]) return mentionSpan(match[9], opts); // @[Bracket Name]
  if (match[10]) {
    // email → mailto autolink. Ordered before @word so the whole address links.
    return `<a href="mailto:${escapeHtml(match[10])}">${escapeHtml(match[10])}</a>`;
  }
  if (match[11]) return mentionSpan(match[11].replace(/^@/, ""), opts); // @word
  if (match[12]) {
    // Image ![alt](url). Only a trusted S3 asset URL embeds as an inline <img>
    // (agent-generated images the daemon uploaded); any other url degrades to a
    // safe link so we never embed arbitrary remote images.
    const alt = match[13] ?? "";
    const url = match[14];
    if (isTrustedInlineImageUrl(url)) {
      return `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" class="md-image" loading="lazy" />`;
    }
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(alt || url)}</a>`;
  }
  if (match[15]) {
    // md link [text](url)
    return `<a href="${escapeHtml(match[17])}" target="_blank" rel="noopener noreferrer">${escapeHtml(match[16])}</a>`;
  }
  if (match[18]) {
    // Bare URL: http(s):// passes through; www./bare-domain gets an https:// prefix.
    const raw = match[18];
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(raw)}</a>`;
  }
  if (match[19]) {
    const channelName = match[19].slice(1);
    // data-channel-mention carries the channel name so the message container's
    // click delegation (see ChatMessage.svelte) can jump to it.
    return `<span class="channel-mention" data-channel-mention="${escapeHtml(channelName)}" title="#${escapeHtml(channelName)}">#${escapeHtml(channelName)}</span>`;
  }
  return "";
}

function renderInline(text: string, opts: NormalizedOptions): string {
  const processed =
    opts.mentionLookup && opts.mentionLookup.size > 0
      ? expandMultiWordMentions(text, opts.mentionLookup)
      : text;

  const out: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;

  while ((match = INLINE_RE.exec(processed)) !== null) {
    if (match.index > lastIndex) {
      out.push(escapeHtml(processed.slice(lastIndex, match.index)));
    }
    out.push(inlineToken(match, opts));
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < processed.length) {
    out.push(escapeHtml(processed.slice(lastIndex)));
  }
  return out.join("");
}

function parseTableRows(lines: string[], start: number): { rows: string[][]; end: number } {
  const rows: string[][] = [];
  let i = start;
  while (i < lines.length && lines[i].includes("|")) {
    const raw = lines[i].trim();
    if (/^\|?[\s\-:|]+\|?$/.test(raw)) {
      i++;
      continue;
    }
    const cells = raw
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    rows.push(cells);
    i++;
  }
  return { rows, end: i };
}

// ── KaTeX math (ported from the Math Library's markdown-math.ts) ────────────
// Inline ($…$ / \(…\)) and block ($$…$$ / \[…\] / \begin{}…\end{}) LaTeX is
// rendered to HTML by KaTeX in a PRE-PASS that runs BEFORE the Slack inline/line
// loop. The math span is swapped for a Private-Use-Area placeholder the Slack
// renderer can't match or escape, then the KaTeX HTML is spliced back in a
// POST-PASS once the rest of the message is rendered. This mirrors the ordering
// in math-library/src/lib/utils/markdown-math.ts (render math first so the
// markdown/Slack parser can never mangle LaTeX).
//
// NOTE: KaTeX positions glyphs with INLINE STYLES + MathML, so MessageRenderer's
// DOMPurify allowlist must permit `style` + the MathML tags/attrs (see that file).

const KATEX_MACROS: Record<string, string> = {
  "\\RR": "\\mathbb{R}",
  "\\ZZ": "\\mathbb{Z}",
  "\\NN": "\\mathbb{N}",
  "\\QQ": "\\mathbb{Q}",
  "\\CC": "\\mathbb{C}",
  "\\FF": "\\mathbb{F}",
};

// PUA delimiters — never appear in real message text, are ignored by INLINE_RE,
// and pass through escapeHtml untouched, so they survive the Slack pipeline.
const MATH_PH_OPEN = String.fromCharCode(0xe000);
const MATH_PH_CLOSE = String.fromCharCode(0xe001);
const MATH_PH_RE = new RegExp(`${MATH_PH_OPEN}(\\d+)${MATH_PH_CLOSE}`, "g");

// Render one expression with KaTeX. throwOnError:false degrades invalid LaTeX to
// a `.katex-error` node instead of throwing; the try/catch is a final guard for
// the rare case KaTeX throws anyway (degrades to a `.math-error` <code>).
function renderKatex(latex: string, displayMode: boolean): string {
  try {
    return katexRenderToString(latex, {
      displayMode,
      throwOnError: false,
      macros: { ...KATEX_MACROS },
    });
  } catch {
    const escaped = latex.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<code class="math-error">${escaped}</code>`;
  }
}

// PRE-PASS: extract math spans, render each to KaTeX HTML (stored in `segments`),
// and replace it with a placeholder. Cheaply gated: a message with no `$`, `\[`,
// or `\(` returns the original text + no segments, so the output is byte-identical
// to the pre-math renderer (no placeholder, no post-pass).
function extractMath(text: string): { text: string; segments: string[] } {
  if (!text.includes("$") && !text.includes("\\[") && !text.includes("\\(")) {
    return { text, segments: [] };
  }
  const matches = parseMathExpressions(text);
  if (matches.length === 0) return { text, segments: [] };

  const segments: string[] = [];
  let result = "";
  let cursor = 0;
  for (const m of matches) {
    result += text.slice(cursor, m.index);
    // KaTeX's own displayMode wrapper (<span class="katex-display">) is the block
    // wrapper; inline math is an inline <span class="katex">.
    segments.push(renderKatex(m.latex, m.display));
    result += `${MATH_PH_OPEN}${segments.length - 1}${MATH_PH_CLOSE}`;
    cursor = m.index + m.length;
  }
  result += text.slice(cursor);
  return { text: result, segments };
}

// POST-PASS: splice the rendered KaTeX HTML back in where the placeholders sit.
function restoreMath(html: string, segments: string[]): string {
  return html.replace(MATH_PH_RE, (_, i) => segments[Number(i)] ?? "");
}

export function renderMarkdownToHtml(text: string, opts: RenderOptions = {}): string {
  const norm: NormalizedOptions = {
    selfSet: new Set((opts.selfNames ?? []).map((n) => n.toLowerCase())),
    mentionLookup: opts.mentionLookup,
  };
  // KaTeX pre-pass — math is rendered + parked behind placeholders BEFORE the
  // Slack pipeline runs, then restored after (restoreMath). Non-math messages
  // skip both passes entirely (segments empty → byte-identical output).
  const { text: prepared, segments } = extractMath(text);
  const lines = resolveShortcodes(prepared).split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    // Code block. The opening fence may carry a language tag (```ts, ```python),
    // which we pass to the highlighter; an unknown/missing tag falls back to a
    // plain (escaped) <code> body — same visual as before, no highlight spans.
    if (lines[i].startsWith("```")) {
      const lang = lines[i].slice(3).trim().toLowerCase();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      const code = codeLines.join("\n");
      const { html, language } = highlightCode(code, lang);
      // highlightCode returns sanitized hljs markup (escaped text + hljs-* spans)
      // OR plain-escaped text when no language matched. The hljs span class is on
      // the DOMPurify allowlist (MessageRenderer ALLOWED_ATTR includes "class").
      const langAttr = language ? ` class="hljs language-${escapeHtml(language)}"` : "";
      out.push(`<pre><code${langAttr}>${html}</code></pre>`);
      continue;
    }

    // Heading
    const headingMatch = lines[i].match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      out.push(`<h${level}>${renderInline(headingMatch[2], norm)}</h${level}>`);
      i++;
      continue;
    }

    // Table
    if (lines[i].includes("|") && i + 1 < lines.length && lines[i + 1].includes("|")) {
      const { rows, end } = parseTableRows(lines, i);
      if (rows.length >= 1) {
        const [header, ...body] = rows;
        const head = header
          ? `<thead><tr>${header.map((c) => `<th>${renderInline(c, norm)}</th>`).join("")}</tr></thead>`
          : "";
        const tbody =
          body.length > 0
            ? `<tbody>${body
                .map(
                  (row) =>
                    `<tr>${row.map((c) => `<td>${renderInline(c, norm)}</td>`).join("")}</tr>`,
                )
                .join("")}</tbody>`
            : "";
        out.push(`<table>${head}${tbody}</table>`);
        i = end;
        continue;
      }
    }

    // Blockquote (single-line, matches original)
    if (lines[i].startsWith("> ")) {
      out.push(`<blockquote>${renderInline(lines[i].slice(2), norm)}</blockquote>`);
      i++;
      continue;
    }

    // Ordered list — flat; the "N." literal stays in the rendered text
    // (Slack-parity, never renumbered). Leading spaces set the nesting depth
    // (md-depth-N) and are stripped; the "N. content" renders as the line text.
    const orderedMatch = lines[i].match(/^( *)(\d+)\.\s/);
    if (orderedMatch) {
      const depth = Math.min(MAX_DEPTH, Math.floor(orderedMatch[1].length / INDENT_UNIT));
      const content = lines[i].slice(orderedMatch[1].length);
      out.push(
        `<div class="md-line-indent md-depth-${depth}">${renderInline(content, norm)}</div>`,
      );
      i++;
      continue;
    }

    // Unordered list — flat; the displayed bullet glyph is ALWAYS picked from
    // the depth (•/◦/▪ cycle), so it stays depth-authoritative even though the
    // source now carries the depth glyph too (•/◦/▪ all accepted as markers).
    // Strip the matched leadingSpaces+marker+spaces via the regex (NOT slice(2) —
    // that breaks an indented "  • foo", stripping the spaces instead of the bullet).
    const bulletMatch = lines[i].match(/^( *)([-•◦▪])\s+/);
    if (bulletMatch) {
      const depth = Math.min(MAX_DEPTH, Math.floor(bulletMatch[1].length / INDENT_UNIT));
      const content = lines[i].slice(bulletMatch[0].length);
      out.push(
        `<div class="md-line-indent md-depth-${depth}"><span class="md-bullet">${bulletGlyphForDepth(depth)}</span>${renderInline(content, norm)}</div>`,
      );
      i++;
      continue;
    }

    // Normal line — preserve newlines with <br> between lines (matches original)
    out.push(`<span>${renderInline(lines[i], norm)}</span>`);
    if (i < lines.length - 1) out.push("<br>");
    i++;
  }
  const html = out.join("");
  // KaTeX post-pass — splice rendered math back in (no-op when no math present).
  return segments.length > 0 ? restoreMath(html, segments) : html;
}
