<script lang="ts">
  // WS1 — the mobile Tasks LIST. A grouped vertical scroll list (the phone-native
  // form of the desktop TasksList): sticky group headers (incl. empty groups when
  // grouping by status), two-line rows (TaskRowMobile), and a per-group inline
  // quick-add (TaskQuickAddRow). Tapping a row opens the detail ROUTE via
  // openTaskDetailMobileAware; long-press opens TaskActionSheet for quick field
  // edits (optimistic + revert/toast through useTaskDetail). A slim header bar
  // carries the Display + Filter triggers (the WS0 layout header is shared chrome
  // we cannot reach from here, so the per-layout Display/Filter live with the
  // layout; the sheets themselves are exported for sibling reuse).
  //
  // The rows arrive ALREADY filtered + sorted from the page (created-at order is
  // fixed), so we only GROUP here (grouping preserves the input order within each
  // group). Live cyborg:tasks_changed inserts must not jump the scroll: we keep a
  // SINGLE scroll region with keyed rows and DO NOT disable the browser's native
  // scroll anchoring (no overflow-anchor:none), so a row inserted above the fold
  // keeps the visible content put. Sticky headers are chosen over windowing (one
  // of the two, per the brief).
  import { preferencesState } from "$lib/state/preferences.svelte.js";
  import { openTaskDetailMobileAware } from "$lib/tasks/openDetail.js";
  import {
    groupTasks,
    isDisplayed,
    emptyFilters,
    isOverall,
    activeFilterCount,
    type GroupBy,
    type TaskGroup,
    type TaskFilters,
  } from "$lib/tasks/view.js";
  import { resolveAssignee, type AssigneePools } from "$lib/tasks/assignee.js";
  import { priorityStyle } from "$lib/tasks/priority.js";
  import { priorityDot } from "$lib/tasks/ui.js";
  import StateGroupIcon from "$lib/components/tasks/StateGroupIcon.svelte";
  import AssigneeAvatar from "$lib/components/tasks/AssigneeAvatar.svelte";
  import TaskRowMobile from "./TaskRowMobile.svelte";
  import TaskQuickAddRow from "./TaskQuickAddRow.svelte";
  import TaskActionSheet from "./TaskActionSheet.svelte";
  import TasksDisplaySheet from "./TasksDisplaySheet.svelte";
  import TasksFilterSheet from "./TasksFilterSheet.svelte";
  import SlidersIcon from "@lucide/svelte/icons/sliders-horizontal";
  import FilterIcon from "@lucide/svelte/icons/list-filter";
  import { cn } from "$lib/utils.js";
  import type { Task, TaskState, TaskLabel, Cycle, Module } from "$lib/core/types.js";

  // The per-group quick-add prefill (mirrors the desktop list / board shape).
  type TaskInit = {
    status?: string;
    assigneeId?: string | null;
    priority?: string;
    dueAt?: number | null;
    stateId?: string;
  };

  let {
    workspaceId,
    tasks,
    pools,
    states = [],
    labels = [],
    cycles = [],
    modules = [],
    projectIdentifier = null,
    groupBy = "status",
    oncreate,
    onGroupByChange,
    // ── ADDITIVE (close a WS0 page-contract gap) ──────────────────────────────
    // The masterplan §4.4 says the page exposes `onquickcreate` + `filters`, but
    // the WS0 page only threaded them to the Board, not this List element. Both
    // are OPTIONAL so the component compiles even if the page never passes them:
    //   • onquickcreate absent → the quick-add row escalates to the full create
    //     sheet (oncreate) instead of inline-filing.
    //   • filters unbound → the Filter sheet edits a local (inert) filters object;
    //     bind it from the page for live filtering (the one-line page edit this PR
    //     makes). The page already renders the filtered-empty + Clear-filters state
    //     off this same `filters`.
    onquickcreate,
    filters = $bindable(emptyFilters()),
  }: {
    workspaceId: string;
    tasks: Task[];
    pools: AssigneePools;
    states?: TaskState[];
    labels?: TaskLabel[];
    cycles?: Cycle[];
    modules?: Module[];
    projectIdentifier?: string | null;
    groupBy?: GroupBy;
    oncreate?: (init?: TaskInit) => void;
    onGroupByChange?: (groupBy: GroupBy) => void;
    onquickcreate?: (title: string, init: TaskInit) => Promise<boolean>;
    filters?: TaskFilters;
  } = $props();

  // Group the already-sorted rows. groupByState always yields one group per
  // project state (empty included) so the list shows the full workflow; the
  // assignee/priority groupings drop empty buckets (Plane parity).
  const groups = $derived(
    groupTasks(tasks, groupBy, pools, states, { labels, cycles, modules }),
  );

  // Which chips a row renders (Plane opt-out via preferencesState). The assignee
  // chip is dropped when grouping BY assignee (the header already encodes it),
  // mirroring the desktop list.
  const rowDisplay = $derived({
    taskId: isDisplayed(preferencesState.tasksDisplay, "taskId"),
    status: isDisplayed(preferencesState.tasksDisplay, "status"),
    priority: isDisplayed(preferencesState.tasksDisplay, "priority"),
    dueAt: isDisplayed(preferencesState.tasksDisplay, "dueAt"),
    assignee: isDisplayed(preferencesState.tasksDisplay, "assignee") && groupBy !== "assignee",
  });

  // Per-group quick-add prefill + gate (mirrors TasksList.initialValuesFor /
  // canQuickAdd): only offer quick-add where the group maps to a real seedable
  // value.
  function initialValuesFor(group: TaskGroup): TaskInit {
    if (groupBy === "status") {
      if (group.stateId) return { stateId: group.stateId };
      return group.columnKey ? { status: group.columnKey } : {};
    }
    if (groupBy === "assignee") {
      return group.assigneeId === undefined ? {} : { assigneeId: group.assigneeId };
    }
    return group.priority && group.priority !== "none" ? { priority: group.priority } : {};
  }
  function canQuickAdd(group: TaskGroup): boolean {
    if (groupBy === "status") return group.stateId != null || group.columnKey != null;
    if (groupBy === "assignee") return group.assigneeId !== undefined;
    return group.priority != null && group.priority !== "none";
  }

  // Display / Filter sheets (this layout owns the triggers; the sheets are
  // exported for reuse by Board/Agenda/Timeline in their workstreams).
  let displayOpen = $state(false);
  let filterOpen = $state(false);
  const filterCount = $derived(activeFilterCount(filters));
  const filtered = $derived(!isOverall(filters));

  // Long-press → quick-edit. The target is held while the sheet is open and
  // cleared on close so the underlying useTaskDetail hook unmounts.
  let actionTarget = $state<Task | null>(null);
  let actionOpen = $state(false);
  function openActions(task: Task): void {
    actionTarget = task;
    actionOpen = true;
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-surface">
  <!-- Display / Filter trigger bar -->
  <div class="material-bar hairline-b flex shrink-0 items-center justify-between gap-2 px-3 py-1.5">
    <span class="text-xs tabular-nums text-content-muted">
      {tasks.length} work item{tasks.length === 1 ? "" : "s"}
    </span>
    <div class="flex items-center gap-1">
      <button
        type="button"
        onclick={() => (displayOpen = true)}
        aria-label="Display options"
        title="Display"
        class="grid size-9 place-items-center rounded-[var(--radius-md)] text-content-dim transition-colors hover:bg-hover-gray hover:text-content focus-ring"
      >
        <SlidersIcon class="size-4" />
      </button>
      <button
        type="button"
        onclick={() => (filterOpen = true)}
        aria-label={filterCount > 0 ? `Filters (${filterCount} active)` : "Filters"}
        title="Filters"
        class={cn(
          "relative grid size-9 place-items-center rounded-[var(--radius-md)] transition-colors hover:bg-hover-gray focus-ring",
          filtered ? "text-accent" : "text-content-dim hover:text-content",
        )}
      >
        <FilterIcon class="size-4" />
        {#if filterCount > 0}
          <span class="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-accent" aria-hidden="true"></span>
        {/if}
      </button>
    </div>
  </div>

  <!-- Scroll region (single, keyed, native scroll-anchoring kept on). -->
  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
    {#if tasks.length === 0}
      <div class="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        {#if filtered}
          <p class="text-sm font-medium text-content">No tasks match these filters</p>
          <button
            type="button"
            onclick={() => (filters = emptyFilters())}
            class="text-sm font-medium text-accent"
          >
            Clear filters
          </button>
        {:else}
          <p class="text-sm text-content-muted">No tasks</p>
        {/if}
      </div>
    {:else}
      {#each groups as group (group.key)}
        <section>
          <!-- Sticky group header (opaque so rows scroll cleanly under it). -->
          <header
            class="sticky top-0 z-[1] flex items-center gap-2 bg-surface px-3 py-2 hairline-b"
          >
            {#if groupBy === "assignee"}
              <AssigneeAvatar
                assignee={group.assigneeId == null ? null : resolveAssignee(group.assigneeId, pools)}
                size={18}
              />
            {:else if groupBy === "priority"}
              {@const style = priorityStyle(group.priority ?? "none")}
              <span class={cn(priorityDot, style ? style.dot : "border border-edge-light")}></span>
            {:else if group.statePhase}
              <StateGroupIcon group={group.statePhase} color={group.stateColor} size={16} class="shrink-0" />
            {/if}
            <span class="min-w-0 truncate text-sm font-semibold text-content">{group.label}</span>
            <span class="tabular-nums text-sm font-medium text-content-muted">{group.tasks.length}</span>
          </header>

          {#each group.tasks as task (task.id)}
            <TaskRowMobile
              {task}
              {states}
              {labels}
              {pools}
              {projectIdentifier}
              display={rowDisplay}
              ontap={() => openTaskDetailMobileAware(task.id)}
              onlongpress={() => openActions(task)}
            />
          {/each}

          {#if (onquickcreate || oncreate) && canQuickAdd(group)}
            <TaskQuickAddRow
              groupLabel={group.label}
              canInline={Boolean(onquickcreate)}
              onsubmit={(title) =>
                onquickcreate ? onquickcreate(title, initialValuesFor(group)) : false}
              onexpand={() => oncreate?.(initialValuesFor(group))}
            />
          {/if}
        </section>
      {/each}
    {/if}
  </div>
</div>

<!-- Foundation surfaces (exported, reused by all layouts). -->
<TasksDisplaySheet bind:open={displayOpen} {groupBy} {onGroupByChange} />
<TasksFilterSheet bind:open={filterOpen} bind:filters {pools} {labels} {cycles} {modules} />

{#if actionTarget}
  <TaskActionSheet
    bind:open={actionOpen}
    task={actionTarget}
    {workspaceId}
    {projectIdentifier}
    {states}
    {cycles}
    {modules}
    {pools}
    onclose={() => (actionTarget = null)}
  />
{/if}
