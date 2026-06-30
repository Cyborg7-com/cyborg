<script lang="ts">
  // WS1 — the mobile "Filters" sheet (the phone form of the WorkItemFiltersRow
  // pill strip). The facets are EXACTLY the ones the pure view-model can honor
  // (view.ts matchesFilters), mirroring the web filter row 1:1: state group,
  // priority, assignee KIND (People/Cybos/Agents) + assignee identities, label,
  // cycle, module. There is intentionally NO "due/date" facet — the TaskFilters
  // model carries no date range, and the web filter row omits it for the same
  // reason; adding one would invent behavior the data layer can't filter on.
  //
  // `filters` is bound — every toggle reassigns a NEW filters object so the page's
  // derived filteredTasks re-runs live. Token-only; the facet lists are plain
  // checkbox rows inside this MobileSheet (no portal'd dropdown). Exported as a
  // foundation surface reusable by every Work-Items layout.
  import MobileSheet from "$lib/components/MobileSheet.svelte";
  import StateGroupIcon from "$lib/components/tasks/StateGroupIcon.svelte";
  import AssigneeAvatar from "$lib/components/tasks/AssigneeAvatar.svelte";
  import { resolveAssignee, type AssigneeKind, type AssigneePools } from "$lib/tasks/assignee.js";
  import { PRIORITY_ORDER, priorityStyle, type Priority } from "$lib/tasks/priority.js";
  import { STATE_GROUPS, type StateGroupKey } from "$lib/tasks/constants.js";
  import {
    assigneeOptions,
    activeFilterCount,
    emptyFilters,
    isOverall,
    type TaskFilters,
  } from "$lib/tasks/view.js";
  import type { TaskLabel, Cycle, Module } from "$lib/core/types.js";
  import { priorityDot, labelChipDot } from "$lib/tasks/ui.js";
  import CheckIcon from "@lucide/svelte/icons/check";
  import { cn } from "$lib/utils.js";

  let {
    open = $bindable(false),
    filters = $bindable(emptyFilters()),
    pools,
    labels = [],
    cycles = [],
    modules = [],
    onclose,
  }: {
    open?: boolean;
    filters: TaskFilters;
    pools: AssigneePools;
    labels?: TaskLabel[];
    cycles?: Cycle[];
    modules?: Module[];
    onclose?: () => void;
  } = $props();

  const KIND_FACETS: { key: AssigneeKind; label: string }[] = [
    { key: "user", label: "People" },
    { key: "cybo", label: "Cybos" },
    { key: "agent", label: "Agents" },
  ];

  const assignees = $derived(assigneeOptions(pools));
  const overall = $derived(isOverall(filters));
  const count = $derived(activeFilterCount(filters));

  // Toggle a value within a facet array, reassigning a NEW filters object so the
  // bound state stays reactive (matches WorkItemFiltersRow).
  function toggle<T>(arr: T[] | undefined, value: T): T[] {
    const a = arr ?? [];
    return a.includes(value) ? a.filter((v) => v !== value) : [...a, value];
  }
  function toggleStateGroup(k: StateGroupKey): void {
    filters = { ...filters, stateGroups: toggle(filters.stateGroups, k) };
  }
  function togglePriority(p: Priority): void {
    filters = { ...filters, priorities: toggle(filters.priorities, p) };
  }
  function toggleKind(k: AssigneeKind): void {
    filters = { ...filters, kinds: toggle(filters.kinds, k) };
  }
  function toggleAssignee(id: string): void {
    filters = { ...filters, assigneeIds: toggle(filters.assigneeIds, id) };
  }
  function toggleLabel(id: string): void {
    filters = { ...filters, labels: toggle(filters.labels, id) };
  }
  function toggleCycle(id: string): void {
    filters = { ...filters, cycles: toggle(filters.cycles, id) };
  }
  function toggleModule(id: string): void {
    filters = { ...filters, modules: toggle(filters.modules, id) };
  }
  function clearAll(): void {
    filters = emptyFilters();
  }

  const allPriorities: Priority[] = [...PRIORITY_ORDER, "none"];
</script>

{#snippet facetRow(label: string, checked: boolean, onToggle: () => void, leading?: import("svelte").Snippet)}
  <button
    type="button"
    onclick={onToggle}
    aria-pressed={checked}
    class="touch-target-row pressable-row flex w-full items-center gap-3 rounded-[var(--radius-md)] px-2 py-2.5 text-left"
  >
    <span
      class={cn(
        "grid size-5 shrink-0 place-items-center rounded-[var(--radius-sm)] border",
        checked ? "border-accent bg-accent text-accent-foreground" : "border-edge-light",
      )}
      aria-hidden="true"
    >
      {#if checked}<CheckIcon class="size-3.5" />{/if}
    </span>
    {#if leading}{@render leading()}{/if}
    <span class="min-w-0 flex-1 truncate text-sm text-content">{label}</span>
  </button>
{/snippet}

{#snippet sectionLabel(text: string)}
  <span class="px-1 pt-3 text-xs font-medium uppercase tracking-wide text-content-muted">{text}</span>
{/snippet}

<MobileSheet bind:open {onclose} ariaLabel="Filter work items">
  {#snippet header()}
    <div class="flex items-center justify-between px-4 pb-2">
      <span class="text-base font-semibold text-content">
        Filters{#if count > 0}<span class="ml-1.5 text-sm font-normal text-content-muted">{count}</span>{/if}
      </span>
      {#if !overall}
        <button type="button" onclick={clearAll} class="text-sm font-medium text-accent">Clear all</button>
      {/if}
    </div>
  {/snippet}

  <div class="flex flex-col pb-2">
    <!-- STATE GROUP -->
    {@render sectionLabel("State")}
    {#each STATE_GROUPS as g (g.key)}
      {@const checked = (filters.stateGroups ?? []).includes(g.key)}
      {#snippet stateGlyph()}
        <StateGroupIcon group={g.key} size={16} />
      {/snippet}
      {@render facetRow(g.label, checked, () => toggleStateGroup(g.key), stateGlyph)}
    {/each}

    <!-- PRIORITY -->
    {@render sectionLabel("Priority")}
    {#each allPriorities as p (p)}
      {@const style = priorityStyle(p)}
      {@const checked = filters.priorities.includes(p)}
      {#snippet priorityGlyph()}
        <span class={cn(priorityDot, style ? style.dot : "border border-edge-light")}></span>
      {/snippet}
      {@render facetRow(p === "none" ? "No priority" : (style?.label ?? p), checked, () => togglePriority(p), priorityGlyph)}
    {/each}

    <!-- ASSIGNEE TYPE -->
    {@render sectionLabel("Type")}
    {#each KIND_FACETS as k (k.key)}
      {@render facetRow(k.label, filters.kinds.includes(k.key), () => toggleKind(k.key))}
    {/each}

    <!-- ASSIGNEE -->
    {#if assignees.length > 0}
      {@render sectionLabel("Assignee")}
      {#each assignees as o (o.id)}
        {@const checked = filters.assigneeIds.includes(o.id)}
        {#snippet avatarGlyph()}
          <AssigneeAvatar assignee={resolveAssignee(o.id, pools)} size={18} />
        {/snippet}
        {@render facetRow(o.name, checked, () => toggleAssignee(o.id), avatarGlyph)}
      {/each}
    {/if}

    <!-- LABEL -->
    {#if labels.length > 0}
      {@render sectionLabel("Label")}
      {#each labels as l (l.id)}
        {@const checked = (filters.labels ?? []).includes(l.id)}
        {#snippet labelGlyph()}
          <span class={labelChipDot} style={`background-color:${l.color}`}></span>
        {/snippet}
        {@render facetRow(l.name, checked, () => toggleLabel(l.id), labelGlyph)}
      {/each}
    {/if}

    <!-- CYCLE -->
    {#if cycles.length > 0}
      {@render sectionLabel("Cycle")}
      {#each cycles as c (c.id)}
        {@render facetRow(c.name, (filters.cycles ?? []).includes(c.id), () => toggleCycle(c.id))}
      {/each}
    {/if}

    <!-- MODULE -->
    {#if modules.length > 0}
      {@render sectionLabel("Module")}
      {#each modules as m (m.id)}
        {@render facetRow(m.name, (filters.modules ?? []).includes(m.id), () => toggleModule(m.id))}
      {/each}
    {/if}
  </div>
</MobileSheet>
