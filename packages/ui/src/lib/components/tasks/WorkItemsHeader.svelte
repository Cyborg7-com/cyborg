<script lang="ts">
  // The Work Items HEADER — the Plane issues-header, evolved from TasksToolbar.
  // It composes, left-to-right:
  //   - a LayoutSelection segmented switch (board | list | calendar | spreadsheet
  //     | gantt), each an icon button in a bg-deeper tray;
  //   - a DISPLAY popover: Group by (the full GroupBy set — state/priority/
  //     assignee/project/label/cycle/module), Ordering (field + asc/desc), and the
  //     Display-properties toggle chips;
  //   - a FILTERS toggle button (shows/hides the WorkItemFiltersRow pill strip)
  //     carrying the active-filter count badge;
  //   - a trailing "New work item" primary button + a work-item COUNT chip.
  //
  // Every visual is composed from the shared Tasks foundation ($lib/tasks/ui.ts +
  // constants.ts), so dark + light both resolve through app.css tokens — ZERO raw
  // color literals. The DISPLAY menu is a portal'd shadcn DropdownMenu so it never
  // clips behind the board. State (layout / groupBy / filtersOpen) is owned by the
  // page and bound here; Ordering + Display read/write the device-global
  // preferences singleton (survives reload), exactly like the old toolbar.
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
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
  import {
    controlBtn,
    segmentBtn,
    segmentBtnActive,
    segmentTrack,
    menuSectionLabel,
    orderDirToggle,
  } from "$lib/tasks/ui.js";
  import {
    GROUP_BY_OPTIONS,
    ORDER_BY_OPTIONS,
    DISPLAY_PROPERTY_OPTIONS,
  } from "$lib/tasks/constants.js";
  import {
    activeFilterCount,
    isOverall,
    type DisplayKey,
    type GroupBy,
    type Layout,
    type OrderBy,
    type TaskFilters,
  } from "$lib/tasks/view.js";
  import { preferencesState } from "$lib/state/preferences.svelte.js";
  import { page } from "$app/state";
  import { workspaceState, projectsCache } from "$lib/state/app.svelte.js";
  import { cn } from "$lib/utils.js";

  let {
    layout = $bindable(),
    groupBy = $bindable(),
    filters,
    filtersOpen = $bindable(),
    count,
    workspaceName,
    projectName,
    onnew,
    onanalytics,
  }: {
    layout: Layout;
    groupBy: GroupBy;
    // Read-only here — the count badge + Filters-active state come off it; the
    // actual editing lives in WorkItemFiltersRow. Not bindable (the header only
    // toggles the row's visibility, never mutates the filter set).
    filters: TaskFilters;
    // Whether the filters pill row is currently shown (the page renders the row).
    filtersOpen: boolean;
    // Number of work items currently shown (after filtering) — the count pill.
    count: number;
    // Breadcrumb context (Plane's LEFT region): workspace › project › Work Items.
    // Each is optional; a missing segment is simply omitted from the trail.
    workspaceName?: string;
    projectName?: string;
    // Open the create-work-item dialog (the header "New work item" button).
    onnew: () => void;
    // Open the Analytics view (Plane's secondary header button). Optional — when
    // omitted the Analytics button renders as a no-op stub.
    onanalytics?: () => void;
  } = $props();

  // Plane's layout-selection tray. Each layout carries an icon key the segmented
  // control renders as a real glyph (not a text label).
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

  // Ordering + Display-properties read reactively off the persisted singleton.
  const orderBy = $derived(preferencesState.tasksOrderBy);
  const orderDir = $derived(preferencesState.tasksOrderDir);
  const display = $derived(preferencesState.tasksDisplay);

  const filterCount = $derived(activeFilterCount(filters));
  const overall = $derived(isOverall(filters));

  // Breadcrumb trail (Plane's LEFT region). The names default to live app state so
  // the header is self-sufficient on the project work-items route, but either can
  // be overridden via props. A missing segment is omitted from the trail.
  const wsName = $derived(workspaceName ?? workspaceState.current?.name);
  const projName = $derived(
    projectName ??
      projectsCache
        .get(page.params.id ?? "")
        ?.projects.find((p) => p.id === page.params.projectId)?.name,
  );
</script>

<TooltipProvider delayDuration={150}>
  <!-- Plane's issues-header is ONE row: a LEFT region that grows (the work-item
       count) and a RIGHT, justify-end control cluster. Every control lives in the
       right cluster, in Plane's exact order: [layout tray] -> [Filters] ->
       [Display] -> [Add work item LAST]. No hard border line — separation is the
       one-layer-deeper canvas, matching Plane's board surface. -->
  <div class="flex flex-wrap items-center gap-2 px-4 py-2">
    <!-- LEFT region (grows): Plane's breadcrumb trail — workspace › project ›
         "Work Items" (the last segment carries the work-items glyph) — followed by
         a small ACCENT COUNT PILL, shown only when count>0 (Plane's CountChip:
         rounded-xl, accent bg at ~20% + accent text). The pill is no longer styled
         like a per-column count, so it never reads as an orphan column header. -->
    <div class="flex min-w-0 flex-grow items-center gap-2.5">
      <nav class="flex min-w-0 items-center gap-1 text-[13px] text-content-dim" aria-label="Breadcrumb">
        {#if wsName}
          <span class="truncate">{wsName}</span>
          <span class="text-content-dim/60" aria-hidden="true">›</span>
        {/if}
        {#if projName}
          <span class="truncate">{projName}</span>
          <span class="text-content-dim/60" aria-hidden="true">›</span>
        {/if}
        <span class="flex shrink-0 items-center gap-1.5 font-medium text-content">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          Work Items
        </span>
      </nav>
      {#if count > 0}
        <span
          class="flex shrink-0 items-center justify-center rounded-xl bg-accent/20 px-2.5 py-0.5 text-[11px] font-semibold text-accent tabular-nums"
        >
          {count}
        </span>
      {/if}
    </div>

    <!-- RIGHT cluster: right-aligned controls in Plane's order. -->
    <div class="flex w-auto items-center justify-end gap-2">
      <!-- LAYOUT: segmented control — a bg-deeper tray of icon buttons. -->
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

      <!-- FILTERS toggle: ICON-ONLY (Plane's filter toggle). Active = accent. -->
      <Tooltip>
        <TooltipTrigger
          onclick={() => (filtersOpen = !filtersOpen)}
          aria-pressed={filtersOpen}
          aria-label="Filters"
          class={cn(
            controlBtn,
            "relative",
            (filtersOpen || !overall) && "border-accent text-accent hover:text-accent",
          )}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
          </svg>
          {#if filterCount > 0}
            <!-- Applied-filters indicator: a small accent DOT (Plane), not a count. -->
            <span class="absolute right-1 top-1 size-1.5 rounded-full bg-accent" aria-hidden="true"></span>
          {/if}
        </TooltipTrigger>
        <TooltipContent>Filters</TooltipContent>
      </Tooltip>

      <!-- DISPLAY: Group by + Ordering + Display-properties (portal'd). ICON-ONLY. -->
      <DropdownMenu>
        <DropdownMenuTrigger class={controlBtn} aria-label="Display" title="Display">
        <!-- Display trigger: Plane's SlidersHorizontal glyph. -->
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="21" y1="4" x2="14" y2="4" /><line x1="10" y1="4" x2="3" y2="4" /><line x1="21" y1="12" x2="12" y2="12" /><line x1="8" y1="12" x2="3" y2="12" /><line x1="21" y1="20" x2="16" y2="20" /><line x1="12" y1="20" x2="3" y2="20" /><line x1="14" y1="2" x2="14" y2="6" /><line x1="8" y1="10" x2="8" y2="14" /><line x1="16" y1="18" x2="16" y2="22" />
        </svg>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="max-h-[70vh] w-56 overflow-y-auto">
        <DropdownMenuLabel class={menuSectionLabel}>Group by</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={groupBy} onValueChange={(v) => (groupBy = v as GroupBy)}>
          {#each GROUP_BY_OPTIONS as g (g.value)}
            <DropdownMenuRadioItem value={g.value} class="cursor-pointer">{g.label}</DropdownMenuRadioItem>
          {/each}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

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
          {#each ORDER_BY_OPTIONS as o (o.value)}
            <DropdownMenuRadioItem value={o.value} class="cursor-pointer">{o.label}</DropdownMenuRadioItem>
          {/each}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        <DropdownMenuLabel class={menuSectionLabel}>Display properties</DropdownMenuLabel>
        {#each DISPLAY_PROPERTY_OPTIONS as d (d.value)}
          <DropdownMenuCheckboxItem
            checked={display[d.value]}
            onCheckedChange={() => preferencesState.toggleTasksDisplay(d.value as DisplayKey)}
            closeOnSelect={false}
            class="cursor-pointer"
          >
            {d.label}
          </DropdownMenuCheckboxItem>
        {/each}
        </DropdownMenuContent>
      </DropdownMenu>

      <!-- OVERFLOW: secondary actions (Analytics, …) tucked behind a ⋯ menu so the
           toolbar stays light. Future secondary actions live here too. -->
      <DropdownMenu>
        <DropdownMenuTrigger class={controlBtn} aria-label="More" title="More">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" />
          </svg>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-44">
          <DropdownMenuItem class="cursor-pointer gap-2" onclick={() => onanalytics?.()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="3" y1="21" x2="21" y2="21" /><rect x="5" y="11" width="3" height="7" rx="0.5" /><rect x="10.5" y="7" width="3" height="11" rx="0.5" /><rect x="16" y="13" width="3" height="5" rx="0.5" />
            </svg>
            Analytics
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <!-- ADD WORK ITEM: the primary button, LAST/rightmost (Plane's order). -->
      <button
        type="button"
        onclick={onnew}
        class="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium text-[color:var(--brand-contrast)] transition-colors hover:bg-accent-hover"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        Add work item
      </button>
    </div>
  </div>
</TooltipProvider>
