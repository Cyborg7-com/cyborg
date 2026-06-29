<script lang="ts">
  // The Tasks CALENDAR layout, ported to Plane's calendar-chart look via the
  // shared Tasks foundation (lib/tasks/ui.ts) + the pure month math
  // (lib/tasks/calendar.ts). It renders a month grid: a Sunday-first weekday
  // header strip over a fixed 6-week × 7-day body. Each task is placed on the
  // tile of its dueAt's local day as a small COMPACT clickable chip (Plane's
  // calendar/issue-block: a thin vertical STATE color stripe + the work-item key
  // + the title, in a dense h-8 pill). Today's tile highlights its number;
  // out-of-month spill days dim. Every surface maps through an app.css token so
  // dark AND light both resolve (no hardcoded colors).
  //
  // Interactions (Plane-faithful):
  //   - clicking a chip opens the in-place SIDE-PEEK (detailStore.openTaskDetail),
  //     not a route navigation — same as the board/list;
  //   - a hover-revealed per-tile "+" emits oncreate({ dueAt: end-of-that-day })
  //     so a task created from a tile lands due on that day (Plane's calendar
  //     quick-add);
  //   - dragging a chip onto another tile RE-DATES it: dueAt is persisted to that
  //     day's local end-of-day via client.updateTask, with an optimistic patch of
  //     workspaceState.tasks (revert + toast on failure), mirroring the list view.
  //
  // Tasks with no dueAt are not placed on the grid; they surface in a quiet
  // "Unscheduled" footer affordance (count + click to peek) so they aren't lost.
  // groupBy is accepted for prop-shape parity with the board/list but ignored —
  // the calendar positions tasks by date, not by the active grouping.
  import { toast } from "svelte-sonner";
  import { client } from "$lib/state/client.js";
  import { workspaceState } from "$lib/state/app.svelte.js";
  import { openTaskDetail, taskDetail } from "$lib/tasks/detailStore.svelte.js";
  import { resolveAssignee, type AssigneePools } from "$lib/tasks/assignee.js";
  import { stateGroupForStatus } from "$lib/tasks/detail.js";
  import { stateGroupColorVar } from "$lib/tasks/constants.js";
  import { type GroupBy } from "$lib/tasks/view.js";
  import {
    bucketByDay,
    buildMonth,
    dayKey,
    endOfDay,
    monthLabel,
    nextMonth,
    prevMonth,
    thisMonth,
    WEEKDAY_LABELS,
    type CalendarDay,
  } from "$lib/tasks/calendar.js";
  import {
    calContainer,
    calWeekHeader,
    calWeekHeaderCell,
    calGrid,
    calDayTile,
    calDayOutMonth,
    calDayNumber,
    calDayToday,
    calAddButton,
    calIssueChip,
    calIssueChipInner,
    calIssueChipLeft,
    calIssueChipDragging,
    calIssueStripe,
    calIssueKey,
    calIssueTitle,
    calIssueChipActions,
    calMoreLink,
    columnCollapseBtn,
  } from "$lib/tasks/ui.js";
  import type { Task } from "$lib/core/types.js";
  import { cn } from "$lib/utils.js";

  let {
    workspaceId,
    tasks,
    pools,
    // Accepted for prop-shape parity with the board/list; the calendar positions
    // by date and ignores the active grouping. Renamed to `_groupBy` so it reads
    // as intentionally-unused (matches the spreadsheet layout's convention).
    groupBy: _groupBy = "status",
    oncreate,
  }: {
    workspaceId: string;
    tasks: Task[];
    pools: AssigneePools;
    groupBy?: GroupBy;
    // Per-tile quick-add seeds dueAt with the clicked day's end-of-day. The shape
    // matches the shared layout contract (status/assignee/priority/dueAt); the
    // calendar only ever fills dueAt.
    oncreate?: (initialValues?: {
      status?: string;
      assigneeId?: string | null;
      priority?: string;
      dueAt?: number | null;
    }) => void;
  } = $props();

  // The leading STATE color for a chip's vertical stripe (Plane's calendar chip
  // leads with a thin state-colored accent stripe, not a dot). The task carries a
  // bare lifecycle `status`; map it to its Plane state GROUP and resolve the
  // group's seed token to a CSS color value — token-only (a var(--state-*)
  // reference, ZERO raw hex), exactly how StateGroupIcon tints its glyph.
  function stateColor(status: string): string {
    return stateGroupColorVar(stateGroupForStatus(status));
  }

  // The short work-item KEY shown ahead of the title (Plane's IssueIdentifier).
  // The UI Task does not carry a project identifier/sequenceId here, so we show a
  // stable short id slice — the same scannable "#xxxxxxxx" the gantt sidebar uses.
  function shortKey(task: Task): string {
    return `#${task.id.slice(0, 8)}`;
  }

  // Max chips shown per tile before the "+N more" overflow affordance. Clicking
  // "+N more" expands that one tile to show all its chips (Plane's behavior).
  const MAX_CHIPS = 3;

  // The displayed month anchor (1st of the month). Pages via prev/next/today.
  // Initialized to the current month; `today` drives the today highlight.
  const today = Date.now();
  let anchor = $state(thisMonth(today));

  const month = $derived(buildMonth(anchor, today));
  const buckets = $derived(bucketByDay(tasks, (t) => t.dueAt));
  const unscheduled = $derived(buckets.unscheduled);

  // Tiles the user has expanded past MAX_CHIPS (local UI state, keyed by dayKey).
  let expanded = $state<Set<string>>(new Set());
  function expandTile(key: string): void {
    expanded = new Set(expanded).add(key);
  }

  // Drag state: which task is being dragged, and which tile is the hover target.
  let draggingId = $state<string | null>(null);
  let dragOverKey = $state<string | null>(null);
  let pendingIds = $state<Set<string>>(new Set());

  function tasksForDay(day: CalendarDay): Task[] {
    return buckets.byDay.get(dayKey(day.date)) ?? [];
  }

  // Re-date a dropped task to `day` (local end-of-day) with the same optimistic
  // pattern as TasksList.commit: patch workspaceState immediately, RPC, reconcile
  // with the server row, revert + toast on failure.
  async function moveTaskToDay(task: Task, day: CalendarDay): Promise<void> {
    const nextDue = endOfDay(day.date);
    if (task.dueAt === nextDue || pendingIds.has(task.id)) return;
    const prev = task;
    pendingIds = new Set(pendingIds).add(task.id);
    workspaceState.tasks = workspaceState.tasks.map((t) =>
      t.id === task.id ? { ...t, dueAt: nextDue } : t,
    );
    try {
      const updated = await client.updateTask(workspaceId, task.id, { dueAt: nextDue });
      workspaceState.tasks = workspaceState.tasks.map((t) => (t.id === updated.id ? updated : t));
    } catch (err) {
      workspaceState.tasks = workspaceState.tasks.map((t) => (t.id === prev.id ? prev : t));
      toast.error(err instanceof Error ? err.message : "Couldn't reschedule the task");
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

  function onDragOver(event: DragEvent, key: string): void {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    dragOverKey = key;
  }

  function onDrop(event: DragEvent, day: CalendarDay): void {
    event.preventDefault();
    const id = event.dataTransfer?.getData("text/plain") || draggingId;
    draggingId = null;
    dragOverKey = null;
    if (!id) return;
    const task = tasks.find((t) => t.id === id);
    if (task) void moveTaskToDay(task, day);
  }
</script>

<div class="flex h-full flex-col gap-2">
  <!-- Month header: prev / label / next + a "Today" jump. -->
  <div class="flex shrink-0 items-center gap-2">
    <button
      type="button"
      title="Previous month"
      aria-label="Previous month"
      class={columnCollapseBtn}
      onclick={() => (anchor = prevMonth(anchor))}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="15 18 9 12 15 6" />
      </svg>
    </button>
    <h2 class="min-w-[9rem] text-[14px] font-semibold text-content">{monthLabel(month)}</h2>
    <button
      type="button"
      title="Next month"
      aria-label="Next month"
      class={columnCollapseBtn}
      onclick={() => (anchor = nextMonth(anchor))}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>
    <button
      type="button"
      class="ml-1 rounded-[4px] border border-edge px-2 py-1 text-[12px] font-medium text-content-dim transition-colors hover:bg-hover-gray hover:text-content focus-ring"
      onclick={() => (anchor = thisMonth(today))}
    >
      Today
    </button>
  </div>

  <!-- The bordered month canvas: weekday header strip + the 7-col day grid. -->
  <div class={calContainer}>
    <div class={calWeekHeader}>
      {#each WEEKDAY_LABELS as label (label)}
        <div class={calWeekHeaderCell}>{label}</div>
      {/each}
    </div>

    <div class={calGrid}>
      {#each month.weeks as week, wi (wi)}
        {#each week as day (day.date)}
          {@const key = dayKey(day.date)}
          {@const dayTasks = tasksForDay(day)}
          {@const isExpanded = expanded.has(key)}
          {@const visible = isExpanded ? dayTasks : dayTasks.slice(0, MAX_CHIPS)}
          {@const overflow = dayTasks.length - visible.length}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class={cn(
              calDayTile,
              !day.inMonth && calDayOutMonth,
              dragOverKey === key && "ring-1 ring-accent ring-inset",
            )}
            ondragover={(e) => onDragOver(e, key)}
            ondragleave={() => {
              if (dragOverKey === key) dragOverKey = null;
            }}
            ondrop={(e) => onDrop(e, day)}
          >
            <!-- Top row: day-number (today = filled accent pill) + hover "+". -->
            <div class="flex items-center justify-between">
              {#if day.isToday}
                <span class={calDayToday}>{day.dayOfMonth}</span>
              {:else}
                <span class={calDayNumber}>{day.dayOfMonth}</span>
              {/if}
              {#if oncreate}
                <button
                  type="button"
                  title="Add task on this day"
                  aria-label={`Add task on day ${day.dayOfMonth}`}
                  class={calAddButton}
                  onclick={() => oncreate?.({ dueAt: endOfDay(day.date) })}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              {/if}
            </div>

            <!-- Chip stack: one mini-card per task due this day. -->
            <div class="flex min-h-0 flex-col gap-1 overflow-hidden">
              {#each visible as task (task.id)}
                {@const peeked = taskDetail.openId === task.id}
                <!-- Plane calendar/issue-block: an outer ControlLink (the
                     clickable block) wrapping an inner flex row that holds the
                     left cluster (stripe + key + title) and a hover-revealed
                     quick-actions slot. We use a div[role=button] so the actions
                     slot can be its own interactive element (Plane nests a button
                     inside the ControlLink). -->
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                  draggable="true"
                  role="button"
                  tabindex="0"
                  title={task.title}
                  class={cn(
                    calIssueChip,
                    peeked && "border-accent",
                    pendingIds.has(task.id) && "opacity-60",
                  )}
                  onclick={() => openTaskDetail(task.id)}
                  onkeydown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openTaskDetail(task.id);
                    }
                  }}
                  ondragstart={(e) => onDragStart(e, task.id)}
                  ondragend={onDragEnd}
                >
                  <div class={cn(calIssueChipInner, draggingId === task.id && calIssueChipDragging)}>
                    <!-- Left cluster: leading state stripe (a thin vertical accent
                         in the state's color, Plane's calendar chip) + the key +
                         the title, truncating as one. -->
                    <div class={calIssueChipLeft}>
                      <span class={calIssueStripe} style:background-color={stateColor(task.status)} aria-hidden="true"></span>
                      <span class={calIssueKey}>{shortKey(task)}</span>
                      <span class={calIssueTitle}>{task.title}</span>
                    </div>
                    <!-- Hover-revealed quick-actions slot (Plane's MoreHorizontal).
                         Stops propagation so it never opens the peek; opens the
                         task detail as the single available action. -->
                    <button
                      type="button"
                      title="Open task"
                      aria-label="Open task"
                      class={calIssueChipActions}
                      onclick={(e) => {
                        e.stopPropagation();
                        openTaskDetail(task.id);
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" />
                      </svg>
                    </button>
                  </div>
                </div>
              {/each}

              {#if overflow > 0}
                <button type="button" class={cn(calMoreLink, "text-left")} onclick={() => expandTile(key)}>
                  +{overflow} more
                </button>
              {/if}
            </div>
          </div>
        {/each}
      {/each}
    </div>
  </div>

  <!-- Unscheduled affordance: tasks with no dueAt aren't on the grid; surface
       them in a quiet footer so they aren't lost. Click a chip to peek. -->
  {#if unscheduled.length > 0}
    <div class="flex shrink-0 flex-wrap items-center gap-1.5 rounded-lg border border-edge bg-surface-alt px-2 py-1.5">
      <span class="text-[12px] font-medium text-content-dim">Unscheduled ({unscheduled.length})</span>
      {#each unscheduled as task (task.id)}
        {@const a = resolveAssignee(task.assigneeId, pools)}
        <button
          type="button"
          title={a ? `${task.title} · ${a.name}` : task.title}
          class={cn(calIssueChip, "w-auto max-w-[14rem]")}
          onclick={() => openTaskDetail(task.id)}
        >
          <div class={calIssueChipInner}>
            <div class={calIssueChipLeft}>
              <span class={calIssueStripe} style:background-color={stateColor(task.status)} aria-hidden="true"></span>
              <span class={calIssueKey}>{shortKey(task)}</span>
              <span class={calIssueTitle}>{task.title}</span>
            </div>
          </div>
        </button>
      {/each}
    </div>
  {/if}
</div>
