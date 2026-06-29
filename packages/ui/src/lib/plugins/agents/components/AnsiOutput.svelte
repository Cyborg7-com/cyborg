<script lang="ts">
  // Renders shell/command tool output that may contain ANSI escape sequences
  // (issue #615). The raw string is parsed by the pure `parseAnsi` util into
  // styled segments and rendered as <span>s with theme-token colors — so
  // `ls --color`, `git`, and test-runner output show as actual colors instead
  // of literal `\x1b[32m` noise, and the whitespace/monospace layout is kept.
  //
  // Colors render via the named ANSI palette (--ansi-* in app.css, theme-aware)
  // for the 16 standard colors, or inline rgb for 256-color/truecolor. We render
  // with Svelte spans (NOT {@html}) so there is no escape-parsing injection path.
  //
  // http(s) URLs inside the output are linkified (a clean, self-contained win);
  // file-path linkification is intentionally left to the dedicated file-link
  // issue (#614) so the two don't collide.
  import { parseAnsi, type AnsiSegment, type AnsiColor } from "$lib/ansi.js";

  let {
    text,
    class: className = "",
  }: { text: string; class?: string } = $props();

  const segments = $derived(parseAnsi(text));

  // Map a named ANSI color to its theme CSS variable; pass rgb values through.
  function colorVar(c: AnsiColor): string {
    return c.kind === "named" ? `var(--ansi-${kebab(c.name)})` : c.value;
  }

  function kebab(name: string): string {
    return name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
  }

  // Build the inline style for one segment. `inverse` swaps fg/bg (terminals
  // do this for selection / highlighting). Dim is approximated with opacity.
  function styleFor(seg: AnsiSegment): string {
    const s = seg.style;
    const parts: string[] = [];
    let fg = s.fg ? colorVar(s.fg) : undefined;
    let bg = s.bg ? colorVar(s.bg) : undefined;
    if (s.inverse) {
      const f = fg ?? "var(--ansi-foreground)";
      const b = bg ?? "var(--ansi-background)";
      fg = b;
      bg = f;
    }
    if (fg) parts.push(`color:${fg}`);
    if (bg) parts.push(`background-color:${bg}`);
    if (s.bold) parts.push("font-weight:600");
    if (s.dim) parts.push("opacity:0.65");
    if (s.italic) parts.push("font-style:italic");
    const deco: string[] = [];
    if (s.underline) deco.push("underline");
    if (s.strike) deco.push("line-through");
    if (deco.length) parts.push(`text-decoration:${deco.join(" ")}`);
    return parts.join(";");
  }

  // Split a segment's text into plain runs and http(s) links so URLs are
  // clickable. Kept deliberately conservative: only absolute http(s) URLs.
  const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;

  function tokenize(segText: string): Array<{ href?: string; text: string }> {
    if (!segText.includes("http")) return [{ text: segText }];
    const out: Array<{ href?: string; text: string }> = [];
    let last = 0;
    for (const m of segText.matchAll(URL_RE)) {
      const idx = m.index ?? 0;
      if (idx > last) out.push({ text: segText.slice(last, idx) });
      // Don't swallow a trailing sentence punctuation into the href.
      let url = m[0];
      const trail = /[.,;:!?]+$/.exec(url);
      let tail = "";
      if (trail) {
        tail = trail[0];
        url = url.slice(0, -tail.length);
      }
      out.push({ href: url, text: url });
      if (tail) out.push({ text: tail });
      last = idx + m[0].length;
    }
    if (last < segText.length) out.push({ text: segText.slice(last) });
    return out;
  }
</script>

<pre
  class="whitespace-pre-wrap break-words text-[11px] font-mono max-h-48 overflow-y-auto bg-[var(--bg-surface)] rounded p-2 {className}"
  style="color:var(--ansi-foreground)"
>{#each segments as seg}{#if seg.style && Object.keys(seg.style).length > 0}<span
        style={styleFor(seg)}
        >{#each tokenize(seg.text) as tok}{#if tok.href}<a
              href={tok.href}
              target="_blank"
              rel="noopener noreferrer"
              class="underline decoration-dotted hover:decoration-solid">{tok.text}</a
            >{:else}{tok.text}{/if}{/each}</span
      >{:else}{#each tokenize(seg.text) as tok}{#if tok.href}<a
            href={tok.href}
            target="_blank"
            rel="noopener noreferrer"
            class="text-link underline decoration-dotted hover:decoration-solid">{tok.text}</a
          >{:else}{tok.text}{/if}{/each}{/if}{/each}</pre>
