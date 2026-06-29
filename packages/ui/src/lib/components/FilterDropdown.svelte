<!--
  FilterDropdown — the custom filter-dropdown LogsPane hand-rolled 3× (time /
  category / agent), and that recurs lightly elsewhere (#534). Owns its own
  open-state + outside-click; the parent just supplies the options and a select
  handler. The trigger shows the selected option's label, so callers don't pass
  a separate trigger string.

  Props:
  - `value`     — the currently-selected option value.
  - `options`   — `{ value, label }[]`; the trigger renders the matching label.
  - `onSelect`  — called with the chosen value (the menu then closes).
  - `menuWidth` — CSS width of the dropdown menu (default 150px).
  - `ariaLabel` — accessible name for the trigger button.
  - `icon`      — optional leading icon snippet in the trigger.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils.js";

  interface Option {
    value: string;
    label: string;
  }

  let {
    value,
    options,
    onSelect,
    menuWidth = "150px",
    ariaLabel,
    icon,
  }: {
    value: string;
    options: ReadonlyArray<Option>;
    onSelect: (value: string) => void;
    menuWidth?: string;
    ariaLabel?: string;
    icon?: Snippet;
  } = $props();

  let open = $state(false);
  let wrapper = $state<HTMLDivElement>();

  const selectedLabel = $derived(options.find((o) => o.value === value)?.label ?? "");

  function choose(v: string): void {
    onSelect(v);
    open = false;
  }

  // Self-contained outside-click: close when a click lands outside this
  // instance's wrapper (replaces LogsPane's shared id-based handler).
  function onDocClick(e: MouseEvent): void {
    if (open && wrapper && !wrapper.contains(e.target as Node)) open = false;
  }
</script>

<svelte:document onclick={onDocClick} />

<div class="relative" bind:this={wrapper}>
  <button
    type="button"
    onclick={() => (open = !open)}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={ariaLabel}
    class="flex cursor-pointer items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1.5 text-xs font-medium text-content transition-colors hover:bg-raised"
    style="background-color: var(--bg-surface);"
  >
    {#if icon}
      {@render icon()}
    {/if}
    {selectedLabel}
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  </button>
  {#if open}
    <div
      class="absolute left-0 top-full z-50 mt-1 rounded-lg py-1 shadow-lg"
      style="width: {menuWidth}; background-color: var(--dropdown-bg, var(--bg-raised)); border: 1px solid var(--dropdown-border, var(--border-edge)); box-shadow: var(--dropdown-shadow, 0 4px 12px rgba(0,0,0,0.15));"
      role="menu"
    >
      {#each options as opt (opt.value)}
        <button
          type="button"
          role="menuitemradio"
          aria-checked={value === opt.value}
          onclick={() => choose(opt.value)}
          class={cn(
            "w-full cursor-pointer px-3 py-1.5 text-left text-[12px] transition-colors",
            value === opt.value ? "font-semibold text-content" : "text-content-muted hover:text-content",
          )}
          style={value === opt.value ? "background-color: var(--bg-surface-alt);" : ""}
        >
          {opt.label}
        </button>
      {/each}
    </div>
  {/if}
</div>
