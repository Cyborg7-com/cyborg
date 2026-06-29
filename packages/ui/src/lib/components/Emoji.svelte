<script lang="ts">
  // Native emoji glyph. Replaces the old Twemoji <img> (Twitter's flat set,
  // which read as "Android") with the platform's own emoji font — Apple Color
  // Emoji on macOS/iOS, Segoe UI Emoji on Windows, Noto on Linux — so emoji look
  // native ("premium") on each OS. Sized to match the box the <img> used: the
  // glyph renders a touch smaller than its em box, so font-size ≈ 0.86 × size.
  import { cn } from "$lib/utils.js";

  let {
    emoji,
    size = 18,
    class: className = "",
    title,
  }: { emoji: string; size?: number; class?: string; title?: string } = $props();
</script>

<span
  class={cn("c7-emoji inline-flex shrink-0 select-none items-center justify-center align-middle leading-none", className)}
  style="width: {size}px; height: {size}px; font-size: {Math.round(size * 0.86)}px;"
  {title}
>{emoji}</span>

<style>
  .c7-emoji {
    /* Prefer the OS color-emoji font; fall back across platforms. */
    font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;
    font-style: normal;
  }
</style>
