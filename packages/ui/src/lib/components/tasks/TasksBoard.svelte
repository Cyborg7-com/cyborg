<script lang="ts">
  // The Tasks KANBAN board, ported to Plane's kanban-group look via the shared
  // Tasks foundation (lib/tasks/ui.ts). It renders one column per group from the
  // pure view model (group by Status | Assignee | Priority): a horizontal scroll
  // row of fixed-width (350px) columns over a single canvas (no grid lines /
  // "cuadricula"). Each column is a SUBTLE distinct surface (bg-tasks-column +
  // a border-tasks-column-border hairline + rounded-lg) over the canvas, and the
  // cards layer one step further inside it — canvas → column → card. The scroll
  // track is `w-max min-w-full` so the
  // columns hug the left and the leftover width stays the same canvas color (no
  // empty bordered box on the right). Each column has a header (group icon +
  // title + count + collapse + add), a vertical stack of cards, and an "Add
  // issue" quick-add at the foot. A per-column collapse compacts the column to a
  // slim vertical rail (Plane's collapse-to-rail), persisted in preferencesState
  // so it survives reload. Every class resolves through an app.css token — no
  // hardcoded colors — so dark AND light both match.
  //
  // Drag-and-drop only changes STATUS, so it is enabled only when grouped BY
  // status (dropping a card into a column writes that status via
  // client.updateTask). In Assignee / Priority grouping the columns are a view —
  // we don't reassign or re-prioritize over RPC — so dropping is a no-op there.
  // Status can still always be changed via each card's portal'd "…" menu.
  import { toast } from "svelte-sonner";
  import { openTaskDetail, taskDetail } from "$lib/tasks/detailStore.svelte.js";
  import { client } from "$lib/state/client.js";
  import { preferencesState } from "$lib/state/preferences.svelte.js";
  import AssigneeAvatar from "$lib/components/tasks/AssigneeAvatar.svelte";
  import StateGroupIcon from "$lib/components/tasks/StateGroupIcon.svelte";
  import TaskCard from "$lib/components/tasks/TaskCard.svelte";
  import { resolveAssignee, type AssigneePools } from "$lib/tasks/assignee.js";
  import { type ColumnKey } from "$lib/tasks/board.js";
  import { priorityStyle, type Priority } from "$lib/tasks/priority.js";
  import { groupTasks, type GroupBy, type StateLite, type TaskGroup } from "$lib/tasks/view.js";
  import type { TaskLabel, Cycle, Module } from "$lib/core/types.js";
  import {
    boardScrollOuter,
    boardScrollInner,
    column,
    columnHeader,
    columnCount,
    columnIcon,
    columnCollapsed,
    columnCollapsedHeader,
    columnCollapseBtn,
    columnAdd,
    boardQuickAddCard,
    boardQuickAddInput,
    boardQuickAddHint,
    priorityDot,
  } from "$lib/tasks/ui.js";
  import type { Task } from "$lib/core/types.js";
  import { cn } from "$lib/utils.js";

  // The Plane create-issue modal's prefill shape. Per-column quick-add passes the
  // column's group value here so a task created from a column lands in it: status
  // for status columns, assigneeId for assignee columns, priority for priority
  // columns. dueAt is never derivable from a column group, so it stays undefined.
  // Matches CreateTaskDialog's `initialValues` prop shape exactly.
  interface TaskInitialValues {
    status?: ColumnKey;
    assigneeId?: string | null;
    priority?: Priority;
    dueAt?: number;
    // When grouping by the project's real states, a column's quick-add seeds the
    // new task's `stateId` so it lands in that state's column.
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
    onquickcreate,
  }: {
    workspaceId: string;
    tasks: Task[];
    pools: AssigneePools;
    // The project's workflow states (client.fetchProjectStates). When present, the
    // "status" grouping renders one column PER STATE (data-driven), the header
    // shows the state's color + name, and drag-to-column writes `stateId`. Empty =
    // legacy four fixed columns + status writes.
    states?: StateLite[];
    // The project's label catalog, forwarded to each card for label dots + the
    // inline LabelDropdown editor.
    labels?: TaskLabel[];
    // The project's cycle / module catalogs, forwarded to each card's inline
    // CycleSelect / ModuleSelect editors (the chip strip only renders those editors
    // when their catalog is non-empty).
    cycles?: Cycle[];
    modules?: Module[];
    // The project's task-key prefix ("ENG"), forwarded to each card for the key.
    projectIdentifier?: string | null;
    groupBy?: GroupBy;
    // Emitted by a column's HEADER "+" with that column's group value pre-filled
    // (Plane's per-column quick-add). The parent opens the create MODAL seeded with
    // these initialValues — the full create form.
    oncreate?: (initialValues: TaskInitialValues) => void;
    // The column-foot INLINE quick-add create handler (Plane's KanbanQuickAddIssue
    // form). Given a trimmed title + this column's group value, the parent files a
    // new work item straight through client.createTask (the SAME create path the
    // create modal uses — no second flow), returning whether it succeeded. The board
    // owns only the composer UI; the parent owns the RPC + project/state context.
    onquickcreate?: (
      title: string,
      initialValues: TaskInitialValues,
    ) => Promise<boolean | void> | boolean | void;
  } = $props();

  // Pass the project states into the grouping so "status" becomes data-driven (one
  // column per real state) — view.ts groupTasks routes "status" → groupByState
  // when states are supplied, else the four fixed columns.
  const groups = $derived(groupTasks(tasks, groupBy, pools, states, { labels, cycles, modules }));
  // Drag-to-move semantics only make sense when columns ARE states/statuses.
  const dragEnabled = $derived(groupBy === "status");

  let draggingId = $state<string | null>(null);
  let dragOverKey = $state<string | null>(null);
  let pendingIds = $state<Set<string>>(new Set());

  // Per-column collapse state (Plane's kanban column collapse-to-rail), keyed by
  // group key — a collapsed column hides its cards but keeps the icon + count
  // visible as a slim vertical rail. Persisted device-globally in
  // preferencesState (mirroring Plane's persisted kanbanFilters.group_by list),
  // so a collapsed column stays collapsed across reloads.
  const collapsed = $derived(preferencesState.tasksCollapsedColumns);

  function toggleCollapsed(key: string): void {
    preferencesState.toggleTasksColumnCollapsed(key);
  }

  // Build the per-column prefill from a group: status columns seed `status`,
  // assignee columns seed `assigneeId`, priority columns seed `priority`. Only
  // real, addable group values are passed (the Unassigned and "No priority"
  // buckets, and any column without a quick-add target, fall through to undefined
  // so the create modal opens with no spurious prefill).
  function initialValuesFor(group: TaskGroup): TaskInitialValues {
    if (groupBy === "status") {
      // Data-driven columns seed stateId; legacy columns seed status.
      if (group.stateId) return { stateId: group.stateId };
      return group.columnKey ? { status: group.columnKey } : {};
    }
    if (groupBy === "assignee") {
      // assigneeId is `null` for the Unassigned column — pass it through so the
      // quick-add explicitly creates an unassigned task in that column.
      return group.assigneeId === undefined ? {} : { assigneeId: group.assigneeId };
    }
    // priority: skip the "No priority" bucket (nothing real to prefill).
    return group.priority && group.priority !== "none" ? { priority: group.priority } : {};
  }

  // A column shows the per-column quick-add only when its group maps to a real,
  // addable value the create modal can honor (so we don't offer "Add issue" on a
  // column that can't seed anything meaningful).
  function canQuickAdd(group: TaskGroup): boolean {
    if (groupBy === "status") return group.stateId != null || group.columnKey != null;
    if (groupBy === "assignee") return group.assigneeId !== undefined;
    return group.priority != null && group.priority !== "none";
  }

  // ── Column-foot inline quick-add (Plane KanbanQuickAddIssue) ─────────────────
  // The key of the column whose inline composer is OPEN (only one at a time — a
  // blur on one column's input closes it before another opens, so a single key
  // tracks the whole board faithfully). `quickAddTitle` is the live input value.
  let quickAddKey = $state<string | null>(null);
  let quickAddTitle = $state("");
  let quickAddInputEl = $state<HTMLInputElement | null>(null);

  // Reveal the inline composer for a column (replacing its "+ New work item" row),
  // starting from an empty title. The input autofocuses on mount (focusOnMount).
  function openQuickAdd(group: TaskGroup): void {
    quickAddTitle = "";
    quickAddKey = group.key;
  }

  // Close the composer back to the "+ New work item" row (Escape / blur).
  function closeQuickAdd(): void {
    quickAddKey = null;
    quickAddTitle = "";
  }

  // Enter in the composer: file a work item into THIS column's group via the
  // parent's create handler, then CLEAR + stay focused so the user can add another
  // (Plane's rapid-entry flow — the composer stays open; the new card arrives live
  // via the cyborg:tasks_changed broadcast). Whitespace-only titles are ignored.
  // The title is cleared immediately (mirroring Plane's reset-on-submit) so a
  // double-Enter never duplicates the row.
  async function submitQuickAdd(group: TaskGroup): Promise<void> {
    const title = quickAddTitle.trim();
    if (!title || !onquickcreate) return;
    const initial = initialValuesFor(group);
    quickAddTitle = "";
    quickAddInputEl?.focus();
    await onquickcreate(title, initial);
  }

  // Svelte action: focus the composer input the moment it mounts (Plane sets focus
  // on the name field when the form opens). Avoids the `autofocus` attribute lint.
  function focusOnMount(node: HTMLInputElement): void {
    node.focus();
  }

  function open(taskId: string): void {
    // Open the in-board editable "peek" card (a single modal driven by the
    // shared store) instead of navigating to the full-page detail route.
    openTaskDetail(taskId);
  }

  async function moveTask(task: Task, to: ColumnKey): Promise<void> {
    if (task.status === to || pendingIds.has(task.id)) return;
    pendingIds = new Set(pendingIds).add(task.id);
    try {
      await client.updateTask(workspaceId, task.id, { status: to });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't move the task");
    } finally {
      const next = new Set(pendingIds);
      next.delete(task.id);
      pendingIds = next;
    }
  }

  // Data-driven move: write the task's `stateId` (drag-to-column / card menu when
  // grouping by the project's real states). The relay keeps `status` in sync with
  // the new state's phase, so no extra status write is needed.
  async function moveTaskToState(task: Task, stateId: string): Promise<void> {
    if (task.stateId === stateId || pendingIds.has(task.id)) return;
    pendingIds = new Set(pendingIds).add(task.id);
    try {
      await client.updateTask(workspaceId, task.id, { stateId });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't move the task");
    } finally {
      const next = new Set(pendingIds);
      next.delete(task.id);
      pendingIds = next;
    }
  }

  function onDragStart(event: DragEvent, taskId: string): void {
    draggingId = taskId;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", taskId);
    }
  }

  function onDragEnd(): void {
    draggingId = null;
    dragOverKey = null;
  }

  // Drop onto a column: a data-driven state column writes `stateId`; a legacy
  // column writes `status`. The group carries whichever target applies.
  function onDrop(event: DragEvent, group: TaskGroup): void {
    event.preventDefault();
    const id = event.dataTransfer?.getData("text/plain") || draggingId;
    draggingId = null;
    dragOverKey = null;
    if (!id) return;
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    if (group.stateId) void moveTaskToState(task, group.stateId);
    else if (group.columnKey) void moveTask(task, group.columnKey);
  }

  function onDragOver(event: DragEvent, key: string): void {
    if (!dragEnabled) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    dragOverKey = key;
  }
</script>

<!-- Plane kanban-group (base-kanban-root.tsx): a viewport-bounded OUTER scroller
     wrapping an INNER columns row. The outer div is the SCROLL container — it stays
     the viewport width (w-full) and scrolls horizontally; the inner row GROWS with
     its fixed-width columns (w-max), so a wide board scrolls instead of overflowing
     the page. Each column is a subtle bg-tasks-column box with a hairline border;
     cards stack vertically and the column scrolls on its own when its stack overflows. -->
<div class={boardScrollOuter}>
  <div class={boardScrollInner}>
    {#each groups as group (group.key)}
      {@const isCollapsed = collapsed.has(group.key)}
      {#if isCollapsed}
        <!-- Collapsed column: a slim vertical rail (Plane's collapse-to-rail). Keeps
             the header label + count visible, rotated vertical; hides every card.
             Clicking the rail (or its chevron) expands it again. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <section
          class={cn(columnCollapsed, "h-full")}
          aria-label={`${group.label} (collapsed)`}
          ondragover={(e) => onDragOver(e, group.key)}
          ondragleave={() => {
            if (dragOverKey === group.key) dragOverKey = null;
          }}
          ondrop={(e) => onDrop(e, group)}
        >
          <button
            type="button"
            title="Expand column"
            aria-label={`Expand ${group.label}`}
            aria-expanded="false"
            onclick={() => toggleCollapsed(group.key)}
            class={columnCollapseBtn}
          >
            <!-- Maximize2 (lucide): collapsed → expand on click. Matches Plane. -->
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
          <div class={cn(columnCollapsedHeader, "min-h-0 flex-1")}>
            {#if groupBy === "assignee"}
              <AssigneeAvatar assignee={group.assigneeId == null ? null : resolveAssignee(group.assigneeId, pools)} size={18} class="shrink-0" />
            {:else if groupBy === "priority"}
              {@const style = priorityStyle(group.priority ?? "none")}
              <span class={cn(priorityDot, style ? style.dot : "border border-edge-light")}></span>
            {:else if group.statePhase}
              <StateGroupIcon group={group.statePhase} color={group.stateColor} size={16} class="shrink-0" />
            {/if}
            <span class="min-w-0 truncate [writing-mode:vertical-lr]">{group.label}</span>
            <span class={columnCount}>{group.tasks.length}</span>
          </div>
        </section>
      {:else}
        <section
          class={cn(
            column,
            "h-full",
            dragOverKey === group.key && "ring-1 ring-accent ring-inset",
          )}
          ondragover={(e) => onDragOver(e, group.key)}
          ondragleave={() => {
            if (dragOverKey === group.key) dragOverKey = null;
          }}
          ondrop={(e) => onDrop(e, group)}
          aria-label={group.label}
        >
          <!-- Column header: collapse chevron + group icon/avatar + title + count
               + add button. -->
          <header class={columnHeader}>
            <button
              type="button"
              title="Collapse column"
              aria-label={`Collapse ${group.label}`}
              aria-expanded="true"
              onclick={() => toggleCollapsed(group.key)}
              class={columnCollapseBtn}
            >
              <!-- Minimize2 (lucide): expanded → collapse to rail on click. Matches Plane. -->
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
            <!-- Plane wraps the group icon in a fixed size-5 box (group-by-card.tsx:119)
                 so titles line up regardless of the icon's intrinsic size. -->
            {#if groupBy === "assignee"}
              <span class={columnIcon}>
                <AssigneeAvatar assignee={group.assigneeId == null ? null : resolveAssignee(group.assigneeId, pools)} size={18} class="shrink-0" />
              </span>
              <span class="min-w-0 truncate">{group.label}</span>
            {:else if groupBy === "priority"}
              {@const style = priorityStyle(group.priority ?? "none")}
              <span class={columnIcon}>
                <span class={cn(priorityDot, style ? style.dot : "border border-edge-light")}></span>
              </span>
              <span class="min-w-0 truncate">{group.label}</span>
            {:else if group.statePhase}
              <span class={columnIcon}>
                <StateGroupIcon group={group.statePhase} color={group.stateColor} size={16} class="shrink-0" />
              </span>
              <span class="min-w-0 truncate">{group.label}</span>
            {:else}
              <span class="min-w-0 truncate">{group.label}</span>
            {/if}
            <span class={columnCount}>{group.tasks.length}</span>
            {#if oncreate && canQuickAdd(group)}
              <!-- Plane '+' add (group-by-card.tsx:183-190): a 20px square, rounded-sm,
                   quiet, hover-tinted. ml-auto pins it to the header's right edge. -->
              <button
                type="button"
                title="Add task"
                aria-label={`Add task to ${group.label}`}
                onclick={() => oncreate?.(initialValuesFor(group))}
                class="ml-auto grid size-5 shrink-0 place-items-center rounded-[4px] text-content-muted transition-colors hover:bg-hover-gray hover:text-content focus-ring"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            {/if}
          </header>

          <!-- Card stack: scrolls independently when it overflows the column. Plane
               shows an EMPTY column body (no "No tasks" filler) when a group has no
               cards — the quick-add at the foot is the only affordance. -->
          <div class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1">
            {#each group.tasks as task (task.id)}
              <TaskCard
                {task}
                {workspaceId}
                {pools}
                {states}
                {labels}
                {cycles}
                {modules}
                {projectIdentifier}
                dragging={draggingId === task.id}
                pending={pendingIds.has(task.id)}
                peeked={taskDetail.openId === task.id}
                onopen={open}
                onmove={moveTask}
                onmovestate={moveTaskToState}
                ondragstart={onDragStart}
                ondragend={onDragEnd}
              />
            {/each}

            <!-- Plane kanban-group.tsx:325-339 — the per-column quick-add pinned to
                 the column foot (`sticky bottom-0` over the column surface, so it
                 stays reachable while the cards scroll under it). CLOSED: a full-
                 width "+ New work item" row. OPEN: an inline composer card (title
                 input + "Press 'Enter'…" hint) that files a work item into THIS
                 column's group on Enter and stays open for the next one. Only for
                 real, addable columns AND when the parent wired the create handler. -->
            {#if onquickcreate && canQuickAdd(group)}
              <div class="sticky bottom-0 bg-tasks-column-bg py-0.5">
                {#if quickAddKey === group.key}
                  <!-- Open: the inline composer card (Plane KanbanQuickAddIssueForm). -->
                  <div class={boardQuickAddCard}>
                    <div class="p-3">
                      {#if projectIdentifier}
                        <!-- Plane form/kanban.tsx h4: the project key above the input. -->
                        <span class="block text-[11px] font-medium leading-5 text-content-muted">
                          {projectIdentifier}
                        </span>
                      {/if}
                      <!-- Title input: autofocused on mount; Enter creates + keeps the
                           composer open (clears + refocuses), Escape / blur closes it. -->
                      <input
                        bind:this={quickAddInputEl}
                        bind:value={quickAddTitle}
                        use:focusOnMount
                        type="text"
                        autocomplete="off"
                        placeholder="Work item title"
                        aria-label="Work item title"
                        class={boardQuickAddInput}
                        onkeydown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void submitQuickAdd(group);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            closeQuickAdd();
                          }
                        }}
                        onblur={closeQuickAdd}
                      />
                    </div>
                    <!-- Footer hint band (Plane: "Press 'Enter' to add another work item"). -->
                    <div class={boardQuickAddHint}>Press 'Enter' to add another work item</div>
                  </div>
                {:else}
                  <!-- Closed: the "+ New work item" row (Plane KanbanQuickAddIssueButton). -->
                  <button
                    type="button"
                    class={columnAdd}
                    aria-label={`New work item in ${group.label}`}
                    onclick={() => openQuickAdd(group)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    <span>New work item</span>
                  </button>
                {/if}
              </div>
            {/if}
          </div>
        </section>
      {/if}
    {/each}
  </div>
</div>
