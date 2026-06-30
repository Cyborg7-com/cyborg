<script lang="ts">
  // WS3 — the property-row primitive used by the mobile task DETAIL screen (and
  // exposed to sibling mobile surfaces). A single full-width, ≥44px tappable row
  // that reads as "icon · label … value · chevron": the leading `icon` snippet,
  // the fixed-width property `label`, the trailing `value` snippet (right-aligned),
  // and a chevron hinting it opens a picker. Tapping fires `onclick` (the host
  // opens the matching WS0 picker sheet); a per-row `pending` spinner shows while
  // that field's optimistic save is in flight (driven by useTaskDetail.pendingIds).
  //
  // Presentation only — props-in / callbacks-out, no client/state refs. Token-only
  // (.touch-target-row lifts the row to the 44px touch target on coarse pointers,
  // .pressable-row is the tint-only press feedback); zero hex / inline color px.
  import type { Snippet } from "svelte";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import { cn } from "$lib/utils.js";

  let {
    label,
    icon,
    value,
    onclick,
    pending = false,
    disabled = false,
    ariaLabel,
    class: className,
  }: {
    label: string;
    // Optional leading glyph (a lucide icon / StateGroupIcon / AssigneeAvatar).
    icon?: Snippet;
    // The current value display, right-aligned (a chip, a name, "Empty", …).
    value?: Snippet;
    onclick?: () => void;
    // This field has an in-flight optimistic save → show the spinner, hide chevron.
    pending?: boolean;
    disabled?: boolean;
    ariaLabel?: string;
    class?: string;
  } = $props();
</script>

<button
  type="button"
  onclick={() => onclick?.()}
  {disabled}
  aria-label={ariaLabel ?? label}
  class={cn(
    "touch-target-row pressable-row flex w-full items-center gap-3 px-4 py-2 text-left",
    "disabled:opacity-60",
    className,
  )}
>
  <span class="grid size-4 shrink-0 place-items-center text-content-muted">
    {#if icon}{@render icon()}{/if}
  </span>
  <span class="w-20 shrink-0 text-[13px] font-medium text-content-dim">{label}</span>
  <span class="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1.5 text-[13px] text-content">
    {#if value}{@render value()}{/if}
  </span>
  {#if pending}
    <span
      class="size-3.5 shrink-0 animate-spin rounded-full border-2 border-content-muted border-t-transparent"
      aria-hidden="true"
    ></span>
  {:else if onclick}
    <ChevronRightIcon class="size-4 shrink-0 text-content-muted" />
  {/if}
</button>
