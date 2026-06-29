<script lang="ts">
  // The Tasks tab TOOLBAR, ported to Plane's issues-header look. A segmented
  // LAYOUT switch (Board | List), a DISPLAY dropdown (Group by: Status |
  // Assignee | Priority), and a FILTERS dropdown (Assignee identities + a
  // People/Cybos/Agents KIND facet + Priority + Status). "Overall" = no filters,
  // the default.
  //
  // The Plane visual is composed entirely from the shared foundation
  // (`$lib/tasks/ui.ts`) so dark + light both resolve through app.css semantic
  // tokens — there are ZERO raw color literals here. Only the STATEFUL classes
  // (active segment, applied-filter chips) are added at the call site via cn().
  //
  // Every menu is a shadcn DropdownMenu, which renders its content in a PORTAL at
  // the body root — so the menus never clip behind the board columns / overflow.
  // Tooltips sit under a single page-level TooltipProvider (wrapping the toolbar
  // root) to avoid the "Tooltip context not found" runtime trap. State is owned
  // by the parent and bound here.
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuCheckboxItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
  } from "$lib/components/ui/dropdown-menu/index.js";
  import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
  } from "$lib/components/ui/tooltip/index.js";
  import AssigneeAvatar from "$lib/components/tasks/AssigneeAvatar.svelte";
  import { resolveAssignee, type AssigneeKind, type AssigneePools } from "$lib/tasks/assignee.js";
  import { COLUMNS, type ColumnKey } from "$lib/tasks/board.js";
  import { PRIORITY_ORDER, priorityStyle, type Priority } from "$lib/tasks/priority.js";
  import { priorityDot } from "$lib/tasks/ui.js";
  import {
    controlBtn,
    filterChip,
    segmentBtn,
    segmentBtnActive,
    segmentTrack,
    menuSectionLabel,
    orderDirToggle,
    clearAll as clearAllClass,
  } from "$lib/tasks/ui.js";
  import {
    activeFilterCount,
    assigneeOptions,
    emptyFilters,
    isOverall,
    DISPLAY_OPTIONS,
    type DisplayKey,
    type GroupBy,
    type Layout,
    type OrderBy,
    type TaskFilters,
  } from "$lib/tasks/view.js";
  import { preferencesState } from "$lib/state/preferences.svelte.js";
  import { cn } from "$lib/utils.js";

  let {
    layout = $bindable(),
    groupBy = $bindable(),
    filters = $bindable(),
    pools,
  }: {
    layout: Layout;
    groupBy: GroupBy;
    filters: TaskFilters;
    pools: AssigneePools;
  } = $props();

  // Plane's layout-selection is a tray of icon buttons. Each layout carries its
  // glyph path data so the segmented control renders a real icon (Board grid /
  // List rows), not a text label.
  const LAYOUTS: {
    key: Layout;
    label: string;
    icon: "board" | "list" | "calendar" | "spreadsheet" | "gantt";
  }[] = [
    { key: "board", label: "Board", icon: "board" },
    { key: "list", label: "List", icon: "list" },
    { key: "calendar", label: "Calendar", icon: "calendar" },
    { key: "spreadsheet", label: "Spreadsheet", icon: "spreadsheet" },
    { key: "gantt", label: "Gantt", icon: "gantt" },
  ];

  const GROUP_OPTIONS: { key: GroupBy; label: string }[] = [
    { key: "status", label: "Status" },
    { key: "assignee", label: "Assignee" },
    { key: "priority", label: "Priority" },
  ];

  // Plane's "Ordering" list inside the Display popover. Each value maps to a real
  // Task field (or derived priority) — see view.ts OrderBy. The asc/desc toggle
  // sits beside the section heading, mirroring Plane's direction switch.
  const ORDER_OPTIONS: { key: OrderBy; label: string }[] = [
    { key: "createdAt", label: "Created" },
    { key: "updatedAt", label: "Last updated" },
    { key: "dueAt", label: "Due date" },
    { key: "priority", label: "Priority" },
    { key: "title", label: "Title" },
  ];

  // Tasks view prefs live on the persisted singleton (device-global, like the
  // theme): the Ordering field/direction and the Display-property toggle set. We
  // read them reactively here and write through the setters so the choice
  // survives reload and the board/list re-sort + re-render the moment it changes.
  const orderBy = $derived(preferencesState.tasksOrderBy);
  const orderDir = $derived(preferencesState.tasksOrderDir);
  const display = $derived(preferencesState.tasksDisplay);

  const KIND_FACETS: { key: AssigneeKind; label: string }[] = [
    { key: "user", label: "People" },
    { key: "cybo", label: "Cybos" },
    { key: "agent", label: "Agents" },
  ];

  const options = $derived(assigneeOptions(pools));
  const filterCount = $derived(activeFilterCount(filters));
  const overall = $derived(isOverall(filters));

  // Toggle a value within a filter facet array (multi-select), reassigning so the
  // bound state stays reactive.
  function toggle<T>(arr: T[], value: T): T[] {
    return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
  }

  function clearAll(): void {
    filters = emptyFilters();
  }

  // Map a chip back to its removal so the active-filter row can clear one facet
  // value at a time.
  function removeAssignee(id: string) {
    filters = { ...filters, assigneeIds: filters.assigneeIds.filter((v) => v !== id) };
  }
  function removeKind(k: AssigneeKind) {
    filters = { ...filters, kinds: filters.kinds.filter((v) => v !== k) };
  }
  function removePriority(p: Priority) {
    filters = { ...filters, priorities: filters.priorities.filter((v) => v !== p) };
  }
  function removeStatus(s: ColumnKey) {
    filters = { ...filters, statuses: filters.statuses.filter((v) => v !== s) };
  }

  function priorityLabel(p: Priority): string {
    return p === "none" ? "No priority" : priorityStyle(p)?.label ?? p;
  }
  function statusLabel(s: ColumnKey): string {
    return COLUMNS.find((c) => c.key === s)?.label ?? s;
  }
  function kindLabel(k: AssigneeKind): string {
    return KIND_FACETS.find((f) => f.key === k)?.label ?? k;
  }
  function assigneeName(id: string): string {
    return options.find((o) => o.id === id)?.name ?? id;
  }
</script>

<TooltipProvider delayDuration={150}>
  <div class="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-2">
    <!-- LAYOUT: Plane segmented control — a bg-deeper tray of icon buttons -->
    <div class={segmentTrack}>
      {#each LAYOUTS as l (l.key)}
        <Tooltip>
          <TooltipTrigger
            onclick={() => (layout = l.key)}
            class={cn(segmentBtn, layout === l.key && segmentBtnActive)}
            aria-label={l.label}
            aria-pressed={layout === l.key}
          >
            {#if l.icon === "board"}
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="7" height="18" rx="1" /><rect x="14" y="3" width="7" height="11" rx="1" />
              </svg>
            {:else if l.icon === "list"}
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
            {:else if l.icon === "calendar"}
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="3" y1="10" x2="21" y2="10" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="16" y1="2" x2="16" y2="6" />
              </svg>
            {:else if l.icon === "spreadsheet"}
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" /><line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            {:else}
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="8" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="14" y2="12" /><line x1="10" y1="18" x2="18" y2="18" />
              </svg>
            {/if}
          </TooltipTrigger>
          <TooltipContent>{l.label}</TooltipContent>
        </Tooltip>
      {/each}
    </div>

    <!-- DISPLAY: group-by radio menu (portal'd) -->
    <DropdownMenu>
      <DropdownMenuTrigger class={controlBtn}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="14" y2="12" /><line x1="4" y1="18" x2="9" y2="18" />
        </svg>
        Display
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-56">
        <DropdownMenuLabel class={menuSectionLabel}>Group by</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={groupBy} onValueChange={(v) => (groupBy = v as GroupBy)}>
          {#each GROUP_OPTIONS as g (g.key)}
            <DropdownMenuRadioItem value={g.key} class="cursor-pointer">{g.label}</DropdownMenuRadioItem>
          {/each}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        <!-- ORDERING: pick the sort field (radio) + an asc/desc toggle. Writes
             preferences.tasksOrderBy / tasksOrderDir; the page re-sorts reactively. -->
        <div class="flex items-center justify-between pr-1.5">
          <DropdownMenuLabel class={menuSectionLabel}>Ordering</DropdownMenuLabel>
          <button
            type="button"
            onclick={() => preferencesState.toggleTasksOrderDir()}
            class={orderDirToggle}
            aria-label={orderDir === "asc" ? "Sort ascending" : "Sort descending"}
            title={orderDir === "asc" ? "Ascending" : "Descending"}
          >
            {#if orderDir === "asc"}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
              </svg>
              Asc
            {:else}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" /><polyline points="19 12 12 19 5 12" />
              </svg>
              Desc
            {/if}
          </button>
        </div>
        <DropdownMenuRadioGroup
          value={orderBy}
          onValueChange={(v) => preferencesState.setTasksOrderBy(v as OrderBy)}
        >
          {#each ORDER_OPTIONS as o (o.key)}
            <DropdownMenuRadioItem value={o.key} class="cursor-pointer">{o.label}</DropdownMenuRadioItem>
          {/each}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        <!-- DISPLAY PROPERTIES: which property chips show on cards / list rows.
             All-on by default (Plane opt-out). Writes preferences.tasksDisplay. -->
        <DropdownMenuLabel class={menuSectionLabel}>Display properties</DropdownMenuLabel>
        {#each DISPLAY_OPTIONS as d (d.key)}
          <DropdownMenuCheckboxItem
            checked={display[d.key]}
            onCheckedChange={() => preferencesState.toggleTasksDisplay(d.key as DisplayKey)}
            closeOnSelect={false}
            class="cursor-pointer"
          >
            {d.label}
          </DropdownMenuCheckboxItem>
        {/each}
      </DropdownMenuContent>
    </DropdownMenu>

    <!-- FILTERS: multi-select facets (portal'd) -->
    <DropdownMenu>
      <DropdownMenuTrigger
        class={cn(controlBtn, !overall && "border-accent text-accent hover:text-accent")}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </svg>
        Filters
        {#if filterCount > 0}
          <span class="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-[color:var(--brand-contrast)] tabular-nums">
            {filterCount}
          </span>
        {/if}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="max-h-[70vh] w-64 overflow-y-auto">
        <!-- KIND facet: People / Cybos / Agents — the per-user vs per-agent answer -->
        <DropdownMenuLabel class="text-[11px] font-semibold uppercase tracking-wide text-content-muted">
          Type
        </DropdownMenuLabel>
        {#each KIND_FACETS as k (k.key)}
          <DropdownMenuCheckboxItem
            checked={filters.kinds.includes(k.key)}
            onCheckedChange={() => (filters = { ...filters, kinds: toggle(filters.kinds, k.key) })}
            closeOnSelect={false}
            class="cursor-pointer"
          >
            {k.label}
          </DropdownMenuCheckboxItem>
        {/each}

        {#if options.length > 0}
          <DropdownMenuSeparator />
          <DropdownMenuLabel class="text-[11px] font-semibold uppercase tracking-wide text-content-muted">
            Assignee
          </DropdownMenuLabel>
          {#each options as o (o.id)}
            {@const resolved = resolveAssignee(o.id, pools)}
            <DropdownMenuCheckboxItem
              checked={filters.assigneeIds.includes(o.id)}
              onCheckedChange={() => (filters = { ...filters, assigneeIds: toggle(filters.assigneeIds, o.id) })}
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

        <DropdownMenuSeparator />
        <DropdownMenuLabel class="text-[11px] font-semibold uppercase tracking-wide text-content-muted">
          Priority
        </DropdownMenuLabel>
        {#each [...PRIORITY_ORDER, "none"] as p (p)}
          {@const style = priorityStyle(p as Priority)}
          <DropdownMenuCheckboxItem
            checked={filters.priorities.includes(p as Priority)}
            onCheckedChange={() => (filters = { ...filters, priorities: toggle(filters.priorities, p as Priority) })}
            closeOnSelect={false}
            class="cursor-pointer"
          >
            <span class="flex items-center gap-2">
              <span class={cn(priorityDot, style ? style.dot : "border border-edge-light")}></span>
              {priorityLabel(p as Priority)}
            </span>
          </DropdownMenuCheckboxItem>
        {/each}

        <DropdownMenuSeparator />
        <DropdownMenuLabel class="text-[11px] font-semibold uppercase tracking-wide text-content-muted">
          Status
        </DropdownMenuLabel>
        {#each COLUMNS as c (c.key)}
          <DropdownMenuCheckboxItem
            checked={filters.statuses.includes(c.key)}
            onCheckedChange={() => (filters = { ...filters, statuses: toggle(filters.statuses, c.key) })}
            closeOnSelect={false}
            class="cursor-pointer"
          >
            {c.label}
          </DropdownMenuCheckboxItem>
        {/each}

        {#if !overall}
          <DropdownMenuSeparator />
          <button
            type="button"
            onclick={clearAll}
            class="w-full rounded-md px-2 py-1.5 text-left text-[12px] font-medium text-content-muted transition-colors hover:bg-hover-gray hover:text-content"
          >
            Clear all filters
          </button>
        {/if}
      </DropdownMenuContent>
    </DropdownMenu>

    {#if overall}
      <Tooltip>
        <TooltipTrigger class="ml-1 text-[12px] text-content-muted">Overall</TooltipTrigger>
        <TooltipContent>Showing all tasks — no filters applied</TooltipContent>
      </Tooltip>
    {/if}

    <!-- Active-filter chips with per-chip remove + clear-all -->
    {#if !overall}
      <div class="flex flex-wrap items-center gap-1.5">
        {#each filters.kinds as k (k)}
          <button type="button" onclick={() => removeKind(k)} class={cn(filterChip, "hover:bg-hover-gray")}>
            {kindLabel(k)} <span aria-hidden="true">×</span>
          </button>
        {/each}
        {#each filters.assigneeIds as id (id)}
          <button type="button" onclick={() => removeAssignee(id)} class={cn(filterChip, "hover:bg-hover-gray")}>
            {assigneeName(id)} <span aria-hidden="true">×</span>
          </button>
        {/each}
        {#each filters.priorities as p (p)}
          <button type="button" onclick={() => removePriority(p)} class={cn(filterChip, "hover:bg-hover-gray")}>
            {priorityLabel(p)} <span aria-hidden="true">×</span>
          </button>
        {/each}
        {#each filters.statuses as s (s)}
          <button type="button" onclick={() => removeStatus(s)} class={cn(filterChip, "hover:bg-hover-gray")}>
            {statusLabel(s)} <span aria-hidden="true">×</span>
          </button>
        {/each}
        <button type="button" onclick={clearAll} class={clearAllClass}>Clear all</button>
      </div>
    {/if}
  </div>
</TooltipProvider>
