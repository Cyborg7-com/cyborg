<script lang="ts">
  // Controlled single-select CYCLE editor for the Tasks surfaces. Renders a
  // trigger CHIP (compact card) or a ROW editor (detail-panel property row) that
  // opens a dropdown listing the project's cycles plus a "No cycle" option.
  // Selecting fires onChange(cycleId | null) — the PARENT owns the cycle list +
  // persistence; this component holds NO client/state references.
  //
  // Mirrors the State/Priority editors' dropdown shape + ui.ts tokens so the
  // editors read identically. A cycle has no per-cycle color, so its trigger +
  // rows use a neutral cycle glyph (a circular-arrow) tinted by currentColor.
  // Token-only; zero raw color literals.
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
  } from "$lib/components/ui/dropdown-menu/index.js";
  import {
    workChipPill,
    propertyEditor,
    propertyEditorEmpty,
    menuPanel,
    filterOption,
    menuItemRowActive,
  } from "$lib/tasks/ui.js";
  import { cn } from "$lib/utils.js";

  // One selectable cycle (a time-boxed iteration). Id + display name only.
  export interface TaskCycle {
    id: string;
    name: string;
  }

  let {
    value = null,
    options = [],
    disabled = false,
    onChange,
    placeholder = "Cycle",
    variant = "chip",
    class: className,
  }: {
    // The currently-selected cycle id (or null when unset). Controlled.
    value?: string | null;
    // The project's cycles, listed in the order given.
    options?: TaskCycle[];
    disabled?: boolean;
    // Fired with the chosen cycle id (or null for "No cycle") on every selection.
    onChange: (next: string | null) => void;
    placeholder?: string;
    variant?: "chip" | "row";
    class?: string;
  } = $props();

  const selected = $derived(options.find((c) => c.id === value) ?? null);
  // chip = Plane's cycle pill (border-with-text BorderButton: workChipPill).
  const triggerClass = $derived(variant === "row" ? propertyEditor : workChipPill);
  const iconSize = $derived(variant === "row" ? 16 : 14);
</script>

{#snippet cycleGlyph(size: number)}
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="shrink-0 text-content-muted"
  >
    <path d="M21 12a9 9 0 1 1-3-6.7" />
    <path d="M21 4v5h-5" />
  </svg>
{/snippet}

<DropdownMenu>
  <DropdownMenuTrigger
    {disabled}
    title={selected?.name ?? placeholder}
    aria-label={selected ? `Cycle: ${selected.name}` : placeholder}
    class={cn(triggerClass, "data-[state=open]:bg-hover-gray", className)}
  >
    {@render cycleGlyph(iconSize)}
    {#if variant === "row"}
      <span class={cn("truncate", !selected && propertyEditorEmpty)}>
        {selected ? selected.name : placeholder}
      </span>
    {:else if selected}
      <span class="truncate">{selected.name}</span>
    {/if}
  </DropdownMenuTrigger>
  <DropdownMenuContent align="start" class={cn(menuPanel, "max-h-80 overflow-y-auto p-1")}>
    <DropdownMenuItem
      class={cn(filterOption, "cursor-pointer", value == null && menuItemRowActive)}
      onSelect={() => onChange(null)}
    >
      {@render cycleGlyph(16)}
      <span class="truncate text-content-muted">No cycle</span>
    </DropdownMenuItem>

    {#each options as c (c.id)}
      <DropdownMenuItem
        class={cn(filterOption, "cursor-pointer", value === c.id && menuItemRowActive)}
        onSelect={() => onChange(c.id)}
      >
        {@render cycleGlyph(16)}
        <span class="truncate">{c.name}</span>
      </DropdownMenuItem>
    {/each}

    {#if options.length === 0}
      <span class="block px-2 py-2 text-[12px] text-content-muted">No cycles</span>
    {/if}
  </DropdownMenuContent>
</DropdownMenu>
