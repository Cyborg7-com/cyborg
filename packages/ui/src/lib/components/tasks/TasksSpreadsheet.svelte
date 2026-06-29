<script lang="ts">
  // The Tasks SPREADSHEET layout — Plane's spreadsheet-view (spreadsheet/issue-row.tsx):
  // a wide, horizontally scrollable property TABLE. The first column (the task
  // KEY + title) is STICKY-LEFT so it stays pinned while the property columns
  // scroll sideways; the header row is STICKY-TOP. Faithful to Plane's row:
  //   - the sticky FIRST cell splits into an IDENTIFIER sub-section (the task KEY,
  //     `min-w-24`) and a WORK-ITEM sub-section (`min-w-60`) holding the clickable
  //     title that opens the in-context side-peek (openTaskDetail) + a hover-
  //     revealed quick-actions slot — Plane's `group/list-block` reveal;
  //   - REST = one property cell per column (state, priority, assignee, start,
  //     due, labels, counts, created, updated), each its own `<td>` rendering the
  //     SAME shared wired editor the list/board/detail use (StateDropdown /
  //     PriorityDropdown / AssigneeDropdown / DateRangeDropdown / LabelDropdown),
  //     so a cell edits exactly like everywhere else and reads identically;
  //   - row height is Plane's `h-11` (44px) with `border-r`/`border-b` cell
  //     hairlines; rows hover-tint and the frozen first cell mirrors the tint;
  //   - each property header is CLICK-TO-SORT (drives the shared Ordering
  //     preference so the spreadsheet, the list, and the toolbar Ordering menu all
  //     stay in lock-step; clicking the active column flips asc↔desc) and carries a
  //     right-edge resize-handle (local column-width state, drag to resize);
  //   - every inline edit persists through client.updateTask with an optimistic
  //     patch of workspaceState.tasks (revert + toast on failure) — identical
  //     commit() path to TasksList / TaskCard.
  // The sub-issues / links / attachments count columns render a real 0 placeholder
  // (those relations land in a later phase — no fake data, but the column is shown
  // so the spreadsheet shape matches Plane today).
  import { toast } from "svelte-sonner";
  import { client } from "$lib/state/client.js";
  import { workspaceState } from "$lib/state/app.svelte.js";
  import { preferencesState } from "$lib/state/preferences.svelte.js";
  import { openTaskDetail, taskDetail } from "$lib/tasks/detailStore.svelte.js";
  import StateDropdown from "$lib/components/tasks/StateDropdown.svelte";
  import PriorityDropdown from "$lib/components/tasks/PriorityDropdown.svelte";
  import AssigneeDropdown from "$lib/components/tasks/AssigneeDropdown.svelte";
  import DateRangeDropdown, { type DateRange } from "$lib/components/tasks/DateRangeDropdown.svelte";
  import LabelDropdown from "$lib/components/tasks/LabelDropdown.svelte";
  import type { AssigneePools } from "$lib/tasks/assignee.js";
  import { priorityForTask, type Priority } from "$lib/tasks/priority.js";
  import { sortTasks, isDisplayed, type GroupBy, type OrderBy, type StateLite } from "$lib/tasks/view.js";
  import {
    STATUS_OPTIONS,
    statusLabel,
    taskKey,
    dueToInputValue,
    dueFromInputValue,
  } from "$lib/tasks/detail.js";
  import type { Task, TaskLabel, Cycle, Module } from "$lib/core/types.js";
  import { cn } from "$lib/utils.js";
  import {
    sheetWrapper,
    sheetTable,
    sheetHeadRow,
    sheetHeadCell,
    sheetHeadKeyCell,
    sheetSortIndicator,
    sheetResizeHandle,
    sheetRow,
    sheetRowSelected,
    sheetCell,
    sheetKeyCell,
    sheetKeyInner,
    sheetKeyInnerPeeked,
    sheetKeyInnerScrolled,
    sheetKeySelect,
    sheetKeyChevron,
    sheetKeyIdentifier,
    sheetKeyWorkItem,
    sheetKeyWorkItemNoKey,
    sheetKeyTitle,
    sheetKeyAction,
    sheetCellTrigger,
    checkBoxBase,
  } from "$lib/tasks/ui.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
  } from "$lib/components/ui/dropdown-menu/index.js";
  import DeleteTaskDialog from "$lib/components/tasks/DeleteTaskDialog.svelte";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";

  let {
    workspaceId,
    tasks,
    pools,
    // The project's workflow states (client.fetchProjectStates). When present, the
    // status cell becomes the data-driven StateDropdown (one option per real state,
    // writing stateId); empty → the legacy four-status Select. Mirrors TasksList.
    states = [],
    // The project's label catalog, feeding the inline LabelDropdown in the labels
    // cell + resolving label name/color. Empty → the labels cell stays read-only.
    labels = [],
    // The project's cycle / module catalogs — accepted for prop-shape parity with
    // the sibling layouts (TaskCard / TasksList). The spreadsheet does not surface
    // a cycle/module column today (Plane gates those behind project settings), so
    // they are intentionally unused here. The `_`-prefix marks that.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    cycles: _cycles = [],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    modules: _modules = [],
    // The project's task-key prefix ("ENG"); null falls back to a "#<seq|id>" key
    // via taskKey (same contract as TaskCard).
    projectIdentifier = null,
    // The spreadsheet positions tasks in one flat table (Plane's spreadsheet view
    // is not grouped), so it accepts `groupBy` for prop-shape parity but ignores
    // it — the rows are ordered solely by the shared Ordering preference.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    groupBy: _groupBy = "status",
    oncreate,
  }: {
    workspaceId: string;
    tasks: Task[];
    pools: AssigneePools;
    states?: StateLite[];
    labels?: TaskLabel[];
    cycles?: Cycle[];
    modules?: Module[];
    projectIdentifier?: string | null;
    groupBy?: GroupBy;
    oncreate?: (initialValues?: {
      status?: string;
      assigneeId?: string | null;
      priority?: string;
      dueAt?: number | null;
    }) => void;
  } = $props();

  // One flat, Ordering-sorted list (Plane's spreadsheet view is ungrouped). Uses
  // the SAME sortTasks the list/board/toolbar share, reading the shared Ordering
  // preference, so a header click here updates the same source of truth.
  const rows = $derived(
    sortTasks(tasks, preferencesState.tasksOrderBy, preferencesState.tasksOrderDir),
  );

  // ── Columns ────────────────────────────────────────────────────────────────
  // Each property column. `sort` is the OrderBy this column drives when clicked
  // (null = a column the Ordering menu can't honor, e.g. the placeholder counts).
  // `width` seeds the resizable width. Order tracks Plane's spreadsheetColumnsList
  // (state, priority, assignee, start, due, labels, sub-issues, links,
  // attachments, created, updated); the KEY+title is the sticky-left frozen column.
  type ColId =
    | "status"
    | "priority"
    | "assignee"
    | "startDate"
    | "dueAt"
    | "labels"
    | "subIssues"
    | "links"
    | "attachments"
    | "createdAt"
    | "updatedAt";
  interface Col {
    id: ColId;
    label: string;
    sort: OrderBy | null;
    width: number;
  }
  const COLS: Col[] = [
    { id: "status", label: "State", sort: null, width: 160 },
    { id: "priority", label: "Priority", sort: "priority", width: 130 },
    { id: "assignee", label: "Assignee", sort: null, width: 180 },
    { id: "startDate", label: "Start date", sort: null, width: 150 },
    { id: "dueAt", label: "Due date", sort: "dueAt", width: 150 },
    { id: "labels", label: "Labels", sort: null, width: 200 },
    { id: "subIssues", label: "Sub-issues", sort: null, width: 110 },
    { id: "links", label: "Links", sort: null, width: 90 },
    { id: "attachments", label: "Attachments", sort: null, width: 120 },
    { id: "createdAt", label: "Created", sort: "createdAt", width: 140 },
    { id: "updatedAt", label: "Updated", sort: "updatedAt", width: 140 },
  ];

  // Resizable per-column widths (local view state). Seeded from COLS; a header's
  // right-edge handle drags an entry here. Title (key) column has its own width.
  let widths = $state<Record<ColId, number>>(
    Object.fromEntries(COLS.map((c) => [c.id, c.width])) as Record<ColId, number>,
  );
  let keyWidth = $state(360);

  // ── Click-to-sort ────────────────────────────────────────────────────────
  // Clicking a sortable header sets it as the active Ordering field; clicking the
  // already-active field flips asc↔desc (Plane's header-sort behavior). Writes
  // through the shared preference setters so every Tasks surface stays in sync.
  function sortBy(col: Col): void {
    if (!col.sort) return;
    if (preferencesState.tasksOrderBy === col.sort) {
      preferencesState.toggleTasksOrderDir();
    } else {
      preferencesState.setTasksOrderBy(col.sort);
      preferencesState.setTasksOrderDir("asc");
    }
  }
  // The active-sort glyph for a column header: ↑ asc / ↓ desc on the active
  // column, nothing otherwise.
  function sortGlyph(col: Col): "asc" | "desc" | null {
    if (!col.sort || preferencesState.tasksOrderBy !== col.sort) return null;
    return preferencesState.tasksOrderDir;
  }

  // ── Column resize ──────────────────────────────────────────────────────────
  // Pointer-drag the header's right-edge handle to resize a column. Tracked with
  // pointer-capture so the drag continues even when the cursor leaves the strip.
  const MIN_COL = 64;
  let resizing: { col: ColId | "__key__"; startX: number; startW: number } | null = null;

  function startResize(e: PointerEvent, col: ColId | "__key__"): void {
    e.preventDefault();
    e.stopPropagation();
    const startW = col === "__key__" ? keyWidth : widths[col];
    resizing = { col, startX: e.clientX, startW };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function moveResize(e: PointerEvent): void {
    if (!resizing) return;
    const next = Math.max(MIN_COL, resizing.startW + (e.clientX - resizing.startX));
    if (resizing.col === "__key__") keyWidth = next;
    else widths = { ...widths, [resizing.col]: next };
  }
  function endResize(e: PointerEvent): void {
    if (!resizing) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // pointer already released — ignore
    }
    resizing = null;
  }

  // ── Inline-edit commit (mirrors TasksList.commit exactly) ──────────────────
  // Per-row in-flight ids so a row dims while ANY of its inline edits saves.
  let pendingIds = $state<Set<string>>(new Set());

  function open(taskId: string): void {
    openTaskDetail(taskId);
  }

  // Plane casts a left-edge shadow on the frozen first cell once the sheet is
  // scrolled sideways (issue-row.tsx: `isScrolled` → shadow-[...]), so the pinned
  // column reads as floating over the scrolled body. We track the wrapper's
  // horizontal scroll offset and flip the shadow on once it leaves the origin.
  let isScrolled = $state(false);
  function onScroll(e: Event): void {
    isScrolled = (e.currentTarget as HTMLElement).scrollLeft > 0;
  }

  // Single optimistic-update path for every inline field edit: patch
  // workspaceState.tasks immediately, RPC, reconcile with the server row (or
  // revert + toast on failure). Identical contract to the list view's commit().
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

  function saveStatus(task: Task, value: string): void {
    if (value === task.status) return;
    void commit(task, { status: value }, { status: value });
  }
  // Data-driven status edit: write the task's `stateId` (the relay keeps `status`
  // in sync with the new state's phase). Used when the project's states are passed.
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

  // ── Date columns (Start + Due) via the shared DateRangeDropdown ────────────
  // Plane has separate start_date / target_date spreadsheet columns; the same
  // shared editor edits the pair (echoing the unchanged half back), so each cell
  // opens the range editor and persists both halves in one commit — identical to
  // TasksList. The editor speaks ISO; tasks carry epoch-ms, so convert at the
  // boundary (matches TaskDetailCard / TaskCard / TasksList).
  function msToIso(ms: number | null | undefined): string | null {
    return ms == null ? null : new Date(ms).toISOString();
  }
  function isoToMs(iso: string | null): number | null {
    if (!iso) return null;
    const ms = new Date(iso).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  function dateRangeOf(task: Task): DateRange {
    return { startDate: msToIso(task.startDate), dueAt: msToIso(task.dueAt) };
  }
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
  // The Start column is a single-date cell (Plane's start_date column shows ONLY
  // the start), so it writes just `startDate` via a native date input. The Due
  // column keeps the combined DateRangeDropdown (overdue tint), matching the list.
  function saveStart(task: Task, value: string): void {
    const next = dueFromInputValue(value);
    if (next === (task.startDate ?? null)) return;
    void commit(task, { startDate: next }, { startDate: next } as Partial<Task>);
  }

  // ── Labels via the shared LabelDropdown ────────────────────────────────────
  // updateTask persists labels by NAME (auto-created), not id; map the editor's
  // chosen ids back through the loaded catalog for the commit, while the optimistic
  // patch carries the id set the editor speaks. (Mirrors TaskCard / TaskDetailCard.)
  function labelIdsToNames(ids: string[]): string[] {
    return ids
      .map((id) => labels.find((l) => l.id === id)?.name)
      .filter((n): n is string => Boolean(n));
  }
  function saveLabels(task: Task, ids: string[]): void {
    void commit(task, { labels: labelIdsToNames(ids) }, { labelIds: ids } as Partial<Task>);
  }

  // Date column shows a "Mon D, YYYY" read-only label (Created / Updated).
  function dateLabel(ts: number | null | undefined): string {
    if (!ts) return "";
    return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }

  // ONE shared "Delete task" confirmation for the whole sheet (not one-per-row):
  // a row's "…" menu sets the target task and opens it. The board drops the row
  // live via the tasks_changed "deleted" broadcast, so there's no manual prune.
  let deleteTarget = $state<Task | null>(null);
  let showDelete = $state(false);
  function askDelete(task: Task): void {
    deleteTarget = task;
    showDelete = true;
  }
</script>

<div class={sheetWrapper} onscroll={onScroll}>
  <table class={sheetTable}>
    <colgroup>
      <col style="width:{keyWidth}px" />
      {#each COLS as col (col.id)}
        <col style="width:{widths[col.id]}px" />
      {/each}
    </colgroup>

    <!-- ── Header row (sticky-top; KEY corner sticky-top+left) ── -->
    <thead class={sheetHeadRow}>
      <tr>
        <th scope="col" class={sheetHeadKeyCell} style="width:{keyWidth}px">
          <span class="flex items-center">
            <span class="truncate">Title</span>
          </span>
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <span
            class={sheetResizeHandle}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize title column"
            onpointerdown={(e) => startResize(e, "__key__")}
            onpointermove={moveResize}
            onpointerup={endResize}
            onpointercancel={endResize}
          ></span>
        </th>

        {#each COLS as col (col.id)}
          {@const glyph = sortGlyph(col)}
          <th scope="col" class={sheetHeadCell} style="width:{widths[col.id]}px">
            {#if col.sort}
              <button
                type="button"
                onclick={() => sortBy(col)}
                aria-label={`Sort by ${col.label}`}
                class="flex w-full items-center text-left text-content-dim transition-colors hover:text-content focus-ring"
              >
                <span class="truncate">{col.label}</span>
                {#if glyph}
                  <span class={sheetSortIndicator} aria-hidden="true">
                    {glyph === "asc" ? "↑" : "↓"}
                  </span>
                {/if}
              </button>
            {:else}
              <span class="flex w-full items-center truncate">{col.label}</span>
            {/if}

            <!-- Right-edge resize handle (hover-revealed). -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <span
              class={sheetResizeHandle}
              role="separator"
              aria-orientation="vertical"
              aria-label={`Resize ${col.label} column`}
              onpointerdown={(e) => startResize(e, col.id)}
              onpointermove={moveResize}
              onpointerup={endResize}
              onpointercancel={endResize}
            ></span>
          </th>
        {/each}
      </tr>
    </thead>

    <tbody>
      {#each rows as task (task.id)}
        {@const isPending = pendingIds.has(task.id)}
        {@const showId = isDisplayed(preferencesState.tasksDisplay, "taskId")}
        {@const isPeeked = taskDetail.openId === task.id}
        <!-- issue-row.tsx:94-98 — the virtualized <tr> shell: no geometry of its
             own; the peeked row gets Plane's `selected-issue-row` group marker so
             the inner cell <Row>s can tint via `group-[.selected-issue-row]:*`. -->
        <tr class={cn(sheetRow, isPeeked && sheetRowSelected, isPending && "opacity-60")}>
          <!-- issue-row.tsx:263-285 — the STICKY-LEFT first <td>: a bare
               positioning shell (`group/list-block relative left-0 z-10 max-w-lg
               md:sticky`). The h-11 + border-r + bottom hairline + peeked/scrolled
               states all live on the inner <Row>. Holds the IDENTIFIER (the KEY,
               min-w-24) and the WORK-ITEM (title, min-w-60 with key / min-w-[360px]
               without) sub-sections. Title click → peek. -->
          <td class={sheetKeyCell} style="width:{keyWidth}px">
            <!-- issue-row.tsx:277 — the inner <Row>: h-11, right hairline, bottom
                 hairline (swapped for an accent border when peeked), and the
                 horizontal-scroll shadow once the sheet is scrolled sideways. -->
            <div
              class={cn(
                sheetKeyInner,
                isPeeked && sheetKeyInnerPeeked,
                isScrolled && sheetKeyInnerScrolled,
              )}
            >
              <!-- issue-row.tsx:311-337 — the hover-revealed multi-select checkbox,
                   pinned `absolute left-1`, revealed via group/list-block.
                   Decorative here (no bulk-select yet); stopPropagation so toggling
                   never opens the peek. -->
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <span
                class={sheetKeySelect}
                role="presentation"
                onclick={(e) => e.stopPropagation()}
              >
                <span class={checkBoxBase} aria-hidden="true"></span>
              </span>

              <!-- issue-row.tsx:287-301 — the IDENTIFIER sub-section (the work-item
                   KEY, min-w-24, text-11), display-gated. -->
              {#if showId}
                <span class={sheetKeyIdentifier}>
                  {taskKey(task.sequenceId, task.id, projectIdentifier)}
                </span>
              {/if}

              <!-- issue-row.tsx:304-372 — the WORK-ITEM sub-section: flex-grows,
                   min-w-60 when the key shows / min-w-[360px] when it doesn't. Holds
                   the sub-issue chevron spacer, the clickable title, and the
                   hover-revealed "…" quick-actions. -->
              <div class={showId ? sheetKeyWorkItem : sheetKeyWorkItemNoKey}>
                <!-- issue-row.tsx:343-358 — the sub-issue expand-toggle slot. This
                     flat (ungrouped, no-expansion) spreadsheet has no sub-issue
                     tree, so the slot stays an empty 16px spacer to keep the title
                     column aligned element-for-element with Plane. -->
                <span class={sheetKeyChevron} aria-hidden="true"></span>

                <!-- issue-row.tsx:360-372 — the clickable title (truncate, pr-4). -->
                <button
                  type="button"
                  onclick={() => open(task.id)}
                  class={sheetKeyTitle}
                  title={task.title}
                >
                  {task.title}
                </button>

                <!-- issue-row.tsx:373-384 — the hover-revealed quick-actions ("…").
                     Portal'd menu with a destructive Delete; Plane's MoreHorizontal
                     glyph (h-3.5 w-3.5). -->
                <DropdownMenu>
                  <DropdownMenuTrigger
                    title="More actions"
                    aria-label="More actions"
                    disabled={isPending}
                    class={sheetKeyAction}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
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
              </div>
            </div>
          </td>

          <!-- ── State (data-driven StateDropdown, else legacy Select) ── -->
          <td class={sheetCell}>
            {#if states.length > 0}
              <StateDropdown
                value={task.stateId ?? null}
                options={states}
                variant="row"
                disabled={isPending}
                onChange={(id) => saveState(task, id)}
                class="h-full w-full px-3"
              />
            {:else}
              <Select.Root
                type="single"
                value={task.status}
                onValueChange={(v) => saveStatus(task, v)}
              >
                <Select.Trigger
                  aria-label="Change status"
                  disabled={isPending}
                  class={cn(sheetCellTrigger, "disabled:opacity-50")}
                >
                  {statusLabel(task.status)}
                </Select.Trigger>
                <Select.Content>
                  {#each STATUS_OPTIONS as s (s.value)}
                    <Select.Item value={s.value} label={s.label}>{s.label}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
            {/if}
          </td>

          <!-- ── Priority (shared PriorityDropdown) ── -->
          <td class={sheetCell}>
            <PriorityDropdown
              value={priorityForTask(task)}
              variant="row"
              disabled={isPending}
              onChange={(p) => savePriority(task, p)}
              class="h-full w-full px-3"
            />
          </td>

          <!-- ── Assignee (shared AssigneeDropdown) ── -->
          <td class={sheetCell}>
            <AssigneeDropdown
              value={task.assigneeId}
              {pools}
              variant="row"
              disabled={isPending}
              onChange={(v) => saveAssignee(task, v)}
              class="h-full w-full px-3"
            />
          </td>

          <!-- ── Start date (single-date cell; native input → startDate only) ── -->
          <td class={sheetCell}>
            <input
              type="date"
              value={dueToInputValue(task.startDate)}
              onchange={(e) => saveStart(task, e.currentTarget.value)}
              disabled={isPending}
              aria-label={task.startDate ? "Change start date" : "Set start date"}
              class={cn(sheetCellTrigger, "bg-transparent disabled:opacity-50")}
            />
          </td>

          <!-- ── Due date (shared DateRangeDropdown; combined editor, overdue tint) ── -->
          <td class={sheetCell}>
            <DateRangeDropdown
              value={dateRangeOf(task)}
              variant="row"
              disabled={isPending}
              placeholder="Due date"
              onChange={(r) => saveDates(task, r)}
              class="h-full w-full px-3"
            />
          </td>

          <!-- ── Labels (shared LabelDropdown; read-only when no catalog) ── -->
          <td class={sheetCell}>
            {#if labels.length > 0}
              <LabelDropdown
                value={task.labelIds ?? []}
                options={labels}
                variant="row"
                disabled={isPending}
                onChange={(ids) => saveLabels(task, ids)}
                class="h-full w-full px-3"
              />
            {:else}
              <span class="flex h-full items-center px-3 text-content-muted">—</span>
            {/if}
          </td>

          <!-- ── Relation counts (real 0 placeholder; relations land in a later phase) ── -->
          <td class={sheetCell}>
            <span class="flex h-full items-center px-3 tabular-nums text-content-muted">0</span>
          </td>
          <td class={sheetCell}>
            <span class="flex h-full items-center px-3 tabular-nums text-content-muted">0</span>
          </td>
          <td class={sheetCell}>
            <span class="flex h-full items-center px-3 tabular-nums text-content-muted">0</span>
          </td>

          <!-- ── Created / Updated (read-only date labels) ── -->
          <td class={sheetCell}>
            <span class="flex h-full items-center px-3 text-content-muted">{dateLabel(task.createdAt)}</span>
          </td>
          <td class={sheetCell}>
            <span class="flex h-full items-center px-3 text-content-muted">{dateLabel(task.updatedAt)}</span>
          </td>
        </tr>
      {/each}

      <!-- Empty state: a Plane-style "+ New issue" trailing row when there are no tasks. -->
      {#if rows.length === 0}
        <tr>
          <td class={sheetCell} colspan={COLS.length + 1}>
            <button
              type="button"
              onclick={() => oncreate?.()}
              class="flex h-full w-full items-center gap-1.5 px-3 text-left text-accent hover:underline"
            >
              + New issue
            </button>
          </td>
        </tr>
      {/if}
    </tbody>
  </table>
</div>

<!-- ONE shared "Delete task" confirmation for the whole sheet, driven by the row
     "…" menus. Portals to <body>; the board drops the row live via the
     tasks_changed "deleted" broadcast. -->
{#if deleteTarget}
  <DeleteTaskDialog bind:open={showDelete} {workspaceId} task={deleteTarget} />
{/if}
