<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { sanitize } from "isomorphic-dompurify";
  import { renderMarkdownToHtml, type MentionMeta } from "$lib/render-markdown.js";
  import { resolveShortcodes } from "$lib/emoji.js";
  // KaTeX positions glyphs with this stylesheet (fonts + the inline-style metrics
  // the render-markdown pre-pass emits). Themed via the tokens below where it
  // touches our surfaces; the glyph metrics come straight from KaTeX.
  import "katex/dist/katex.min.css";

  let {
    text,
    class: className = "",
    selfNames = [],
    mentionLookup,
    onMentionClick,
    onChannelClick,
  }: {
    text: string;
    class?: string;
    // Display name(s) of the current user, so their own @mention stands out.
    selfNames?: string[];
    // Optional lowercase-name → meta map for mention tooltips + external styling.
    mentionLookup?: Map<string, MentionMeta>;
    // MESSAGE-RENDER P0: clicks on rendered @mentions / #channels. The renderer
    // emits an HTML string, so clicks are handled via event delegation on the
    // container (the spans carry data-mention / data-channel-mention).
    onMentionClick?: (name: string) => void;
    onChannelClick?: (name: string) => void;
  } = $props();

  const ALLOWED_TAGS = [
    "br", "strong", "em", "del", "u", "code", "pre",
    "a", "span", "div", "h1", "h2", "h3", "h4",
    "blockquote", "table", "thead",
    "tbody", "tr", "th", "td", "img",
    // KaTeX output — MathML (the accessible/semantic layer) + the HTML render
    // layer (mostly <span> + inline styles, already permitted). Copied from the
    // Math Library's DOMPurify config; widened to cover KaTeX's full MathML set.
    "math", "semantics", "annotation", "annotation-xml", "mrow", "mi", "mo",
    "mn", "ms", "mtext", "mspace", "msup", "msub", "msubsup", "mfrac", "mroot",
    "msqrt", "mover", "munder", "munderover", "mtable", "mtr", "mtd", "mlabeledtr",
    "mpadded", "mphantom", "menclose", "mstyle", "merror", "mglyph",
  ];

  function dispatchTarget(raw: EventTarget | null, stop: () => void): void {
    const target = (raw as HTMLElement | null)?.closest<HTMLElement>(
      "[data-mention], [data-channel-mention]",
    );
    if (!target) return;
    const mention = target.getAttribute("data-mention");
    if (mention !== null && onMentionClick) {
      stop();
      onMentionClick(mention);
      return;
    }
    const channel = target.getAttribute("data-channel-mention");
    if (channel !== null && onChannelClick) {
      stop();
      onChannelClick(channel);
    }
  }

  function handleClick(e: MouseEvent): void {
    dispatchTarget(e.target, () => e.stopPropagation());
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key !== "Enter" && e.key !== " ") return;
    dispatchTarget(e.target, () => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  // Used only to detect emoji-only ("jumbo") bodies now — emoji are rendered as
  // native Unicode (no Twemoji <img> swap), so each OS draws its own color-emoji
  // font (Apple Color Emoji on macOS/iOS).
  const EMOJI_RE = /(?:\p{Emoji_Presentation}|\p{Emoji}️)(?:‍(?:\p{Emoji_Presentation}|\p{Emoji}️))*/gu;

  // MESSAGE-RENDER P0: jumbo emoji — a message whose body is nothing but emoji
  // (1–8 of them) and whitespace renders the glyphs larger (Slack/iMessage
  // parity). Shortcodes are resolved first so ":tada:" counts as an emoji.
  const isJumbo = $derived.by(() => {
    const resolved = resolveShortcodes(text);
    const emojis = resolved.match(EMOJI_RE);
    if (!emojis || emojis.length === 0 || emojis.length > 8) return false;
    return resolved.replace(EMOJI_RE, "").trim().length === 0;
  });

  const rendered = $derived(
    sanitize(
      renderMarkdownToHtml(text, { selfNames, mentionLookup }),
      {
        ALLOWED_TAGS,
        ALLOWED_ATTR: [
          "href", "target", "rel", "class", "title", "src", "alt", "draggable",
          "data-mention", "data-channel-mention",
          // KaTeX: `style` carries the glyph-positioning metrics KaTeX emits on its
          // HTML spans (height / vertical-align / margins) — without it the render
          // collapses into overlapping text. DOMPurify still sanitizes style values.
          // `aria-hidden` hides the duplicated HTML layer from screen readers (the
          // MathML layer is the accessible one). The rest are MathML presentation
          // attrs, copied from the Math Library's DOMPurify config.
          "style", "aria-hidden",
          "xmlns", "encoding", "mathvariant", "displaystyle", "scriptlevel",
          "fence", "separator", "stretchy", "symmetric", "maxsize", "minsize",
          "largeop", "movablelimits", "accent", "lspace", "rspace", "columnalign",
          "rowalign", "columnspacing", "rowspacing", "columnlines", "rowlines",
          "frame", "framespacing", "equalrows", "equalcolumns", "side", "width",
          "height", "depth",
        ],
      },
    ),
  );
</script>

<!-- Event delegation on the container: mention / channel spans are inside the
     {@html} payload, so we resolve the clicked target in handleClick. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class={cn("message-markdown", isJumbo && "message-jumbo", className)}
  onclick={handleClick}
  onkeydown={handleKeydown}
>
  {@html rendered}
</div>

<style>
  .message-markdown {
    line-height: 1.46;
    word-break: break-word;
  }
  .message-markdown :global(p) {
    margin: 0;
  }
  .message-markdown :global(p + p) {
    margin-top: 4px;
  }
  .message-markdown :global(strong) {
    font-weight: 700;
    /* Theme-aware: white hid bold/headings on light backgrounds. */
    color: var(--text-primary);
  }
  .message-markdown :global(em) {
    font-style: italic;
  }
  .message-markdown :global(del) {
    text-decoration: line-through;
  }
  .message-markdown :global(code) {
    font-family: var(--font-mono, monospace);
    font-size: 13px;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--code-inline-bg);
    color: var(--code-inline-text);
    border: 1px solid var(--code-border);
  }
  .message-markdown :global(pre) {
    margin: 4px 0;
    padding: 12px 16px;
    border-radius: 6px;
    font-size: 13px;
    overflow-x: auto;
    background: var(--code-bg);
    color: var(--code-text);
    border: 1px solid var(--code-border);
  }
  .message-markdown :global(pre code) {
    padding: 0;
    border: none;
    background: none;
    color: inherit;
    font-size: inherit;
  }
  /* Syntax-highlight tokens (highlight.js classes). Colors come from the
     --hljs-* theme tokens in app.css — never hardcoded. Unmapped token classes
     simply inherit --code-text, so a plain (unhighlighted) block looks the same
     as before this feature. */
  .message-markdown :global(.hljs-keyword),
  .message-markdown :global(.hljs-built_in),
  .message-markdown :global(.hljs-selector-tag) {
    color: var(--hljs-keyword);
  }
  .message-markdown :global(.hljs-string),
  .message-markdown :global(.hljs-regexp),
  .message-markdown :global(.hljs-char.escape_) {
    color: var(--hljs-string);
  }
  .message-markdown :global(.hljs-number),
  .message-markdown :global(.hljs-bullet),
  .message-markdown :global(.hljs-quote) {
    color: var(--hljs-number);
  }
  .message-markdown :global(.hljs-title),
  .message-markdown :global(.hljs-title.function_),
  .message-markdown :global(.hljs-section) {
    color: var(--hljs-title);
  }
  .message-markdown :global(.hljs-type),
  .message-markdown :global(.hljs-title.class_),
  .message-markdown :global(.hljs-class .hljs-title) {
    color: var(--hljs-type);
  }
  .message-markdown :global(.hljs-comment) {
    color: var(--hljs-comment);
    font-style: italic;
  }
  .message-markdown :global(.hljs-literal),
  .message-markdown :global(.hljs-name),
  .message-markdown :global(.hljs-selector-id),
  .message-markdown :global(.hljs-selector-class) {
    color: var(--hljs-literal);
  }
  .message-markdown :global(.hljs-attr),
  .message-markdown :global(.hljs-attribute),
  .message-markdown :global(.hljs-variable),
  .message-markdown :global(.hljs-template-variable),
  .message-markdown :global(.hljs-property) {
    color: var(--hljs-attr);
  }
  .message-markdown :global(.hljs-symbol),
  .message-markdown :global(.hljs-link) {
    color: var(--hljs-symbol);
  }
  .message-markdown :global(.hljs-meta),
  .message-markdown :global(.hljs-meta .hljs-keyword) {
    color: var(--hljs-meta);
  }
  .message-markdown :global(.hljs-deletion) {
    color: var(--hljs-deletion);
  }
  .message-markdown :global(.hljs-addition) {
    color: var(--hljs-addition);
  }
  .message-markdown :global(.hljs-emphasis) {
    font-style: italic;
  }
  .message-markdown :global(.hljs-strong) {
    font-weight: 700;
  }
  .message-markdown :global(a) {
    color: var(--color-link);
    cursor: pointer;
  }
  .message-markdown :global(a:hover) {
    text-decoration: underline;
  }
  .message-markdown :global(h1) {
    font-size: 20px;
    font-weight: 700;
    color: var(--text-primary);
    margin: 8px 0 4px;
  }
  .message-markdown :global(h2) {
    font-size: 17px;
    font-weight: 700;
    color: var(--text-primary);
    margin: 8px 0 4px;
  }
  .message-markdown :global(h3) {
    font-size: 15px;
    font-weight: 600;
    /* --content-dim was never defined; use the real dimmed-text token. */
    color: var(--text-secondary);
    margin: 6px 0 2px;
  }
  .message-markdown :global(h4) {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-secondary);
    margin: 4px 0 2px;
  }
  .message-markdown :global(blockquote) {
    border-left: 4px solid var(--text-muted);
    padding-left: 12px;
    margin: 4px 0;
    color: var(--text-secondary);
    font-style: italic;
  }
  .message-markdown :global(ul) {
    padding-left: 20px;
    margin: 2px 0;
    list-style: disc;
  }
  .message-markdown :global(ol) {
    padding-left: 20px;
    margin: 2px 0;
    list-style: decimal;
  }
  .message-markdown :global(li) {
    margin: 1px 0;
  }
  /* Flat Slack-style list lines (the renderer emits divs, not <ul>/<ol>).
     The base padding (md-depth-0) matches the original 16px; each deeper level
     (md-depth-1..5, from the composer's Tab-to-indent) adds a +20px step so the
     leading-space indentation reads as a real nested sub-list. */
  .message-markdown :global(.md-line-indent) {
    padding-left: 16px;
  }
  .message-markdown :global(.md-depth-0) {
    padding-left: 16px;
  }
  .message-markdown :global(.md-depth-1) {
    padding-left: 36px;
  }
  .message-markdown :global(.md-depth-2) {
    padding-left: 56px;
  }
  .message-markdown :global(.md-depth-3) {
    padding-left: 76px;
  }
  .message-markdown :global(.md-depth-4) {
    padding-left: 96px;
  }
  .message-markdown :global(.md-depth-5) {
    padding-left: 116px;
  }
  .message-markdown :global(.md-bullet) {
    margin-right: 4px;
  }
  .message-markdown :global(u) {
    text-decoration: underline;
  }
  .message-markdown :global(.mention-external-icon) {
    font-size: 0.85em;
    opacity: 0.7;
  }
  .message-markdown :global(table) {
    border-collapse: collapse;
    font-size: 13px;
    margin: 4px 0;
  }
  .message-markdown :global(th) {
    padding: 4px 12px;
    text-align: left;
    font-weight: 600;
    color: var(--text-secondary);
    border-bottom: 1px solid var(--edge);
    white-space: nowrap;
  }
  .message-markdown :global(td) {
    padding: 4px 12px;
    text-align: left;
    border-bottom: 1px solid var(--edge-light);
  }
  .message-markdown :global(hr) {
    border: none;
    border-top: 1px solid var(--edge);
    margin: 8px 0;
  }
  .message-markdown :global(.mention) {
    color: var(--mention-text);
    background-color: var(--mention-bg);
    padding: 0 2px;
    border-radius: 3px;
    font-weight: 500;
    cursor: pointer;
  }
  .message-markdown :global(.mention:hover) {
    text-decoration: underline;
  }
  /* The current user's own mention — higher signal (Slack-style highlight). */
  .message-markdown :global(.mention-self) {
    color: var(--activity-mention-text, var(--mention-text));
    background-color: var(--activity-mention-bg, var(--mention-bg));
    font-weight: 600;
  }
  .message-markdown :global(.channel-mention) {
    color: var(--color-link);
    cursor: pointer;
  }
  .message-markdown :global(.channel-mention:hover) {
    text-decoration: underline;
  }
  /* KaTeX display math ($$…$$) — KaTeX's own .katex-display is block + centered;
     trim its default 1em vertical margin to message-tight spacing. */
  .message-markdown :global(.katex-display) {
    margin: 6px 0;
    overflow-x: auto;
    overflow-y: hidden;
  }
  /* Math that failed to render — KaTeX's inline error color is stripped by the
     DOMPurify style filter, so re-assert a themed error color here. Covers both
     KaTeX's own .katex-error and our .math-error fallback <code>. */
  .message-markdown :global(.katex-error),
  .message-markdown :global(.math-error) {
    color: var(--color-error, var(--destructive, #cc0000));
  }
  /* Jumbo emoji — emoji-only message bodies render the glyphs larger. Native
     emoji scale with font-size (no <img> to resize), so bump the whole body;
     it only ever contains emoji + whitespace when this class is applied. */
  .message-jumbo {
    font-size: 2.1em;
    line-height: 1.15;
  }
</style>
