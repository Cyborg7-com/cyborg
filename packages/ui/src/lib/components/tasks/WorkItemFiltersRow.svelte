<script lang="ts">
  // The Work Items FILTER PILL ROW — Plane's rich-filter strip. A wrapping row of
  // applied-filter pills (each a property+value chip with an inline "×" to drop
  // that one value), an "Add filter" (+) dropdown to add a value to any facet, and
  // a "Clear all" link — all on a quiet bg-raised strip under the header.
  //
  // The facets are exactly the ones the PURE view model can honor (view.ts
  // matchesFilters): state group, priority, assignee (+ People/Cybos/Agents kind),
  // label, cycle, module. We do NOT surface a "dates" facet here because the pure
  // TaskFilters model carries no date range — adding a pill the board can't filter
  // on would be inventing behavior. The facet labels (label/cycle/module names)
  // resolve off the project catalog the page passes in; assignee names off pools.
  //
  // `filters` is bound — every pill/menu reassigns it (new object) so the page's
  // derived filteredTasks re-runs. Token-only: dark + light both resolve.
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuCheckboxItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
  } from "$lib/components/ui/dropdown-menu/index.js";
  import AssigneeAvatar from "$lib/components/tasks/AssigneeAvatar.svelte";
  import { resolveAssignee, type AssigneeKind, type AssigneePools } from "$lib/tasks/assignee.js";
  import { PRIORITY_ORDER, priorityStyle, type Priority } from "$lib/tasks/priority.js";
  import { STATE_GROUPS, type StateGroupKey } from "$lib/tasks/constants.js";
  import {
    assigneeOptions,
    emptyFilters,
    isOverall,
    type TaskFilters,
  } from "$lib/tasks/view.js";
  import type { TaskLabel, Cycle, Module } from "$lib/core/types.js";
  import { filterChip, clearAll as clearAllClass, priorityDot, labelChipDot } from "$lib/tasks/ui.js";
  import { cn } from "$lib/utils.js";

  let {
    filters = $bindable(),
    pools,
    labels = [],
    cycles = [],
    modules = [],
  }: {
    filters: TaskFilters;
    pools: AssigneePools;
    // The project catalog the page hydrated (client.fetchProjectLabels / Cycles /
    // Modules). Used to resolve a facet's option list + a pill's display name.
    labels?: TaskLabel[];
    cycles?: Cycle[];
    modules?: Module[];
  } = $props();

  const KIND_FACETS: { key: AssigneeKind; label: string }[] = [
    { key: "user", label: "People" },
    { key: "cybo", label: "Cybos" },
    { key: "agent", label: "Agents" },
  ];

  const assignees = $derived(assigneeOptions(pools));
  const overall = $derived(isOverall(filters));

  // ── facet read/lookup helpers ───────────────────────────────────────────────
  function labelName(id: string): string {
    return labels.find((l) => l.id === id)?.name ?? id.slice(0, 8);
  }
  function labelColor(id: string): string | null {
    return labels.find((l) => l.id === id)?.color ?? null;
  }
  function cycleName(id: string): string {
    return cycles.find((c) => c.id === id)?.name ?? id.slice(0, 8);
  }
  function moduleName(id: string): string {
    return modules.find((m) => m.id === id)?.name ?? id.slice(0, 8);
  }
  function priorityLabel(p: Priority): string {
    return p === "none" ? "No priority" : priorityStyle(p)?.label ?? p;
  }
  function stateGroupLabel(k: StateGroupKey): string {
    return STATE_GROUPS.find((g) => g.key === k)?.label ?? k;
  }
  function kindLabel(k: AssigneeKind): string {
    return KIND_FACETS.find((f) => f.key === k)?.label ?? k;
  }
  function assigneeName(id: string): string {
    return assignees.find((o) => o.id === id)?.name ?? id.slice(0, 8);
  }

  // ── facet mutators (reassign a NEW filters object so binding stays reactive) ──
  function toggle<T>(arr: T[] | undefined, value: T): T[] {
    const a = arr ?? [];
    return a.includes(value) ? a.filter((v) => v !== value) : [...a, value];
  }
  function toggleStateGroup(k: StateGroupKey) {
    filters = { ...filters, stateGroups: toggle(filters.stateGroups, k) };
  }
  function togglePriority(p: Priority) {
    filters = { ...filters, priorities: toggle(filters.priorities, p) };
  }
  function toggleKind(k: AssigneeKind) {
    filters = { ...filters, kinds: toggle(filters.kinds, k) };
  }
  function toggleAssignee(id: string) {
    filters = { ...filters, assigneeIds: toggle(filters.assigneeIds, id) };
  }
  function toggleLabel(id: string) {
    filters = { ...filters, labels: toggle(filters.labels, id) };
  }
  function toggleCycle(id: string) {
    filters = { ...filters, cycles: toggle(filters.cycles, id) };
  }
  function toggleModule(id: string) {
    filters = { ...filters, modules: toggle(filters.modules, id) };
  }
  function toggleRecurring() {
    // Boolean facet: ON keeps only scheduled tasks; toggling OFF clears it
    // (undefined = no constraint), so removing the pill drops the facet entirely.
    filters = { ...filters, recurring: filters.recurring ? undefined : true };
  }

  function clearAll() {
    filters = emptyFilters();
  }
</script>

<div class="flex flex-wrap items-center gap-1.5 border-b border-edge bg-raised px-4 py-2">
  <!-- Add-filter (+) dropdown: a submenu per facet, each a checkbox list. -->
  <DropdownMenu>
    <DropdownMenuTrigger
      class="inline-flex items-center gap-1 rounded-[4px] border border-dashed border-edge-light px-2 py-1 text-[12px] text-content-dim transition-colors hover:bg-hover-gray hover:text-content"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
      </svg>
      Add filter
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" class="w-48">
      <!-- State group -->
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>State</DropdownMenuSubTrigger>
        <DropdownMenuSubContent class="w-44">
          {#each STATE_GROUPS as g (g.key)}
            <DropdownMenuCheckboxItem
              checked={(filters.stateGroups ?? []).includes(g.key)}
              onCheckedChange={() => toggleStateGroup(g.key)}
              closeOnSelect={false}
              class="cursor-pointer"
            >
              {g.label}
            </DropdownMenuCheckboxItem>
          {/each}
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <!-- Priority -->
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>Priority</DropdownMenuSubTrigger>
        <DropdownMenuSubContent class="w-44">
          {#each [...PRIORITY_ORDER, "none"] as p (p)}
            {@const style = priorityStyle(p as Priority)}
            <DropdownMenuCheckboxItem
              checked={filters.priorities.includes(p as Priority)}
              onCheckedChange={() => togglePriority(p as Priority)}
              closeOnSelect={false}
              class="cursor-pointer"
            >
              <span class="flex items-center gap-2">
                <span class={cn(priorityDot, style ? style.dot : "border border-edge-light")}></span>
                {priorityLabel(p as Priority)}
              </span>
            </DropdownMenuCheckboxItem>
          {/each}
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <!-- Assignee (kind + identities) -->
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>Assignee</DropdownMenuSubTrigger>
        <DropdownMenuSubContent class="max-h-[60vh] w-52 overflow-y-auto">
          <DropdownMenuLabel class="text-[11px] font-semibold uppercase tracking-wide text-content-muted">Type</DropdownMenuLabel>
          {#each KIND_FACETS as k (k.key)}
            <DropdownMenuCheckboxItem
              checked={filters.kinds.includes(k.key)}
              onCheckedChange={() => toggleKind(k.key)}
              closeOnSelect={false}
              class="cursor-pointer"
            >
              {k.label}
            </DropdownMenuCheckboxItem>
          {/each}
          {#if assignees.length > 0}
            <DropdownMenuSeparator />
            <DropdownMenuLabel class="text-[11px] font-semibold uppercase tracking-wide text-content-muted">People</DropdownMenuLabel>
            {#each assignees as o (o.id)}
              {@const resolved = resolveAssignee(o.id, pools)}
              <DropdownMenuCheckboxItem
                checked={filters.assigneeIds.includes(o.id)}
                onCheckedChange={() => toggleAssignee(o.id)}
                closeOnSelect={false}
                class="cursor-pointer"
              >
                <span class="flex min-w-0 items-center gap-2">
                  <AssigneeAvatar assignee={resolved} size={18} />
                  <span class="truncate">{o.name}</span>
                </span>
              </DropdownMenuCheckboxItem>
            {/each}
          {/if}
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <!-- Label -->
      {#if labels.length > 0}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Label</DropdownMenuSubTrigger>
          <DropdownMenuSubContent class="max-h-[60vh] w-48 overflow-y-auto">
            {#each labels as l (l.id)}
              <DropdownMenuCheckboxItem
                checked={(filters.labels ?? []).includes(l.id)}
                onCheckedChange={() => toggleLabel(l.id)}
                closeOnSelect={false}
                class="cursor-pointer"
              >
                <span class="flex items-center gap-2">
                  <span class={labelChipDot} style={`background-color:${l.color}`}></span>
                  {l.name}
                </span>
              </DropdownMenuCheckboxItem>
            {/each}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      {/if}

      <!-- Cycle -->
      {#if cycles.length > 0}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Cycle</DropdownMenuSubTrigger>
          <DropdownMenuSubContent class="max-h-[60vh] w-48 overflow-y-auto">
            {#each cycles as c (c.id)}
              <DropdownMenuCheckboxItem
                checked={(filters.cycles ?? []).includes(c.id)}
                onCheckedChange={() => toggleCycle(c.id)}
                closeOnSelect={false}
                class="cursor-pointer"
              >
                {c.name}
              </DropdownMenuCheckboxItem>
            {/each}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      {/if}

      <!-- Module -->
      {#if modules.length > 0}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Module</DropdownMenuSubTrigger>
          <DropdownMenuSubContent class="max-h-[60vh] w-48 overflow-y-auto">
            {#each modules as m (m.id)}
              <DropdownMenuCheckboxItem
                checked={(filters.modules ?? []).includes(m.id)}
                onCheckedChange={() => toggleModule(m.id)}
                closeOnSelect={false}
                class="cursor-pointer"
              >
                {m.name}
              </DropdownMenuCheckboxItem>
            {/each}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      {/if}

      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem
        checked={filters.recurring === true}
        onCheckedChange={() => toggleRecurring()}
        closeOnSelect={false}
        class="cursor-pointer"
      >
        Recurring only
      </DropdownMenuCheckboxItem>
    </DropdownMenuContent>
  </DropdownMenu>

  <!-- Applied pills: one per selected facet value, each droppable via its "×". -->
  {#each filters.stateGroups ?? [] as k (k)}
    <button type="button" onclick={() => toggleStateGroup(k)} class={cn(filterChip, "hover:bg-hover-gray")}>
      <span class="text-content-muted">State:</span> {stateGroupLabel(k)} <span aria-hidden="true">×</span>
    </button>
  {/each}
  {#each filters.priorities as p (p)}
    {@const style = priorityStyle(p)}
    <button type="button" onclick={() => togglePriority(p)} class={cn(filterChip, "hover:bg-hover-gray")}>
      <span class={cn(priorityDot, style ? style.dot : "border border-edge-light")}></span>
      {priorityLabel(p)} <span aria-hidden="true">×</span>
    </button>
  {/each}
  {#each filters.kinds as k (k)}
    <button type="button" onclick={() => toggleKind(k)} class={cn(filterChip, "hover:bg-hover-gray")}>
      {kindLabel(k)} <span aria-hidden="true">×</span>
    </button>
  {/each}
  {#each filters.assigneeIds as id (id)}
    <button type="button" onclick={() => toggleAssignee(id)} class={cn(filterChip, "hover:bg-hover-gray")}>
      {assigneeName(id)} <span aria-hidden="true">×</span>
    </button>
  {/each}
  {#each filters.labels ?? [] as id (id)}
    {@const color = labelColor(id)}
    <button type="button" onclick={() => toggleLabel(id)} class={cn(filterChip, "hover:bg-hover-gray")}>
      {#if color}<span class={labelChipDot} style={`background-color:${color}`}></span>{/if}
      {labelName(id)} <span aria-hidden="true">×</span>
    </button>
  {/each}
  {#each filters.cycles ?? [] as id (id)}
    <button type="button" onclick={() => toggleCycle(id)} class={cn(filterChip, "hover:bg-hover-gray")}>
      <span class="text-content-muted">Cycle:</span> {cycleName(id)} <span aria-hidden="true">×</span>
    </button>
  {/each}
  {#each filters.modules ?? [] as id (id)}
    <button type="button" onclick={() => toggleModule(id)} class={cn(filterChip, "hover:bg-hover-gray")}>
      <span class="text-content-muted">Module:</span> {moduleName(id)} <span aria-hidden="true">×</span>
    </button>
  {/each}
  {#if filters.recurring}
    <button type="button" onclick={() => toggleRecurring()} class={cn(filterChip, "hover:bg-hover-gray")}>
      Recurring <span aria-hidden="true">×</span>
    </button>
  {/if}

  {#if !overall}
    <button type="button" onclick={clearAll} class={cn(clearAllClass, "ml-1")}>Clear all</button>
  {:else}
    <span class="text-[12px] text-content-muted">No filters applied</span>
  {/if}
</div>
