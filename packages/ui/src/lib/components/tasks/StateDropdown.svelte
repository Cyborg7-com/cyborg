<script lang="ts">
  // Controlled STATE editor for the Tasks surfaces. Renders a trigger CHIP
  // (compact card) or a ROW editor (detail-panel property row) that opens a
  // dropdown listing the project's task_states GROUPED by their state group
  // (backlog / unstarted / started / completed / cancelled), each state row
  // carrying a StateGroupIcon tinted with the state's own color plus a color
  // dot. Selecting a state fires onChange(stateId) — the PARENT owns the
  // task_states list and persistence; this component holds NO client/state refs.
  //
  // Token-only: every class resolves through an app.css token via lib/tasks/ui.ts
  // (inlineRowControl / propertyEditor / propertyEditorEmpty / menuPanel /
  // menuSectionLabel / filterOption / menuItemRowActive / priorityDot). The
  // per-state color is user-editable, so it's passed through to StateGroupIcon
  // and the dot inline-style — never a raw literal baked into a class here.
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
  } from "$lib/components/ui/dropdown-menu/index.js";
  import StateGroupIcon from "$lib/components/tasks/StateGroupIcon.svelte";
  import { STATE_GROUPS, type StateGroupKey } from "$lib/tasks/constants.js";
  import {
    workChipPill,
    propertyEditor,
    propertyEditorEmpty,
    menuPanel,
    menuSectionLabel,
    filterOption,
    menuItemRowActive,
    priorityDot,
  } from "$lib/tasks/ui.js";
  import { cn } from "$lib/utils.js";

  // One selectable task state. `color` is any CSS color value (a stored hex or a
  // var(--token)); `group` keys into STATE_GROUPS for the glyph + section.
  export interface TaskState {
    id: string;
    name: string;
    color: string;
    group: StateGroupKey;
  }

  let {
    value = null,
    options = [],
    disabled = false,
    onChange,
    placeholder = "State",
    variant = "chip",
    showLabel = false,
    class: className,
  }: {
    // The currently-selected state id (or null when unset). Controlled.
    value?: string | null;
    // The project's task_states. Rendered grouped by `group` in STATE_GROUPS order.
    options?: TaskState[];
    disabled?: boolean;
    // Fired with the chosen state id on every selection.
    onChange: (next: string) => void;
    // Trigger hint when no state is selected (row variant).
    placeholder?: string;
    variant?: "chip" | "row";
    // Force the trigger to render the state name alongside the icon even in the
    // `chip` variant — the board card's clean state "pill" (icon + name), matching
    // Plane's block. The `row` variant always shows the name regardless.
    showLabel?: boolean;
    class?: string;
  } = $props();

  const selected = $derived(options.find((s) => s.id === value) ?? null);
  // chip = Plane's BORDERED state pill (workChipPill: h-5, border-[0.5px],
  // rounded-[4px], px-1.5, gap-1.5); row = the full property-row editor.
  const triggerClass = $derived(variant === "row" ? propertyEditor : workChipPill);

  // Bucket the states by group, walking STATE_GROUPS so sections render in the
  // canonical backlog → cancelled order; empty groups are skipped.
  const sections = $derived(
    STATE_GROUPS.map((g) => ({
      group: g,
      states: options.filter((s) => s.group === g.key),
    })).filter((sec) => sec.states.length > 0),
  );
</script>

<DropdownMenu>
  <DropdownMenuTrigger
    {disabled}
    title={selected?.name ?? placeholder}
    aria-label={selected ? `State: ${selected.name}` : placeholder}
    class={cn(triggerClass, "data-[state=open]:bg-hover-gray", className)}
  >
    {#if selected}
      <StateGroupIcon group={selected.group} color={selected.color} size={variant === "row" ? 16 : 14} />
    {:else}
      <StateGroupIcon group="backlog" size={variant === "row" ? 16 : 14} />
    {/if}
    {#if variant === "row" || showLabel}
      <span class={cn("max-w-40 truncate", variant === "chip" && "text-content-dim", !selected && propertyEditorEmpty)}>
        {selected ? selected.name : placeholder}
      </span>
    {/if}
  </DropdownMenuTrigger>
  <DropdownMenuContent align="start" class={cn(menuPanel, "max-h-80 overflow-y-auto p-1")}>
    {#each sections as section (section.group.key)}
      <span class={menuSectionLabel}>{section.group.label}</span>
      {#each section.states as state (state.id)}
        <DropdownMenuItem
          class={cn(filterOption, "cursor-pointer", value === state.id && menuItemRowActive)}
          onSelect={() => onChange(state.id)}
        >
          <StateGroupIcon group={state.group} color={state.color} size={16} />
          <span class={cn(priorityDot)} style={`background:${state.color}`}></span>
          <span class="truncate">{state.name}</span>
        </DropdownMenuItem>
      {/each}
    {/each}
  </DropdownMenuContent>
</DropdownMenu>
