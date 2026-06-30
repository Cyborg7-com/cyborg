<script lang="ts">
  // Token-only segmented control primitive (WS0 foundation). A horizontal row of
  // mutually-exclusive segments with a neutral "thumb" behind the active one —
  // the iOS UISegmentedControl shape. Generic over string values; consumers bind
  // `value` and pass `options`. Used by TasksViewSwitcher (List·Board·Calendar·
  // Gantt) and the Detail Details/Activity switch (WS3). No hex / inline color px;
  // the label size is token-driven via --seg-label-size, never an inline text-[..].
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils.js";

  interface Option {
    value: string;
    label?: string;
    // Optional leading glyph snippet (e.g. a lucide icon).
    icon?: Snippet;
    ariaLabel?: string;
  }

  let {
    options,
    value = $bindable(""),
    onChange,
    ariaLabel = undefined,
    class: className = undefined,
  }: {
    options: Option[];
    value?: string;
    onChange?: (value: string) => void;
    ariaLabel?: string;
    class?: string;
  } = $props();

  function select(next: string): void {
    if (next === value) return;
    value = next;
    onChange?.(next);
  }
</script>

<div
  class={cn("seg-root inline-flex w-full rounded-[var(--radius-md)] bg-deeper p-0.5", className)}
  role="tablist"
  aria-label={ariaLabel}
>
  {#each options as opt (opt.value)}
    {@const active = value === opt.value}
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={opt.ariaLabel ?? opt.label}
      onclick={() => select(opt.value)}
      class={cn(
        "seg-item flex min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] px-2.5 py-1.5 font-medium transition-colors focus-ring",
        active ? "bg-surface-alt text-content shadow-sm" : "text-content-muted hover:text-content",
      )}
    >
      {#if opt.icon}{@render opt.icon()}{/if}
      {#if opt.label}<span class="seg-label">{opt.label}</span>{/if}
    </button>
  {/each}
</div>

<style>
  /* Token-driven label size (never an inline text-[10.5px], per Rule 14). */
  .seg-label {
    font-size: var(--seg-label-size, 0.8125rem);
    line-height: 1;
  }
</style>
