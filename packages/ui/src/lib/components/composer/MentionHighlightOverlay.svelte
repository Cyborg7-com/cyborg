<script lang="ts">
  // Live @mention + link highlight for the plain <textarea> composer.
  //
  // v1 gets this for free from TipTap (blue pill for mentions, blue text for
  // links while typing). The rewrite uses a <textarea>, which can't style
  // sub-ranges, so we render an invisible-text mirror of the content directly
  // behind the textarea. The mirror re-renders the same string with recognized
  // @mentions wrapped in a span using the existing --mention-bg /
  // --mention-text tokens, and recognized URLs/emails wrapped in a span using
  // the --color-link token (same blue as rendered message links).
  // Every layout-affecting style (font, padding, line-height, wrapping) is
  // copied from the textarea so the highlighted ranges sit exactly under the
  // real glyphs. The textarea stays on top with transparent text + visible
  // caret, so caret/selection/autocomplete all keep working unchanged.
  //
  // CRITICAL: only the inline color/background of matched ranges changes — no
  // characters are inserted, removed, or reordered, and no widths/whitespace/
  // wrapping is altered — so the mirror stays char-for-char aligned with the
  // textarea (it's a visual highlight only, never clickable).

  let {
    text,
    isMention,
    scrollTop = 0,
    el = $bindable(),
  }: {
    text: string;
    // Returns true when a typed handle resolves to a real member/agent.
    isMention: (label: string) => boolean;
    scrollTop?: number;
    el?: HTMLDivElement;
  } = $props();

  type SegmentKind = "plain" | "mention" | "link";

  interface Segment {
    text: string;
    kind: SegmentKind;
  }

  // Single tokenizer regex, ordered to match render-markdown.ts's intent:
  //   1=@[Bracket Name]  2=bracket label  3=@handle  4=email  5=bare URL
  // The email branch is ordered BEFORE the @handle branch so a full
  // "user@host.tld" highlights as one blue address and its trailing local-part
  // isn't half-matched as an @mention. The @handle branch keeps the (?<![\w@])
  // guard so the part after "@" in an email is never treated as a mention.
  // The URL/email sub-patterns are kept consistent with render-markdown.ts
  // (email `[\w.+-]+@[\w-]+\.[\w.-]+`, URL `(?:https?:\/\/|www\.)[^\s<>]+` plus
  // the bare `host/path` domain form) for message-vs-composer parity.
  const TOKEN_RE =
    /@\[([^\]]+)\]|(?<![\w@])@([\w-]+)|(?<![\w.+-])[\w.+-]+@[\w-]+\.[\w.-]+|(?:https?:\/\/|www\.)[^\s<>]+|(?<![\w.@/-])[\w-]+(?:\.[\w-]+)+\/[^\s<>]*/g;

  // Split the text into plain / mention / link segments. Mentions recognize
  // both bracketed `@[Full Name]` and bare `@handle` tokens, mirroring the
  // composer's own mentionToken() format; only those that resolve via
  // isMention() are highlighted (typing `@` or an unknown name stays plain —
  // Slack parity). URLs and emails always highlight as links. Matched ranges
  // only change color — every character of `text` is emitted verbatim and in
  // order, so the mirror stays char-for-char aligned with the textarea.
  const segments = $derived.by((): Segment[] => {
    const out: Segment[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text)) !== null) {
      // m[1]/m[2] => mention branches (gated on isMention); anything else that
      // matched is a URL/email link branch.
      const isMentionMatch = m[1] !== undefined || m[2] !== undefined;
      if (isMentionMatch) {
        const label = m[1] ?? m[2];
        if (!isMention(label)) continue;
      }
      if (m.index > last) out.push({ text: text.slice(last, m.index), kind: "plain" });
      out.push({ text: m[0], kind: isMentionMatch ? "mention" : "link" });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last), kind: "plain" });
    return out;
  });
</script>

<!-- text-[16px] MUST match MessageInput's textarea font size (iOS ≥16px
     no-zoom rule) — any drift breaks the char-for-char glyph alignment. -->
<div
  bind:this={el}
  aria-hidden="true"
  class="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-[16px] text-content px-3 py-2"
  style="line-height: 1.46; font-family: inherit; scrollbar-gutter: stable;"
>
  <div style="transform: translateY({-scrollTop}px);">
    {#each segments as seg, i (i)}
      {#if seg.kind === "mention"}<span
          class="rounded-[3px]"
          style="background-color: var(--mention-bg); color: var(--mention-text); box-decoration-break: clone; -webkit-box-decoration-break: clone;"
          >{seg.text}</span
        >{:else if seg.kind === "link"}<span
          style="color: var(--color-link); box-decoration-break: clone; -webkit-box-decoration-break: clone;"
          >{seg.text}</span
        >{:else}{seg.text}{/if}
    {/each}
  </div>
</div>
