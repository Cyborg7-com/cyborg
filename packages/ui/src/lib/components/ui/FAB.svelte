<script lang="ts">
  // Token-only floating action button primitive (WS0 foundation). Bottom-right,
  // accent-filled, springy press. The bottom offset CLEARS the bottom nav via a
  // CSS var (--fab-nav-clearance) + the safe-area inset (--sab) — NEVER a literal
  // 58px — and the right offset honors --sar. Hides via the `hidden` prop (the
  // consumer, e.g. TasksFab, suppresses it during an open sheet / soft keyboard /
  // board drag). No hex / inline color px.
  import type { Snippet } from "svelte";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import { cn } from "$lib/utils.js";

  let {
    onclick,
    ariaLabel = "Create",
    hidden = false,
    children,
    class: className = undefined,
  }: {
    onclick?: () => void;
    ariaLabel?: string;
    hidden?: boolean;
    // Optional custom glyph; defaults to a plus.
    children?: Snippet;
    class?: string;
  } = $props();
</script>

{#if !hidden}
  <button
    type="button"
    onclick={() => onclick?.()}
    aria-label={ariaLabel}
    class={cn(
      "fab grid place-items-center rounded-full bg-accent text-accent-foreground shadow-lg transition-transform duration-150 active:scale-95 focus-ring",
      className,
    )}
  >
    {#if children}
      {@render children()}
    {:else}
      <PlusIcon class="size-6" />
    {/if}
  </button>
{/if}

<style>
  .fab {
    position: fixed;
    right: max(1rem, var(--sar));
    /* Clear the floating bottom nav (capsule + gutters) + the safe-area inset.
       --fab-nav-clearance is the single knob a host can override; the literal
       58px capsule height is intentionally NOT referenced here. */
    bottom: calc(var(--fab-nav-clearance, 5.25rem) + var(--sab));
    height: 3.5rem;
    width: 3.5rem;
    /* Above page content, below the bottom sheets (--z-menu); the consumer hides
       the FAB while a sheet is open so they never stack. */
    z-index: calc(var(--z-menu) - 1);
  }
  @media (prefers-reduced-motion: reduce) {
    .fab {
      transition: none;
    }
  }
</style>
