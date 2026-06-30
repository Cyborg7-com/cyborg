<script lang="ts">
  // Controlled multi-select LABEL editor for the Tasks surfaces. Renders a
  // trigger CHIP (compact card) or a ROW editor (detail-panel property row) that
  // opens a dropdown listing the project's label catalog with a checkbox per
  // label, a filter input, and an inline "Create <name>" affordance when the
  // typed name matches nothing. Selecting toggles a label; each toggle fires
  // onChange(nextLabelIds) with the FULL next id array — the PARENT owns the
  // label catalog + persistence; this component holds NO client/state refs.
  //
  // Multi-select: the menu stays open on toggle (closeOnSelect={false}) like the
  // toolbar's Display/filter menus, so a user can pick several labels in one
  // pass. The filter <input> stops keydown propagation so the menu's built-in
  // typeahead never steals the keystrokes (there is no Command primitive in the
  // shadcn set here — DropdownMenu + a stop-propagation input is the repo idiom).
  //
  // Token-only: trigger via inlineRowControl / propertyEditor / propertyEditorEmpty,
  // each chip via the ui.ts labelChip base + the app.css --label-* color triad
  // (bg-label-<color>-bg / text-label-<color>-text / border-label-<color>-border),
  // the "+ Add" stub via labelChipAdd. Zero raw color literals.
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
    labelChip,
    labelChipDot,
    labelChipAdd,
    checkBoxBase,
    checkBoxChecked,
  } from "$lib/tasks/ui.js";
  import { haptic } from "$lib/mobile/haptics.js";
  import { cn } from "$lib/utils.js";

  // One selectable label. `color` keys the app.css --label-* palette (a
  // LABEL_COLORS name, e.g. "indigo"); the chip resolves its bg/text/border triad
  // off it. Names that fall outside the palette degrade to the neutral "grey"
  // triad rather than emitting an unknown class.
  export interface TaskLabel {
    id: string;
    name: string;
    color: string;
  }

  let {
    value = [],
    options = [],
    disabled = false,
    onChange,
    onCreate,
    placeholder = "Labels",
    variant = "chip",
    class: className,
  }: {
    // The currently-selected label ids. Controlled — never mutated here.
    value?: string[];
    // The project's label catalog. Rendered as a checkbox list, filterable.
    options?: TaskLabel[];
    disabled?: boolean;
    // Fired with the FULL next id array on every toggle.
    onChange: (next: string[]) => void;
    // Optional create-by-name hook. When provided, a "Create <name>" row appears
    // for an unmatched filter; the parent creates the label and is responsible
    // for adding it to both `options` and `value` (this component does not assume
    // the new id). Omit it to disable inline creation.
    onCreate?: (name: string) => void;
    // Trigger hint when no label is selected (row variant).
    placeholder?: string;
    // chip / row = trigger + popover; inline = the filter + checkbox list rendered
    // directly (no trigger/popover) for the mobile picker sheet. Multi-select:
    // tapping a row toggles it and the sheet stays open.
    variant?: "chip" | "row" | "inline";
    class?: string;
  } = $props();

  // Resolve the app.css triad for a label color, degrading an unknown color to
  // the neutral "grey" palette so a stray value never emits a missing class.
  const PALETTE = ["indigo", "emerald", "grey", "crimson", "yellow", "orange", "pink", "purple"];
  function triad(color: string): string {
    const c = PALETTE.includes(color) ? color : "grey";
    return `bg-label-${c}-bg text-label-${c}-text border-label-${c}-border`;
  }
  function dotFill(color: string): string {
    const c = PALETTE.includes(color) ? color : "grey";
    return `bg-label-${c}-text`;
  }

  const selected = $derived(options.filter((l) => value.includes(l.id)));
  const triggerClass = $derived(variant === "row" ? propertyEditor : inlineRowControl);

  // Filter state for the in-menu search + create-by-name affordance.
  let query = $state("");
  const filtered = $derived(
    query.trim()
      ? options.filter((l) => l.name.toLowerCase().includes(query.trim().toLowerCase()))
      : options,
  );
  // Show the create row only when a non-empty query matches no EXISTING label
  // name (case-insensitive) and the parent wired an onCreate handler.
  const canCreate = $derived(
    Boolean(onCreate) &&
      query.trim().length > 0 &&
      !options.some((l) => l.name.toLowerCase() === query.trim().toLowerCase()),
  );

  // Toggle a label id in/out of the controlled set and emit the full next array.
  function toggle(id: string): void {
    const next = value.includes(id) ? value.filter((x) => x !== id) : [...value, id];
    onChange(next);
  }
  function create(): void {
    const name = query.trim();
    if (!name) return;
    onCreate?.(name);
    query = "";
  }
</script>

{#if variant === "inline"}
  <!-- Inline filter + checkbox list for the mobile picker sheet: same filter /
       create-by-name input and checkbox rows as the popover, checked rows tinted,
       but no trigger/popover. Multi-select: each tap toggles and the sheet stays
       open. -->
  <div class={cn("flex flex-col", className)}>
    <input
      type="text"
      bind:value={query}
      placeholder="Filter or create…"
      onkeydown={(e) => {
        if (e.key === "Enter" && canCreate) {
          e.preventDefault();
          create();
        }
      }}
      class="mb-1 h-7 w-full rounded-[4px] border border-edge bg-surface-alt px-2 text-[12px] text-content outline-none focus:border-accent"
    />

    {#each filtered as l (l.id)}
      {@const checked = value.includes(l.id)}
      <button
        type="button"
        {disabled}
        aria-label={l.name}
        aria-pressed={checked}
        class={cn(filterOption, "cursor-pointer", checked && menuItemRowActive)}
        onclick={() => {
          haptic("selection");
          toggle(l.id);
        }}
      >
        <span class={cn(checkBoxBase, checked && checkBoxChecked)}>
          {#if checked}
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m5 12 5 5 9-11" />
            </svg>
          {/if}
        </span>
        <span class={cn(labelChipDot, dotFill(l.color))}></span>
        <span class="truncate">{l.name}</span>
      </button>
    {/each}

    {#if canCreate}
      <button
        type="button"
        class={cn(filterOption, "cursor-pointer text-accent")}
        onclick={() => {
          haptic("selection");
          create();
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span class="truncate">Create “{query.trim()}”</span>
      </button>
    {/if}

    {#if filtered.length === 0 && !canCreate}
      <span class="block px-2 py-2 text-[12px] text-content-muted">No labels</span>
    {/if}
  </div>
{:else}
  <DropdownMenu>
  <DropdownMenuTrigger
    {disabled}
    title={selected.length ? selected.map((l) => l.name).join(", ") : placeholder}
    aria-label={selected.length ? `Labels: ${selected.map((l) => l.name).join(", ")}` : placeholder}
    class={cn(triggerClass, "data-[state=open]:bg-hover-gray", className)}
  >
    {#if selected.length === 0}
      {#if variant === "row"}
        <span class={cn(labelChipAdd)}>{placeholder}</span>
      {:else}
        <!-- chip variant with nothing set: a quiet dashed "+ label" stub -->
        <span class={cn(labelChipAdd)}>{placeholder}</span>
      {/if}
    {:else}
      <!-- Render the picked labels as their color chips, both variants. -->
      <span class="flex min-w-0 flex-wrap items-center gap-1">
        {#each selected as l (l.id)}
          <span class={cn(labelChip, triad(l.color))}>
            <span class={cn(labelChipDot, dotFill(l.color))}></span>
            <span class="truncate">{l.name}</span>
          </span>
        {/each}
      </span>
    {/if}
  </DropdownMenuTrigger>
  <DropdownMenuContent align="start" class={cn(menuPanel, "max-h-80 overflow-y-auto p-1")}>
    <!-- Filter / create-by-name input. stopPropagation on keydown so the menu's
         built-in typeahead never hijacks typing; Enter creates when nothing
         matches the query. -->
    <input
      type="text"
      bind:value={query}
      placeholder="Filter or create…"
      onkeydown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && canCreate) {
          e.preventDefault();
          create();
        }
      }}
      class="mb-1 h-7 w-full rounded-[4px] border border-edge bg-surface-alt px-2 text-[12px] text-content outline-none focus:border-accent"
    />

    {#each filtered as l (l.id)}
      {@const checked = value.includes(l.id)}
      <DropdownMenuItem
        closeOnSelect={false}
        class={cn(filterOption, "cursor-pointer", checked && menuItemRowActive)}
        onSelect={() => toggle(l.id)}
      >
        <span class={cn(checkBoxBase, checked && checkBoxChecked)}>
          {#if checked}
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m5 12 5 5 9-11" />
            </svg>
          {/if}
        </span>
        <span class={cn(labelChipDot, dotFill(l.color))}></span>
        <span class="truncate">{l.name}</span>
      </DropdownMenuItem>
    {/each}

    {#if canCreate}
      <DropdownMenuItem
        closeOnSelect={false}
        class={cn(filterOption, "cursor-pointer text-accent")}
        onSelect={() => create()}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span class="truncate">Create “{query.trim()}”</span>
      </DropdownMenuItem>
    {/if}

    {#if filtered.length === 0 && !canCreate}
      <span class="block px-2 py-2 text-[12px] text-content-muted">No labels</span>
    {/if}
  </DropdownMenuContent>
  </DropdownMenu>
{/if}
