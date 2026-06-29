// Parity tests for the Slack-style renderer. Runs under vitest (the package
// test runner): `pnpm --filter @cyborg7/ui test`.
import { expect, test } from "vitest";
import { renderMarkdownToHtml } from "./render-markdown.js";

const r = (t: string, opts = {}) => renderMarkdownToHtml(t, opts);
const assert = {
  equal: (a: unknown, b: unknown) => expect(a).toBe(b),
  match: (a: string, re: RegExp) => expect(a).toMatch(re),
};

test("single-star is BOLD (Slack), not italic", () => {
  assert.equal(r("*hi*"), "<span><strong>hi</strong></span>");
});

test("double-star is also bold", () => {
  assert.equal(r("**hi**"), "<span><strong>hi</strong></span>");
});

test("underscore is italic", () => {
  assert.equal(r("_hi_"), "<span><em>hi</em></span>");
});

test("double-underscore is underline", () => {
  assert.equal(r("__hi__"), "<span><u>hi</u></span>");
});

test("tilde is strikethrough", () => {
  assert.equal(r("~~hi~~"), "<span><del>hi</del></span>");
});

test("snake_case is NOT italicized", () => {
  assert.equal(r("foo_bar_baz"), "<span>foo_bar_baz</span>");
});

// The iOS composer serializer inserts a zero-width space (U+200B) just outside a
// `_`-italic marker when it would otherwise touch an alphanumeric (e.g. italic
// "j" immediately followed by plain "jj"). The ZWSP satisfies the snake_case
// guard so the italic still renders, while staying invisible. This pins that
// contract — DO NOT relax the guard to "fix" `_j_jj`; that would re-break
// foo_bar_baz above.
test("ZWSP lets italic abut an alphanumeric word", () => {
  assert.equal(r("_j_\u200Bjj"), "<span><em>j</em>\u200Bjj</span>");
});

test("inline code", () => {
  assert.equal(r("`x = 1`"), "<span><code>x = 1</code></span>");
});

test("bare @mention becomes a mention span", () => {
  assert.equal(
    r("hi @alice"),
    '<span>hi <span class="mention" data-mention="alice" title="alice">@alice</span></span>',
  );
});

test("email autolinks to mailto (not a mention)", () => {
  assert.equal(
    r("ping user@domain.com now"),
    '<span>ping <a href="mailto:user@domain.com">user@domain.com</a> now</span>',
  );
});

test("bracket mention @[Full Name]", () => {
  assert.equal(
    r("cc @[Alice Smith]"),
    '<span>cc <span class="mention" data-mention="Alice Smith" title="Alice Smith">@Alice Smith</span></span>',
  );
});

test("self mention gets mention-self class", () => {
  assert.equal(
    r("@alice", { selfNames: ["Alice"] }),
    '<span><span class="mention mention-self" data-mention="alice" title="alice">@alice</span></span>',
  );
});

test("channel mention #general", () => {
  assert.equal(
    r("see #general"),
    '<span>see <span class="channel-mention" data-channel-mention="general" title="#general">#general</span></span>',
  );
});

test("markdown link", () => {
  assert.equal(
    r("[docs](https://x.com)"),
    '<span><a href="https://x.com" target="_blank" rel="noopener noreferrer">docs</a></span>',
  );
});

test("bare url", () => {
  assert.equal(
    r("https://x.com"),
    '<span><a href="https://x.com" target="_blank" rel="noopener noreferrer">https://x.com</a></span>',
  );
});

test("heading", () => {
  assert.equal(r("# Title"), "<h1>Title</h1>");
});

test("code block (raw, not inline-parsed)", () => {
  // No language tag → plain (escaped) <code> body, no hljs spans/class.
  assert.equal(r("```\n*not bold*\n```"), "<pre><code>*not bold*</code></pre>");
});

test("fenced code block with a language tag gets an hljs language class", () => {
  const html = r("```ts\nconst x = 1;\n```");
  assert.match(html, /<pre><code class="hljs language-typescript">/);
  // Tokens are wrapped in hljs spans (e.g. the `const` keyword).
  assert.match(html, /hljs-keyword/);
});

test("fenced code block with an unknown language falls back to plain", () => {
  assert.equal(r("```notalang\nplain text\n```"), "<pre><code>plain text</code></pre>");
});

test("ordered list keeps the literal number (depth 0)", () => {
  assert.equal(r("1. first"), '<div class="md-line-indent md-depth-0">1. first</div>');
});

test("unordered list renders a flat bullet (depth 0)", () => {
  assert.equal(
    r("- item"),
    '<div class="md-line-indent md-depth-0"><span class="md-bullet">•</span>item</div>',
  );
});

test("a depth-0 `• item` source is byte-identical to a `- item` (depth 0)", () => {
  assert.equal(
    r("• item"),
    '<div class="md-line-indent md-depth-0"><span class="md-bullet">•</span>item</div>',
  );
});

// ─── Tab-to-indent nesting (Mattermost parity) ───
// 2 leading spaces = one nesting level (INDENT_UNIT). The depth drives both the
// md-depth-N class (CSS padding) and, for bullets, the displayed glyph
// (•→◦→▪ cycle). Ordered lists keep their literal "N." at every depth.

test("indented `-` bullets nest with depth class + cycled glyph", () => {
  assert.equal(
    r("- a\n  - b\n    - c"),
    '<div class="md-line-indent md-depth-0"><span class="md-bullet">•</span>a</div>' +
      '<div class="md-line-indent md-depth-1"><span class="md-bullet">◦</span>b</div>' +
      '<div class="md-line-indent md-depth-2"><span class="md-bullet">▪</span>c</div>',
  );
});

test("indented `•` bullets nest the same way as `-`", () => {
  assert.equal(
    r("• a\n  • b\n    • c"),
    '<div class="md-line-indent md-depth-0"><span class="md-bullet">•</span>a</div>' +
      '<div class="md-line-indent md-depth-1"><span class="md-bullet">◦</span>b</div>' +
      '<div class="md-line-indent md-depth-2"><span class="md-bullet">▪</span>c</div>',
  );
});

// The composer now bakes the depth glyph into the SOURCE text (WYSIWYG), so a
// sent message can arrive with literal ◦/▪ markers. The renderer must accept
// them as bullet markers, and the DISPLAYED glyph stays depth-authoritative (so
// a stray glyph/depth mismatch can't show the wrong bullet).
test("an indented `◦` SOURCE bullet is recognized and renders the depth glyph", () => {
  assert.equal(
    r("  ◦ b"),
    '<div class="md-line-indent md-depth-1"><span class="md-bullet">◦</span>b</div>',
  );
});

test("an indented `▪` SOURCE bullet is recognized and renders the depth glyph", () => {
  assert.equal(
    r("    ▪ c"),
    '<div class="md-line-indent md-depth-2"><span class="md-bullet">▪</span>c</div>',
  );
});

test("glyph stays depth-authoritative: a `▪` at depth 1 still renders ◦", () => {
  // Source carries ▪ but only 1 level of indent → depth 1 → the glyph is ◦.
  assert.equal(
    r("  ▪ b"),
    '<div class="md-line-indent md-depth-1"><span class="md-bullet">◦</span>b</div>',
  );
});

test("a depth-0 `◦`/`▪` source bullet renders depth-0 (• glyph)", () => {
  assert.equal(
    r("◦ x"),
    '<div class="md-line-indent md-depth-0"><span class="md-bullet">•</span>x</div>',
  );
});

test("indented ordered list nests but keeps the literal number", () => {
  assert.equal(
    r("1. a\n  1. b"),
    '<div class="md-line-indent md-depth-0">1. a</div>' +
      '<div class="md-line-indent md-depth-1">1. b</div>',
  );
});

test("an indented bullet INSIDE a code fence stays code, not a list", () => {
  assert.equal(r("```\n  - not a list\n```"), "<pre><code>  - not a list</code></pre>");
});

test("newlines become <br> between normal lines", () => {
  assert.equal(r("a\nb"), "<span>a</span><br><span>b</span>");
});

test("table renders thead + tbody", () => {
  assert.equal(
    r("| A | B |\n| - | - |\n| 1 | 2 |"),
    "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
  );
});

test("XSS: raw HTML in text is escaped", () => {
  assert.equal(
    r("<script>alert(1)</script>"),
    "<span>&lt;script&gt;alert(1)&lt;/script&gt;</span>",
  );
});

test("XSS: HTML inside a bracket mention name is escaped", () => {
  assert.equal(
    r("@[<img src=x onerror=alert(1)>]"),
    '<span><span class="mention" data-mention="&lt;img src=x onerror=alert(1)&gt;" title="&lt;img src=x onerror=alert(1)&gt;">@&lt;img src=x onerror=alert(1)&gt;</span></span>',
  );
});

test("blockquote", () => {
  assert.equal(r("> quoted"), "<blockquote>quoted</blockquote>");
});

test("emoji shortcode resolves to glyph", () => {
  assert.equal(r("hype :fire:"), "<span>hype 🔥</span>");
});

test("unknown shortcode is left untouched", () => {
  assert.equal(r(":notarealcode:"), "<span>:notarealcode:</span>");
});

test("times/ratios (single colon) are not eaten", () => {
  assert.equal(r("meeting at 12:30"), "<span>meeting at 12:30</span>");
});

test("mixed inline: bold + italic + mention", () => {
  assert.equal(
    r("*hey* _there_ @bob"),
    '<span><strong>hey</strong> <em>there</em> <span class="mention" data-mention="bob" title="bob">@bob</span></span>',
  );
});

// Inline image rule (#agent-images): only a trusted S3 asset URL embeds as an
// <img>; every other ![alt](url) degrades to a safe link (no arbitrary remote
// image embedding). Agent-generated images the daemon uploads to S3 render
// inline in the session transcript / chat.
const S3 = "https://cyborg7-shared-assets.s3.us-east-1.amazonaws.com/agent-images/x.png";

test("S3 image markdown renders an inline <img>", () => {
  assert.match(
    r(`![diagram](${S3})`),
    /<img src="https:\/\/cyborg7-shared-assets\.s3\.us-east-1\.amazonaws\.com\/agent-images\/x\.png" alt="diagram"/,
  );
});

test("local-path image does NOT embed — degrades to a safe link", () => {
  const out = r("![diag](/tmp/paseo-attachments/diag.png)");
  expect(out).not.toContain("<img");
  assert.match(out, /<a href="\/tmp\/paseo-attachments\/diag\.png"[^>]*>diag<\/a>/);
});

test("arbitrary remote image does NOT embed (anti-tracking-pixel)", () => {
  const out = r("![x](https://evil.example.com/pixel.png)");
  expect(out).not.toContain("<img");
  expect(out).toContain('<a href="https://evil.example.com/pixel.png"');
});

test("a plain [text](url) link still renders as a link (group renumber guard)", () => {
  assert.equal(
    r("[docs](https://example.com)"),
    '<span><a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a></span>',
  );
});

test("image embeds alongside surrounding text", () => {
  const out = r(`here ![p](${S3}) done`);
  assert.match(out, /here <img src="[^"]+" alt="p"[^>]*\/> done/);
});

test("a DIFFERENT s3 bucket does NOT embed (only cyborg7-shared-assets is trusted)", () => {
  const out = r("![x](https://evil-bucket.s3.us-east-1.amazonaws.com/x.png)");
  expect(out).not.toContain("<img");
  expect(out).toContain('<a href="https://evil-bucket.s3.us-east-1.amazonaws.com/x.png"');
});

// ── KaTeX math pre-pass ──────────────────────────────────────────────────────
// Math is rendered to KaTeX HTML BEFORE the Slack inline/line loop, parked behind
// a Private-Use-Area placeholder, then spliced back in. These assert the RAW
// renderer output (MessageRenderer sanitizes it downstream with an allowlist that
// permits the KaTeX/MathML tags + `style`).

test("inline $x^2$ renders a KaTeX span", () => {
  const out = r("the value $x^2$ here");
  expect(out).toContain('class="katex"');
  // Inline math is NOT wrapped in KaTeX's block display wrapper.
  expect(out).not.toContain("katex-display");
  // Surrounding text is preserved as a normal line span.
  expect(out).toContain("the value ");
  expect(out).toContain(" here");
});

test("block $$\\int$$ renders a KaTeX display block", () => {
  const out = r("$$\\int_0^1 x^2 dx$$");
  expect(out).toContain("katex-display");
  expect(out).toContain('class="katex"');
});

test("inline \\(...\\) and display \\[...\\] delimiters also render", () => {
  expect(r("see \\(a+b\\)")).toContain('class="katex"');
  const block = r("\\[E = mc^2\\]");
  expect(block).toContain("katex-display");
});

test("custom macro \\RR is recognized (expands to \\mathbb{R}, no error node)", () => {
  // Without the macro, \RR is an undefined control sequence → KaTeX emits a
  // .katex-error. With the macro registered, it renders cleanly.
  const out = r("$x \\in \\RR$");
  expect(out).toContain('class="katex"');
  expect(out).not.toContain("katex-error");
});

test("invalid LaTeX degrades to an error node, not a throw", () => {
  let out = "";
  expect(() => {
    out = r("$\\frac{1$");
  }).not.toThrow();
  expect(out.length).toBeGreaterThan(0);
  // throwOnError:false → KaTeX emits a .katex-error node (our .math-error is the
  // fallback if KaTeX itself throws). Either way it must not crash.
  expect(/katex-error|math-error/.test(out)).toBe(true);
});

test("math does not break surrounding Slack markdown", () => {
  const out = r("*bold* and $a+b$ and `code`");
  expect(out).toContain("<strong>bold</strong>");
  expect(out).toContain("<code>code</code>");
  expect(out).toContain('class="katex"');
});

test("the PUA placeholder never leaks into the output", () => {
  const out = r("inline $a$ and block $$b$$");
  expect(out).not.toContain(String.fromCharCode(0xe000));
  expect(out).not.toContain(String.fromCharCode(0xe001));
});

test("text with NO math is byte-identical to the pre-math renderer", () => {
  // The cheap gate (no $, \[, \() must skip the math passes entirely so ordinary
  // messages render exactly as before — these exact strings are the pre-math
  // outputs, pinned so a regression in the gate/placeholder logic is caught.
  assert.equal(r("*hi*"), "<span><strong>hi</strong></span>");
  assert.equal(r("_hi_"), "<span><em>hi</em></span>");
  assert.equal(
    r("hi @alice"),
    '<span>hi <span class="mention" data-mention="alice" title="alice">@alice</span></span>',
  );
  assert.equal(r("foo_bar_baz"), "<span>foo_bar_baz</span>");
  assert.equal(r("plain text, no markup"), "<span>plain text, no markup</span>");
  // And no placeholder ever leaks for these no-math inputs.
  for (const s of ["*hi*", "hi @alice", "# Heading\nbody"]) {
    expect(r(s)).not.toContain(String.fromCharCode(0xe000));
  }
});

test("a lone $ (no closing delimiter) is untouched — currency, not math", () => {
  expect(r("the cost is $100")).toBe("<span>the cost is $100</span>");
});
