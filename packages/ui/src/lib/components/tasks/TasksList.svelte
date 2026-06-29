<script lang="ts">
  // The Tasks LIST layout, ported to Plane's list/block.tsx (IssueBlock) shape via
  // the shared Tasks foundation (lib/tasks/ui.ts). A list ROW is a SINGLE LINE that
  // mirrors Plane's block exactly:
  //   LEFT cluster  the issue KEY (display-gated) + the title (grows, truncates)
  //   RIGHT cluster the ONE shared WorkItemProperties strip (editable, the same
  //                 component the board card + detail use, in Plane's property
  //                 order: state · priority · dates · assignee · counts) followed
  //                 by the hover-revealed "…" quick-actions menu.
  // Row geometry matches Plane's list block: `min-h-11` (h-11), `gap-2` between the
  // left/right clusters, a bottom hairline, hover tint, peeked → selected tint.
  //
  // Plane-faithful behavior:
  //   - clicking a row opens the SIDE-PEEK (openTaskDetail), not a full-page nav, so
  //     editing stays in context;
  //   - every property is editable INLINE in the row through WorkItemProperties'
  //     editor chips (StateDropdown / PriorityDropdown / DateRangeDropdown /
  //     AssigneeDropdown / Label / Cycle / Module), persisting through
  //     client.updateTask with an optimistic patch of workspaceState.tasks (revert +
  //     toast on failure); the data-driven state editor needs the project's states;
  //   - each group header has a collapse toggle (local state) that folds its rows;
  //   - which properties render is driven by the user's Display preferences
  //     (preferencesState.tasksDisplay), mapped onto WorkItemProperties' DisplayMap;
  //   - rows are ordered by the user's Ordering preference (sortTasks) within each
  //     group, matching Plane's list ordering.
  import { toast } from "svelte-sonner";
  import { client } from "$lib/state/client.js";
  import { workspaceState } from "$lib/state/app.svelte.js";
  import { preferencesState } from "$lib/state/preferences.svelte.js";
  import { openTaskDetail, taskDetail } from "$lib/tasks/detailStore.svelte.js";
  import AssigneeAvatar from "$lib/components/tasks/AssigneeAvatar.svelte";
  import WorkItemProperties from "$lib/components/tasks/WorkItemProperties.svelte";
  import DeleteTaskDialog from "$lib/components/tasks/DeleteTaskDialog.svelte";
  import StateGroupIcon from "$lib/components/tasks/StateGroupIcon.svelte";
  import type { DateRange } from "$lib/components/tasks/DateRangeDropdown.svelte";
  import { resolveAssignee, type AssigneePools } from "$lib/tasks/assignee.js";
  import { type ColumnKey } from "$lib/tasks/board.js";
  import {
    priorityForTask,
    priorityStyle,
    type Priority,
  } from "$lib/tasks/priority.js";
  import {
    groupTasks,
    isDisplayed,
    sortTasks,
    type GroupBy,
    type StateLite,
    type TaskGroup,
  } from "$lib/tasks/view.js";
  import { taskKey } from "$lib/tasks/detail.js";
  import type { Task, TaskLabel, Cycle, Module } from "$lib/core/types.js";
  import { cn } from "$lib/utils.js";
  import {
    listGroupHeader,
    listGroupAdd,
    listRow,
    listRowWrap,
    listRowBorder,
    listRowTop,
    listRowLeft,
    listRowLead,
    listRowSelect,
    listRowTitle,
    listRowProps,
    listRowPropsStrip,
    listRowSelected,
    listRowPeeked,
    listRowId,
    checkBoxBase,
    priorityDot,
  } from "$lib/tasks/ui.js";
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
  } from "$lib/components/ui/dropdown-menu/index.js";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";

  // The Plane create-issue modal's prefill shape, shared with the board's
  // per-column quick-add: a group's "New work item" row passes its group value
  // here so a task created from the group lands in it (status / assigneeId /
  // priority / stateId). dueAt is never derivable from a group, so it stays unset.
  // Matches CreateTaskDialog's `initialValues` (and TasksBoard's TaskInitialValues).
  interface TaskInitialValues {
    status?: ColumnKey;
    assigneeId?: string | null;
    priority?: Priority;
    dueAt?: number;
    stateId?: string;
  }

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
  }: {
    workspaceId: string;
    tasks: Task[];
    pools: AssigneePools;
    // The project's workflow states (client.fetchProjectStates). When present, the
    // "status" grouping is data-driven (one group per real state) and the inline
    // status editor offers those states (writing stateId). Empty = legacy columns.
    states?: StateLite[];
    // The project's label / cycle / module catalogs, so the shared property row can
    // resolve names + colors and feed its inline Label / Cycle / Module editors
    // (matches TaskCard's prop set). The chip degrades to read-only when empty.
    labels?: TaskLabel[];
    cycles?: Cycle[];
    modules?: Module[];
    // The project's task-key prefix ("ENG"); null falls back to a "#<seq|id>" key.
    projectIdentifier?: string | null;
    groupBy?: GroupBy;
    // Emitted by a group's "New work item" row with that group's value pre-filled
    // (Plane's per-group quick-add). The parent opens the create modal seeded with
    // these initialValues. Same handler the board columns use.
    oncreate?: (initialValues: TaskInitialValues) => void;
  } = $props();

  // Group, then ORDER each group's rows by the user's Ordering preference (the
  // same sortTasks the board/toolbar share) so the list matches Plane's ordering.
  // groupTasks returns freshly-built groups each derive, so mutating g.tasks in
  // place (rather than spreading a new object per group) is safe and cheaper.
  const groups = $derived.by(() => {
    const built = groupTasks(tasks, groupBy, pools, states, { labels, cycles, modules });
    for (const g of built) {
      g.tasks = sortTasks(g.tasks, preferencesState.tasksOrderBy, preferencesState.tasksOrderDir);
    }
    return built;
  });

  // Per-property in-flight ids, so a row dims while ANY of its inline edits saves.
  let pendingIds = $state<Set<string>>(new Set());
  // Collapsed group keys (Plane list-group collapse) — local view state only.
  let collapsed = $state<Set<string>>(new Set());

  function toggleCollapse(key: string): void {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsed = next;
  }

  function open(taskId: string): void {
    // Open the in-context side-peek (single shared instance) instead of
    // navigating to the full-page /tasks/[id] route.
    openTaskDetail(taskId);
  }

  // Per-group quick-add prefill (mirrors TasksBoard.initialValuesFor): a status
  // group seeds stateId (data-driven) or status (legacy column), an assignee group
  // seeds assigneeId (null = Unassigned), a priority group seeds its priority.
  function initialValuesFor(group: TaskGroup): TaskInitialValues {
    if (groupBy === "status") {
      if (group.stateId) return { stateId: group.stateId };
      return group.columnKey ? { status: group.columnKey } : {};
    }
    if (groupBy === "assignee") {
      return group.assigneeId === undefined ? {} : { assigneeId: group.assigneeId };
    }
    return group.priority && group.priority !== "none" ? { priority: group.priority } : {};
  }

  // A group shows its "New work item" row only when it maps to a real, addable
  // value the create modal can honor (mirrors TasksBoard.canQuickAdd) — so we
  // never offer quick-add on a bucket that can't seed anything (Unassigned still
  // qualifies; the "No priority" bucket does not).
  function canQuickAdd(group: TaskGroup): boolean {
    if (groupBy === "status") return group.stateId != null || group.columnKey != null;
    if (groupBy === "assignee") return group.assigneeId !== undefined;
    return group.priority != null && group.priority !== "none";
  }

  // Plane's "Display properties" toggles decide which property chips a row renders
  // (all-on by default; the user opts OUT). Map the preference singleton onto
  // WorkItemProperties' DisplayMap so the editable strip honors the same toggles.
  // Plane's list ROW renders the STATE pill on every row regardless of the active
  // grouping (verified against Plane's list/block.tsx + all-properties.tsx: state
  // is gated ONLY by displayProperties.state, never suppressed when grouping BY
  // state) — so the status chip is NOT suppressed here. The assignee chip is still
  // dropped when grouping BY assignee, which the group header already encodes.
  const display = $derived({
    status: isDisplayed(preferencesState.tasksDisplay, "status"),
    priority: isDisplayed(preferencesState.tasksDisplay, "priority"),
    dueAt: isDisplayed(preferencesState.tasksDisplay, "dueAt"),
    assignee: isDisplayed(preferencesState.tasksDisplay, "assignee") && groupBy !== "assignee",
  });
  // The issue-KEY in the left cluster is gated by the "taskId" Display toggle
  // (separate from the chip strip's WorkItemProperties display map above).
  const showId = $derived(isDisplayed(preferencesState.tasksDisplay, "taskId"));

  // Single optimistic-update path for every inline field edit, mirroring the
  // detail card / board card commit(): patch workspaceState.tasks immediately, RPC,
  // reconcile with the server row (or revert + toast on failure).
  async function commit(
    task: Task,
    updates: Parameters<typeof client.updateTask>[2],
    optimistic: Partial<Task>,
  ): Promise<void> {
    if (pendingIds.has(task.id)) return;
    const prev = task;
    pendingIds = new Set(pendingIds).add(task.id);
    workspaceState.tasks = workspaceState.tasks.map((t) =>
      t.id === task.id ? { ...t, ...optimistic } : t,
    );
    try {
      const updated = await client.updateTask(workspaceId, task.id, updates);
      workspaceState.tasks = workspaceState.tasks.map((t) => (t.id === updated.id ? updated : t));
    } catch (err) {
      workspaceState.tasks = workspaceState.tasks.map((t) => (t.id === prev.id ? prev : t));
      toast.error(err instanceof Error ? err.message : "Couldn't update the task");
    } finally {
      const next = new Set(pendingIds);
      next.delete(task.id);
      pendingIds = next;
    }
  }

  // Data-driven status edit: write the task's `stateId` (the relay keeps `status`
  // in sync with the new state's phase).
  function saveState(task: Task, stateId: string): void {
    if (stateId === task.stateId) return;
    void commit(task, { stateId }, { stateId } as Partial<Task>);
  }

  function saveAssignee(task: Task, value: string | null): void {
    if (value === task.assigneeId) return;
    void commit(task, { assigneeId: value }, { assigneeId: value });
  }

  function savePriority(task: Task, value: Priority): void {
    if (value === priorityForTask(task)) return;
    const raw = value === "none" ? null : value;
    void commit(task, { priority: raw }, { priority: raw } as Partial<Task>);
  }

  // The DateRangeDropdown speaks ISO strings; tasks carry epoch-ms. Convert at this
  // boundary (matches TaskCard / TaskDetailCard) so the editor renders and the
  // commit stays in the task model's ms shape.
  function msToIso(ms: number | null | undefined): string | null {
    return ms == null ? null : new Date(ms).toISOString();
  }
  function isoToMs(iso: string | null): number | null {
    if (!iso) return null;
    const ms = new Date(iso).getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  // The list edits start + due together via one DateRangeDropdown (echoes the full
  // pair back as ISO). Skip the commit when neither half actually changed.
  function saveDates(task: Task, range: DateRange): void {
    const nextStart = isoToMs(range.startDate);
    const nextDue = isoToMs(range.dueAt);
    if (nextStart === (task.startDate ?? null) && nextDue === (task.dueAt ?? null)) return;
    void commit(
      task,
      { startDate: nextStart, dueAt: nextDue },
      { startDate: nextStart, dueAt: nextDue } as Partial<Task>,
    );
  }

  // updateTask persists labels by NAME (auto-created), not id; map the editor's
  // chosen ids back through the loaded catalog for the commit, while the optimistic
  // patch still carries the id set the editor speaks. (Mirrors TaskCard.)
  function labelIdsToNames(ids: string[]): string[] {
    return ids
      .map((id) => labels.find((l) => l.id === id)?.name)
      .filter((n): n is string => Boolean(n));
  }
  function saveLabels(task: Task, ids: string[]): void {
    void commit(task, { labels: labelIdsToNames(ids) }, { labelIds: ids } as Partial<Task>);
  }
  function saveCycle(task: Task, id: string | null): void {
    if (id === (task.cycleId ?? null)) return;
    void commit(task, { cycleId: id }, { cycleId: id } as Partial<Task>);
  }
  function saveModules(task: Task, ids: string[]): void {
    void commit(task, { moduleIds: ids }, { moduleIds: ids } as Partial<Task>);
  }

  // ONE shared "Delete task" confirmation for the whole list (not one-per-row):
  // a row's "…" menu sets the target task and opens it. The board drops the row
  // live via the tasks_changed "deleted" broadcast, so there's no manual prune.
  let deleteTarget = $state<Task | null>(null);
  let showDelete = $state(false);

  function askDelete(task: Task): void {
    deleteTarget = task;
    showDelete = true;
  }
</script>

<div class="h-full overflow-y-auto bg-surface">
  <!-- Plane's grouped list renders a section for EVERY group (list-group.tsx
       validateEmptyIssueGroups defaults to showing empty groups): the header +
       its "New work item" row appear even with zero rows, so an empty state like
       "Cancelled 0" is still visible. We iterate every group groupTasks returns
       (groupByState always yields one per project state, empty included). -->
  {#each groups as group (group.key)}
    {@const isCollapsed = collapsed.has(group.key)}
    <section>
        <!-- Plane list group header (headers/group-by-card.tsx): a plain row, NO
             leading chevron — the header row ITSELF toggles collapse on click
             (group-by-card.tsx:117-120). Icon + label + count sit inline. When
             grouping by STATUS, Plane's status <Row> carries a one-step-darker
             band (list-group.tsx → bg-layer-1) so the Backlog/Todo/… headers read
             as bands over the list rows; bg-tasks-group-header-bg maps that token.
             Other groupings keep the plain (bandless) header. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <header
          class={cn(listGroupHeader, "cursor-pointer", groupBy === "status" && "bg-tasks-group-header-bg")}
          role="button"
          tabindex="0"
          onclick={() => toggleCollapse(group.key)}
          onkeydown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleCollapse(group.key);
            }
          }}
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? `Expand ${group.label}` : `Collapse ${group.label}`}
        >
          {#if groupBy === "assignee"}
            <AssigneeAvatar assignee={group.assigneeId == null ? null : resolveAssignee(group.assigneeId, pools)} size={18} />
            <span class="truncate">{group.label}</span>
          {:else if groupBy === "priority"}
            {@const style = priorityStyle(group.priority ?? "none")}
            <span class={cn(priorityDot, style ? style.dot : "border border-edge-light")}></span>
            <span class="truncate">{group.label}</span>
          {:else if group.statePhase}
            <StateGroupIcon group={group.statePhase} color={group.stateColor} size={17} class="shrink-0" />
            <span class="truncate">{group.label}</span>
          {:else}
            <span class="truncate">{group.label}</span>
          {/if}
          <!-- Plane count (group-by-card.tsx:122): `pl-2 text-13 font-medium
               text-tertiary` — a plain tertiary number after the name. -->
          <span class="pl-2 tabular-nums font-medium text-content-muted">{group.tasks.length}</span>
        </header>

        <!-- Rows + the group's "New work item" footer (hidden while collapsed).
             An EMPTY group shows just its header + the quick-add row (no "No
             tasks" filler) — matching Plane's list-group, which renders the
             footer with no rows above it. -->
        {#if !isCollapsed}
          {#if group.tasks.length > 0}
            {#each group.tasks as task, i (task.id)}
              {@const shortId = taskKey(task.sequenceId, task.id, projectIdentifier)}
              {@const dueAtIso = msToIso(task.dueAt)}
              {@const subItemCount = (task as { subItemCount?: number }).subItemCount ?? 0}
              {@const isLast = i === group.tasks.length - 1}
              <!-- block-root.tsx:136 — the RenderIfVisible wrapper owns the row's
                   BOTTOM hairline, suppressed on the LAST child so the group's final
                   row sits flush (Plane: `isLastChild && !isExpanded ? '' : border-b`). -->
              <div class={cn(listRowWrap, !isLast && listRowBorder)}>
                <!-- block.tsx:177-209 — the whole-row peek-on-click target wrapping the
                     <Row>. A SINGLE LINE: a left grow cluster (select checkbox + KEY +
                     title) and a right cluster (the shared property strip + "…" menu). -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                  role="button"
                  tabindex="0"
                  onclick={() => open(task.id)}
                  onkeydown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      open(task.id);
                    }
                  }}
                  class={cn(
                    listRow,
                    "cursor-pointer",
                    taskDetail.openId === task.id && cn(listRowSelected, listRowPeeked),
                    pendingIds.has(task.id) && "opacity-60",
                  )}
                >
                  <!-- block.tsx:210 — the TOP line holding both clusters. -->
                  <div class={listRowTop}>
                    <!-- block.tsx:211 — the LEFT grow cluster (`flex flex-grow
                         items-center gap-0.5 truncate`). -->
                    <div class={listRowLeft}>
                      <!-- block.tsx:212 — the leading indent + icon group: the
                           hover-revealed multi-select checkbox slot + the KEY. -->
                      <div class={listRowLead}>
                        <!-- block.tsx:214-224 — the hover-revealed multi-select
                             checkbox, pinned `absolute left-1`, revealed via
                             group/list-block. Decorative here (no bulk-select yet);
                             stopPropagation so toggling never opens the peek. -->
                        <!-- svelte-ignore a11y_click_events_have_key_events -->
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <span
                          class={listRowSelect}
                          role="presentation"
                          onclick={(e) => e.stopPropagation()}
                          onkeydown={(e) => e.stopPropagation()}
                        >
                          <span class={checkBoxBase} aria-hidden="true"></span>
                        </span>
                        <!-- block.tsx:241-253 — the work-item KEY, display-gated,
                             fixed min-width so titles line up (Plane keyMinWidth). -->
                        {#if showId}
                          <span class={cn(listRowId, "hidden sm:inline")}>{shortId}</span>
                        {/if}
                      </div>
                      <!-- block.tsx:278-286 — the TITLE: single-line truncate. -->
                      <span class={listRowTitle}>{task.title}</span>
                    </div>

                    <!-- block.tsx:311 — the RIGHT cluster (`flex flex-shrink-0
                         items-center gap-2`): the ONE shared WorkItemProperties strip
                         (editable, Plane order: state · priority · dates · assignee ·
                         counts) then the hover-revealed "…" quick-actions.
                         stopPropagation so editing a chip / opening the menu never
                         opens the side-peek. -->
                    <div class={listRowProps}>
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <!-- block.tsx:314-322 — the shared IssueProperties wrapper:
                       `relative flex flex-wrap lg:flex-shrink-0 lg:flex-grow
                       items-center gap-2 whitespace-nowrap`. -->
                  <div
                    class={cn("hidden sm:flex", listRowPropsStrip)}
                    role="presentation"
                    onclick={(e) => e.stopPropagation()}
                    onkeydown={(e) => e.stopPropagation()}
                  >
                    <WorkItemProperties
                      stateId={task.stateId ?? null}
                      priority={priorityForTask(task)}
                      assigneeId={task.assigneeId}
                      startDate={msToIso(task.startDate)}
                      dueAt={dueAtIso}
                      labelIds={task.labelIds ?? []}
                      cycleId={task.cycleId ?? null}
                      moduleIds={task.moduleIds ?? []}
                      {subItemCount}
                      isDone={task.status === "done"}
                      {states}
                      {labels}
                      {cycles}
                      {modules}
                      {pools}
                      {display}
                      variant="chip"
                      class="pt-0"
                      editable
                      onStateChange={(id) => saveState(task, id)}
                      onPriorityChange={(p) => savePriority(task, p)}
                      onAssigneeChange={(v) => saveAssignee(task, v)}
                      onDatesChange={(r) => saveDates(task, r)}
                      onLabelsChange={(ids) => saveLabels(task, ids)}
                      onCycleChange={(id) => saveCycle(task, id)}
                      onModulesChange={(ids) => saveModules(task, ids)}
                    />
                  </div>
                  <!-- Compact avatar fallback on the narrowest rows (the full strip is
                       hidden below sm). -->
                  {#if display.assignee}
                    <span class="inline-flex sm:hidden">
                      <AssigneeAvatar assignee={resolveAssignee(task.assigneeId, pools)} size={20} />
                    </span>
                  {/if}

                  <!-- Row quick-actions ("…"): portal'd menu with a destructive Delete.
                       stopPropagation so opening / picking never opens the side-peek.
                       Hover-revealed to match Plane's list-row affordance. -->
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <span
                    class="inline-flex"
                    role="presentation"
                    onclick={(e) => e.stopPropagation()}
                    onkeydown={(e) => e.stopPropagation()}
                  >
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        title="More actions"
                        aria-label="More actions"
                        disabled={pendingIds.has(task.id)}
                        class="grid size-6 place-items-center rounded-[4px] text-content-muted opacity-0 transition hover:bg-hover-gray hover:text-content focus-ring focus-visible:opacity-100 group-hover/list-block:opacity-100 disabled:opacity-50 data-[state=open]:opacity-100"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
                        </svg>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" class="w-44">
                        <DropdownMenuItem
                          variant="destructive"
                          class="cursor-pointer"
                          onclick={() => askDelete(task)}
                        >
                          <Trash2Icon class="size-4" />
                          Delete task
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </span>
                    </div>
                  </div>
                </div>
              </div>
            {/each}
          {/if}

          <!-- list-group.tsx:327-342 — the per-group "New work item" quick-add row.
               Seeds the create modal with this group's value (its stateId / status
               / assigneeId / priority) so the new task lands in the group. Only
               shown when the group maps to a real addable value AND the parent
               wired `oncreate`. stopPropagation isn't needed (it's a sibling of the
               peek-on-click rows, not nested in one). -->
          {#if oncreate && canQuickAdd(group)}
            <button
              type="button"
              class={listGroupAdd}
              aria-label={`New work item in ${group.label}`}
              onclick={() => oncreate?.(initialValuesFor(group))}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>New work item</span>
            </button>
          {/if}
        {/if}
      </section>
  {/each}
</div>

<!-- ONE shared "Delete task" confirmation for the whole list, driven by the row
     "…" menus. Portals to <body>; the board drops the row live via the
     tasks_changed "deleted" broadcast. -->
{#if deleteTarget}
  <DeleteTaskDialog bind:open={showDelete} {workspaceId} task={deleteTarget} />
{/if}
