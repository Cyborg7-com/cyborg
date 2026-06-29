<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";

  // Mobile pull-to-refresh wrapper. OWNS the scrollable element (so the elastic
  // overscroll transform has something to translate) and exposes it via
  // `bind:scrollEl` so consumers keep their auto-scroll / querySelector ref.
  // Desktop is a passthrough: the scroll div renders with no touch handlers and
  // no transform, so layout/behaviour are unchanged.
  let {
    onRefresh,
    children,
    scrollEl = $bindable<HTMLDivElement | undefined>(undefined),
    onscroll,
    scrollClass = "min-h-0 flex-1 overflow-y-auto",
    threshold = 64,
    disabled = false,
  }: {
    onRefresh: () => void | Promise<void>;
    children: Snippet;
    /** The scroll container; bind it to reuse the consumer's existing ref. */
    scrollEl?: HTMLDivElement;
    /** Forwarded to the scroll element (e.g. infinite-scroll / at-bottom logic). */
    onscroll?: (e: Event) => void;
    scrollClass?: string;
    threshold?: number;
    disabled?: boolean;
  } = $props();

  // 0.55 (was 0.4): less rubbery resistance — the indicator tracks the finger
  // closer to 1:1, Slack/Mail-style. Threshold and arm-at-top gating unchanged.
  const DAMPING = 0.55;
  const MAX_PULL = 120;
  const MIN_SPINNER_MS = 500;

  // Gate to touch devices: coarse pointer OR the app's mobile breakpoint.
  const coarse =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  const enabled = $derived(!disabled && (coarse || viewportState.isMobile));

  let pull = $state(0);
  let dragging = $state(false);
  let refreshing = $state(false);
  let startY = 0;
  let tracking = false;

  const ready = $derived(pull >= threshold);
  // 0 → 1 as the user approaches the threshold (drives opacity + arrow rotation).
  const progress = $derived(Math.min(pull / threshold, 1));

  function onTouchStart(e: TouchEvent): void {
    if (!enabled || refreshing || !scrollEl) return;
    // Only arm at the very top — otherwise this is a normal upward scroll.
    if (scrollEl.scrollTop > 0) {
      tracking = false;
      return;
    }
    startY = e.touches[0]?.clientY ?? 0;
    tracking = true;
  }

  function onTouchMove(e: TouchEvent): void {
    if (!tracking || refreshing) return;
    const y = e.touches[0]?.clientY ?? 0;
    const delta = (y - startY) * DAMPING;
    if (delta <= 0) {
      // Pulling back up — hand control back to native scrolling.
      pull = 0;
      dragging = false;
      tracking = false;
      return;
    }
    // Active downward pull at the top: take over so the page doesn't also scroll.
    e.preventDefault();
    dragging = true;
    pull = Math.min(delta, MAX_PULL);
  }

  async function onTouchEnd(): Promise<void> {
    if (!tracking) return;
    tracking = false;
    dragging = false;
    if (pull < threshold || refreshing) {
      pull = 0;
      return;
    }
    refreshing = true;
    pull = threshold; // rest at the spinner height while refreshing
    const started = performance.now();
    try {
      await onRefresh();
    } catch {
      // Surfaced by the refresh target's own error handling; never throw here.
    } finally {
      const elapsed = performance.now() - started;
      if (elapsed < MIN_SPINNER_MS) {
        await new Promise((r) => setTimeout(r, MIN_SPINNER_MS - elapsed));
      }
      refreshing = false;
      pull = 0;
    }
  }

  // Bind touch listeners imperatively so touchmove is non-passive and
  // preventDefault() actually works (passive listeners can't cancel scroll).
  $effect(() => {
    const el = scrollEl;
    if (!enabled || !el) return;
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  });
</script>

<div class={cn("relative flex min-h-0 flex-1 flex-col", enabled && "overflow-hidden")}>
  {#if enabled && (pull > 0 || refreshing)}
    <div
      class="pointer-events-none absolute left-0 right-0 top-0 z-20 flex justify-center"
      style="transform: translateY({Math.max(pull - 32, 4)}px); opacity: {refreshing ? 1 : progress}; transition: {dragging ? 'none' : 'transform 0.2s ease-out, opacity 0.2s ease-out'};"
    >
      <div
        class="flex h-[32px] w-[32px] items-center justify-center rounded-full border border-edge bg-raised shadow-sm"
      >
        {#if refreshing}
          <svg class="h-[20px] w-[20px] animate-spin text-content-muted" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" stroke-opacity="0.25" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
          </svg>
        {:else}
          <!-- Up-arrow SVG: rotated 180° (points DOWN) while pulling, flips to
               0° (points UP) once past the threshold = "release to refresh". -->
          <svg
            class="h-[20px] w-[20px] text-content-muted"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            style="transition: transform 0.15s ease-out; transform: rotate({ready ? 0 : 180}deg);"
          >
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="5 12 12 5 19 12" />
          </svg>
        {/if}
      </div>
    </div>
  {/if}

  <div
    bind:this={scrollEl}
    onscroll={onscroll}
    class={scrollClass}
    style={enabled
      ? `transform: translateY(${pull}px); transition: ${dragging ? "none" : "transform 0.2s ease-out"};`
      : ""}
  >
    {@render children()}
  </div>
</div>
