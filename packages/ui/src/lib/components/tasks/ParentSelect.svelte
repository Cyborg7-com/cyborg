<script lang="ts">
  // Controlled PARENT-TASK editor for the Tasks surfaces. Renders a trigger CHIP
  // (compact card) or a ROW editor (detail-panel property row) that opens a
  // dropdown with a search input filtering candidate tasks by their key
  // (sequenceId, e.g. "#TASK-12") or title; picking one fires onChange(parentId)
  // and a "No parent" row fires onChange(null) — the PARENT owns the candidate
  // list + persistence; this component holds NO client/state references.
  //
  // The candidate list is whatever `options` the parent passes (it may pre-filter
  // server-side and re-feed options as the query changes, or pass the whole set
  // and let this component filter locally). The search <input> stops keydown
  // propagation so the menu's typeahead never steals keystrokes (no Command
  // primitive exists in the shadcn set here). Token-only; zero raw color literals.
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
  } from "$lib/components/ui/dropdown-menu/index.js";
  import {
    inlineRowControl,
    propertyEditor,
    propertyEditorEmpty,
    menuPanel,
    filterOption,
    menuItemRowActive,
    subItemId,
  } from "$lib/tasks/ui.js";
  import { cn } from "$lib/utils.js";

  // A candidate / selected parent task. `sequenceId` is the human key shown as a
  // muted "#…" chip (Plane's issue identifier); `title` is the task name.
  export interface ParentTask {
    id: string;
    sequenceId: string;
    title: string;
  }

  let {
    value = null,
    options = [],
    disabled = false,
    onChange,
    onSearch,
    placeholder = "Parent",
    variant = "chip",
    class: className,
  }: {
    // The currently-selected parent task id (or null when unset). Controlled.
    value?: string | null;
    // The candidate tasks. Already excludes the current task / its descendants —
    // the parent is responsible for not offering an invalid (cyclic) parent.
    options?: ParentTask[];
    disabled?: boolean;
    // Fired with the chosen task id (or null for "No parent") on every selection.
    onChange: (next: string | null) => void;
    // Optional: notified of the live query so a parent doing server-side search
    // can re-feed `options`. Omit it to filter the given `options` locally.
    onSearch?: (query: string) => void;
    placeholder?: string;
    variant?: "chip" | "row";
    class?: string;
  } = $props();

  // The selected task may not be in `options` (the candidate list can be a
  // search-narrowed slice), so resolve it leniently from options and fall back to
  // a bare key when only the id is known.
  const selected = $derived(options.find((t) => t.id === value) ?? null);
  const triggerClass = $derived(variant === "row" ? propertyEditor : inlineRowControl);
  const iconSize = $derived(variant === "row" ? 16 : 14);

  let query = $state("");
  // Local filter over the given options by key OR title. A parent that searches
  // server-side can ignore this (it re-feeds options) — the local filter is then
  // a no-op narrowing of an already-narrowed list.
  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (t) => t.sequenceId.toLowerCase().includes(q) || t.title.toLowerCase().includes(q),
    );
  });

  function onQueryInput(v: string): void {
    query = v;
    onSearch?.(v.trim());
  }
</script>

{#snippet parentGlyph(size: number)}
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
    <path d="M6 3v12" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="6" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </svg>
{/snippet}

<DropdownMenu>
  <DropdownMenuTrigger
    {disabled}
    title={selected ? `${selected.sequenceId} ${selected.title}` : placeholder}
    aria-label={selected ? `Parent: ${selected.sequenceId} ${selected.title}` : placeholder}
    class={cn(triggerClass, "data-[state=open]:bg-hover-gray", className)}
  >
    {@render parentGlyph(iconSize)}
    {#if selected}
      <span class={subItemId}>{selected.sequenceId}</span>
      {#if variant === "row"}
        <span class="truncate">{selected.title}</span>
      {/if}
    {:else if variant === "row"}
      <span class={cn("truncate", propertyEditorEmpty)}>{placeholder}</span>
    {/if}
  </DropdownMenuTrigger>
  <DropdownMenuContent align="start" class={cn(menuPanel, "max-h-80 w-72 overflow-y-auto p-1")}>
    <input
      type="text"
      value={query}
      placeholder="Search tasks…"
      oninput={(e) => onQueryInput(e.currentTarget.value)}
      onkeydown={(e) => e.stopPropagation()}
      class="mb-1 h-7 w-full rounded-[4px] border border-edge bg-surface-alt px-2 text-[12px] text-content outline-none focus:border-accent"
    />

    <DropdownMenuItem
      class={cn(filterOption, "cursor-pointer", value == null && menuItemRowActive)}
      onSelect={() => onChange(null)}
    >
      {@render parentGlyph(16)}
      <span class="truncate text-content-muted">No parent</span>
    </DropdownMenuItem>

    {#each filtered as t (t.id)}
      <DropdownMenuItem
        class={cn(filterOption, "cursor-pointer", value === t.id && menuItemRowActive)}
        onSelect={() => onChange(t.id)}
      >
        <span class={subItemId}>{t.sequenceId}</span>
        <span class="truncate">{t.title}</span>
      </DropdownMenuItem>
    {/each}

    {#if filtered.length === 0}
      <span class="block px-2 py-2 text-[12px] text-content-muted">No matching tasks</span>
    {/if}
  </DropdownMenuContent>
</DropdownMenu>
