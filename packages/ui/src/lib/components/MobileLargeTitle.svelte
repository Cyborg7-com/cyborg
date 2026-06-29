<script lang="ts">
  /**
   * iOS large-title header block (P2 — standalone, adopted by tab pages in a
   * later phase; nothing imports it yet).
   *
   * USAGE (when adopted):
   *   <div class="overflow-y-auto" bind:this={scroller}>
   *     <MobileLargeTitle title="Chats" scrollContainer={scroller}>
   *       {#snippet actions()}<button>…</button>{/snippet}
   *     </MobileLargeTitle>
   *     …list content…
   *   </div>
   *
   * Both rendered roots MUST be direct children of the scrolling element (the
   * compact bar is `position: sticky` against it). Pass the scrolling element
   * via `scrollContainer`; without it the large title renders statically and
   * never collapses (safe default for non-scrolling screens).
   *
   * BEHAVIOR: a 34px/bold large title sits in the flow at the top of the
   * content. As the container scrolls 0 → ~52px the large title fades/rises
   * away and a compact 17px/semibold inline bar (blur material + bottom
   * hairline) fades in, stuck to the container top — the UINavigationController
   * large-title collapse. All scroll-driven styling is written IMPERATIVELY
   * (rAF-coalesced inline styles), never via reactive `style:` directives —
   * same 60fps discipline as the swipe gesture (Caveat #23). The mapping is
   * purely proportional to scrollTop (no timed animation), so it is inherently
   * reduced-motion-safe and overscroll is clamped (no rubber-band jitter).
   */
  import type { Snippet } from "svelte";

  let {
    title,
    actions,
    scrollContainer,
  }: {
    title: string;
    /** Optional right-side actions rendered on the large-title row. */
    actions?: Snippet;
    /** The scrolling element this header collapses against. */
    scrollContainer?: HTMLElement;
  } = $props();

  // Scroll distance over which the large title fully collapses (~the large
  // title row's own height, per UIKit feel).
  const COLLAPSE_PX = 52;
  // The compact bar only starts fading in past this fraction so the two
  // titles never sit at equal opacity (UIKit cross-fades late, not linearly).
  const COMPACT_FADE_START = 0.6;

  let largeTitleEl: HTMLElement | undefined = $state();
  let compactBarEl: HTMLElement | undefined = $state();

  $effect(() => {
    const el = scrollContainer;
    const large = largeTitleEl;
    const compact = compactBarEl;
    if (!el || !large || !compact) return;

    let raf = 0;
    const apply = () => {
      raf = 0;
      // Clamp negative scrollTop (iOS rubber-band) to 0 so overscroll never
      // jitters the title.
      const y = Math.max(0, el.scrollTop);
      const p = Math.min(y / COLLAPSE_PX, 1);
      large.style.opacity = (1 - p).toFixed(3);
      // Rise + slight shrink as it collapses (origin bottom-left, like UIKit).
      large.style.transform = `translate3d(0, ${(-8 * p).toFixed(2)}px, 0) scale(${(1 - 0.04 * p).toFixed(4)})`;
      const cp = p <= COMPACT_FADE_START ? 0 : (p - COMPACT_FADE_START) / (1 - COMPACT_FADE_START);
      compact.style.opacity = cp.toFixed(3);
    };
    const onScroll = () => {
      // Coalesce to one style write per frame.
      if (!raf) raf = requestAnimationFrame(apply);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    apply(); // sync to the current position (e.g. restored scroll)
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  });
</script>

<!-- Compact inline state: sticky against the scroll container, zero net layout
     height (negative bottom margin), invisible until the collapse threshold.
     Purely decorative (the title is announced by the large heading) and never
     interactive — pointer-events stay off so it can't shadow taps on content
     scrolling beneath it. -->
<div
  bind:this={compactBarEl}
  class="mlt-compact material-bar hairline-b"
  aria-hidden="true"
>
  <span class="mlt-compact-title text-content">{title}</span>
</div>

<div class="mlt-large">
  <h1 bind:this={largeTitleEl} class="mlt-title text-content">{title}</h1>
  {#if actions}
    <div class="mlt-actions">
      {@render actions()}
    </div>
  {/if}
</div>

<style>
  .mlt-compact {
    position: sticky;
    top: 0;
    z-index: 30;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 2.25rem;
    /* Occupy zero net flow height so showing/hiding never shifts content. */
    margin-bottom: -2.25rem;
    opacity: 0;
    pointer-events: none;
  }
  .mlt-compact-title {
    font-size: 17px;
    line-height: 22px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 70%;
  }

  .mlt-large {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.25rem 1rem 0.5rem;
  }
  .mlt-title {
    /* Apple HIG LargeTitle: 34/41 bold. */
    font-size: 34px;
    line-height: 41px;
    font-weight: 700;
    letter-spacing: 0.01em;
    margin: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transform-origin: left bottom;
    /* Scroll-driven opacity/transform are imperative inline writes. */
    will-change: transform, opacity;
  }
  .mlt-actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
    padding-bottom: 0.25rem;
  }
</style>
