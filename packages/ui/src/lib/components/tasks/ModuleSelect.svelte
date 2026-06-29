<script lang="ts">
  // Controlled multi-select MODULE editor for the Tasks surfaces. Renders a
  // trigger CHIP (compact card) or a ROW editor (detail-panel property row) that
  // opens a dropdown listing the project's modules with a checkbox per module and
  // a filter input. Toggling a module fires onChange(nextModuleIds) with the FULL
  // next id array — the PARENT owns the module list + persistence; this component
  // holds NO client/state references.
  //
  // Multi-select: the menu stays open on toggle (closeOnSelect={false}) like the
  // toolbar's filter menus. The filter <input> stops keydown propagation so the
  // menu's built-in typeahead never steals the keystrokes (no Command primitive
  // exists in the shadcn set here — DropdownMenu + a stop-propagation input is the
  // repo idiom). A module has no per-module color; rows + the trigger use a
  // neutral cube glyph tinted by currentColor. Token-only; zero raw color literals.
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
    checkBoxBase,
    checkBoxChecked,
  } from "$lib/tasks/ui.js";
  import { cn } from "$lib/utils.js";

  // One selectable module (a grouping of work toward a deliverable). Id + name.
  export interface TaskModule {
    id: string;
    name: string;
  }

  let {
    value = [],
    options = [],
    disabled = false,
    onChange,
    placeholder = "Modules",
    variant = "chip",
    class: className,
  }: {
    // The currently-selected module ids. Controlled — never mutated here.
    value?: string[];
    // The project's modules, listed in the order given (filterable).
    options?: TaskModule[];
    disabled?: boolean;
    // Fired with the FULL next id array on every toggle.
    onChange: (next: string[]) => void;
    placeholder?: string;
    variant?: "chip" | "row";
    class?: string;
  } = $props();

  const selected = $derived(options.filter((m) => value.includes(m.id)));
  // chip = Plane's module pill (border-with-text BorderButton: workChipPill).
  const triggerClass = $derived(variant === "row" ? propertyEditor : workChipPill);
  const iconSize = $derived(variant === "row" ? 16 : 14);

  let query = $state("");
  const filtered = $derived(
    query.trim()
      ? options.filter((m) => m.name.toLowerCase().includes(query.trim().toLowerCase()))
      : options,
  );

  // Toggle a module id in/out of the controlled set and emit the full next array.
  function toggle(id: string): void {
    const next = value.includes(id) ? value.filter((x) => x !== id) : [...value, id];
    onChange(next);
  }
</script>

{#snippet moduleGlyph(size: number)}
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
    <path d="M21 8 12 3 3 8l9 5 9-5Z" />
    <path d="M3 8v8l9 5 9-5V8" />
    <path d="M12 13v8" />
  </svg>
{/snippet}

<DropdownMenu>
  <DropdownMenuTrigger
    {disabled}
    title={selected.length ? selected.map((m) => m.name).join(", ") : placeholder}
    aria-label={selected.length ? `Modules: ${selected.map((m) => m.name).join(", ")}` : placeholder}
    class={cn(triggerClass, "data-[state=open]:bg-hover-gray", className)}
  >
    {@render moduleGlyph(iconSize)}
    {#if variant === "row"}
      <span class={cn("truncate", selected.length === 0 && propertyEditorEmpty)}>
        {selected.length ? selected.map((m) => m.name).join(", ") : placeholder}
      </span>
    {:else if selected.length}
      <span class="truncate">
        {selected.length === 1 ? selected[0].name : `${selected.length} modules`}
      </span>
    {/if}
  </DropdownMenuTrigger>
  <DropdownMenuContent align="start" class={cn(menuPanel, "max-h-80 overflow-y-auto p-1")}>
    <input
      type="text"
      bind:value={query}
      placeholder="Filter modules…"
      onkeydown={(e) => e.stopPropagation()}
      class="mb-1 h-7 w-full rounded-[4px] border border-edge bg-surface-alt px-2 text-[12px] text-content outline-none focus:border-accent"
    />

    {#each filtered as m (m.id)}
      {@const checked = value.includes(m.id)}
      <DropdownMenuItem
        closeOnSelect={false}
        class={cn(filterOption, "cursor-pointer", checked && menuItemRowActive)}
        onSelect={() => toggle(m.id)}
      >
        <span class={cn(checkBoxBase, checked && checkBoxChecked)}>
          {#if checked}
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m5 12 5 5 9-11" />
            </svg>
          {/if}
        </span>
        {@render moduleGlyph(16)}
        <span class="truncate">{m.name}</span>
      </DropdownMenuItem>
    {/each}

    {#if filtered.length === 0}
      <span class="block px-2 py-2 text-[12px] text-content-muted">No modules</span>
    {/if}
  </DropdownMenuContent>
</DropdownMenu>
