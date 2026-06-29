<script lang="ts">
  // The Tasks GANTT layout, ported to Plane's gantt-chart look via the shared
  // Tasks foundation (lib/tasks/ui.ts) + the pure timeline math (lib/tasks/gantt.ts).
  // A frozen left sidebar lists every task (key + name + a "{N} day(s)" duration
  // label) row-for-row (44px Plane BLOCK_HEIGHT) against a right-hand scrollable
  // timeline: a sticky two-tier ruler (month band over a day band), one lane per
  // task, and a draggable bar per task spanning startDate→dueAt. Each bar is
  // STATE-colored (Plane's per-state block fill) with a translucent wash so the
  // name label stays legible on any hue. A task with only a due date shows a
  // single-day bar at the due date; a task with NEITHER date lists in the sidebar
  // with an empty lane (no bar) — no invented data. A vertical "today" line marks
  // the current day.
  //
  // Interactions match the shared contract:
  //   - clicking a sidebar row OR a bar opens the in-board peek via
  //     openTaskDetail(task.id) (NOT a route navigation), same as TasksBoard.
  //   - dragging a bar's LEFT edge edits startDate; the RIGHT edge edits dueAt;
  //     both persist via client.updateTask(workspaceId, taskId, {...}) on release.
  //   - GROUP BY is accepted for prop-shape parity but ignored: the gantt
  //     positions tasks purely by their dates, like Plane's gantt layout.
  //
  // Every visual flows through an app.css token (the ui.ts gantt constants), so
  // dark + light both resolve; no hardcoded colors. Inline styles are limited to
  // pure geometry (bar left/width, the today line's x) plus the bar's state-color
  // FILL — which is itself a token reference (var(--state-*)), never a raw hex.
  import { toast } from "svelte-sonner";
  import { openTaskDetail, taskDetail } from "$lib/tasks/detailStore.svelte.js";
  import { client } from "$lib/state/client.js";
  import { type AssigneePools } from "$lib/tasks/assignee.js";
  import { stateGroupForStatus } from "$lib/tasks/detail.js";
  import { stateGroupColorVar } from "$lib/tasks/constants.js";
  import type { GroupBy } from "$lib/tasks/view.js";
  import {
    barGeometry,
    chartWidthPx,
    daysBetween,
    DEFAULT_DAY_WIDTH,
    dayLeftPx,
    ganttDayTicks,
    ganttMonthBands,
    ganttRange,
    type GanttTaskInput,
    pxToDay,
  } from "$lib/tasks/gantt.js";
  import {
    ganttWrapper,
    ganttSidebar,
    ganttSidebarHeader,
    ganttSidebarRow,
    ganttSidebarKey,
    ganttSidebarDuration,
    ganttTimeline,
    ganttRuler,
    ganttRulerMonth,
    ganttRulerDay,
    ganttRow,
    ganttBar,
    ganttBarOverlay,
    ganttBarLabel,
    ganttBarDragging,
    ganttBarHandle,
    ganttBarHandleStart,
    ganttBarHandleEnd,
    ganttTodayLine,
  } from "$lib/tasks/ui.js";
  import type { Task } from "$lib/core/types.js";
  import { cn } from "$lib/utils.js";

  let {
    workspaceId,
    tasks,
    // Accepted for prop-shape parity with the other layouts. Plane's gantt sidebar
    // shows the work-item key + name + duration (no assignee avatar), so the pools
    // are intentionally unused here.
    pools: _pools,
    // Accepted for prop-shape parity with the other layouts; the gantt positions
    // tasks by date, not by group, so it is intentionally unused here.
    groupBy: _groupBy = "status",
    // Accepted for parity (the toolbar passes it to every layout). The gantt has
    // no per-lane quick-add affordance, so it is intentionally unused.
    oncreate: _oncreate,
  }: {
    workspaceId: string;
    tasks: Task[];
    pools: AssigneePools;
    groupBy?: GroupBy;
    oncreate?: (initialValues?: {
      status?: string;
      assigneeId?: string | null;
      priority?: string;
      dueAt?: number | null;
    }) => void;
  } = $props();

  const DAY_WIDTH = DEFAULT_DAY_WIDTH;

  // The frozen-sidebar width (px). Plane offsets the bar's sticky name label by
  // SIDEBAR_WIDTH (360) so the name stays readable as the bar scrolls under the
  // sidebar. Our sidebar is narrower (ganttSidebar = w-[260px]); the label's
  // sticky-left offset must equal OUR width, not Plane's hardcoded 360.
  const SIDEBAR_WIDTH = 260;

  // The UI Task type does not (yet) surface `startDate`, but the server persists
  // it (PHASE 0 schema). Read it defensively off the task so the bar can span a
  // real start when present and the right RPC field name is used on drag. A task
  // without it falls back to a single-day bar at dueAt.
  function startDateOf(task: Task): number | null {
    const v = (task as { startDate?: number | null }).startDate;
    return typeof v === "number" ? v : null;
  }

  function toInput(task: Task): GanttTaskInput {
    return { id: task.id, startDate: startDateOf(task), dueAt: task.dueAt };
  }

  // The chart range + ruler ticks are derived from every task's dates (padded,
  // day-aligned). `now` recomputes are fine — Date.now() inside a $derived ties
  // the today line to the current day without a timer (re-renders refresh it).
  const inputs = $derived(tasks.map(toInput));
  const range = $derived(ganttRange(inputs));
  const dayTicks = $derived(ganttDayTicks(range));
  const monthBands = $derived(ganttMonthBands(range, DAY_WIDTH));
  const trackWidth = $derived(chartWidthPx(range, DAY_WIDTH));
  const todayLeft = $derived(dayLeftPx(Date.now(), range, DAY_WIDTH));

  // Per-task bar geometry, keyed by id, so the lanes render in the SAME order as
  // the sidebar rows (both iterate `tasks`). null = no bar (undated task).
  const geometryById = $derived(
    new Map(inputs.map((i) => [i.id, barGeometry(i, range, DAY_WIDTH)] as const)),
  );

  // The bar fill color for a task — Plane colors each gantt bar by its STATE
  // (not a flat accent). The UI Task carries a bare lifecycle `status`; map it to
  // its Plane state GROUP and resolve the group's seed token to a CSS color value,
  // token-only (a var(--state-*) reference, ZERO raw hex).
  function stateColor(status: string): string {
    return stateGroupColorVar(stateGroupForStatus(status));
  }

  // Plane fades a bar that is missing one of its dates: getBlockViewDetails
  // applies a maskImage `linear-gradient(to right|left, color 50%, transparent
  // 95%)` so an incomplete bar fades at its OPEN end (utils.tsx:695-702). A bar
  // with only a START date fades to the right (open future end); a bar with only
  // a DUE date fades to the left (open past end). Both-dated bars carry no mask.
  function maskGradient(task: Task): string | undefined {
    const hasStart = startDateOf(task) != null;
    const hasDue = task.dueAt != null;
    if (hasStart === hasDue) return undefined; // both set or neither — no fade
    const dir = hasStart ? "to right" : "to left";
    return `linear-gradient(${dir}, black 50%, transparent 95%)`;
  }

  // The short work-item KEY shown in the sidebar (Plane's IssueIdentifier). The
  // UI Task does not carry a project identifier/sequenceId here, so we show a
  // stable short id slice.
  function shortKey(task: Task): string {
    return `#${task.id.slice(0, 8)}`;
  }

  // The whole-day span of a task's bar (inclusive), for the sidebar's "{N} day(s)"
  // duration label (Plane shows the duration beside each sidebar row). Undated
  // tasks have no bar and no duration. Reads the same geometry the lanes render.
  function durationLabel(taskId: string): string | null {
    const geo = geometryById.get(taskId) ?? null;
    if (!geo) return null;
    const days = daysBetween(geo.startMs, geo.endMs) + 1;
    return days === 1 ? "1 day" : `${days} days`;
  }

  // Optimistic in-flight set so a bar mid-persist reads as busy and a second
  // drag can't race it.
  let pendingIds = $state<Set<string>>(new Set());

  function open(taskId: string): void {
    // The in-board editable "peek" (single shared-store modal), NOT a route nav.
    openTaskDetail(taskId);
  }

  // ── Edge-drag to edit dates ────────────────────────────────────────────────
  // A pointer-driven drag on a bar edge. We track the live day under the pointer
  // and only commit (one updateTask) on pointerup, so a drag is a single RPC.
  // The timeline element is the coordinate frame: pointer clientX minus the
  // track's left (accounting for horizontal scroll) → px → day via pxToDay.
  let dragging = $state<{
    taskId: string;
    edge: "start" | "end";
    // The day currently under the pointer (local-midnight ms), for a live preview.
    day: number;
  } | null>(null);

  let timelineEl: HTMLDivElement | null = null;

  function pointerDay(event: PointerEvent): number {
    if (!timelineEl) return range.startMs;
    const rect = timelineEl.getBoundingClientRect();
    // clientX → x within the scrolled track.
    const x = event.clientX - rect.left + timelineEl.scrollLeft;
    return pxToDay(x, range, DAY_WIDTH);
  }

  function onHandleDown(event: PointerEvent, task: Task, edge: "start" | "end"): void {
    // Don't open the peek when grabbing a handle; don't start a second drag.
    event.stopPropagation();
    event.preventDefault();
    if (pendingIds.has(task.id)) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragging = { taskId: task.id, edge, day: pointerDay(event) };
  }

  function onHandleMove(event: PointerEvent): void {
    if (!dragging) return;
    dragging = { ...dragging, day: pointerDay(event) };
  }

  async function onHandleUp(event: PointerEvent, task: Task): Promise<void> {
    if (!dragging || dragging.taskId !== task.id) return;
    const { edge, day } = dragging;
    dragging = null;
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      // capture may already be lost (e.g. pointercancel) — ignore.
    }

    // No-op guard: dropping on the same day the edge already sits on.
    const existingStart = startDateOf(task);
    if (edge === "start" && existingStart != null && day === existingStart) return;
    if (edge === "end" && task.dueAt != null && day === task.dueAt) return;

    // Left edge → startDate; right edge → dueAt. Keep the span non-inverted: a
    // start dragged past the due clamps to the due day, and vice versa.
    const updates: { startDate?: number; dueAt?: number } = {};
    if (edge === "start") {
      updates.startDate = task.dueAt != null ? Math.min(day, task.dueAt) : day;
    } else {
      updates.dueAt = existingStart != null ? Math.max(day, existingStart) : day;
    }

    pendingIds = new Set(pendingIds).add(task.id);
    try {
      // `startDate` is forward-compatible on the RPC; the cast keeps us off the
      // not-yet-widened UI updates type without inventing a field.
      await client.updateTask(
        workspaceId,
        task.id,
        updates as Parameters<typeof client.updateTask>[2],
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update the dates");
    } finally {
      const next = new Set(pendingIds);
      next.delete(task.id);
      pendingIds = next;
    }
  }

  // Live preview geometry while dragging: recompute the bar from the in-flight
  // edge day so the user sees the bar follow the pointer before the RPC lands.
  function previewGeometry(task: Task): ReturnType<typeof barGeometry> {
    const base = geometryById.get(task.id) ?? null;
    if (!dragging || dragging.taskId !== task.id) return base;
    const start = startDateOf(task);
    const input: GanttTaskInput =
      dragging.edge === "start"
        ? { id: task.id, startDate: dragging.day, dueAt: task.dueAt }
        : { id: task.id, startDate: start, dueAt: dragging.day };
    return barGeometry(input, range, DAY_WIDTH);
  }
</script>

<!-- Plane gantt-chart: frozen sidebar (left) + scrollable timeline (right). The
     two scroll independently on X; the sidebar scrolls on Y with the timeline is
     NOT wired (each has its own overflow) — Plane keeps the row heights identical
     (the gantt BLOCK_HEIGHT, 44px / h-11) so they stay visually aligned as you
     scroll the timeline vertically. -->
<div class={ganttWrapper}>
  <!-- LEFT: issue sidebar. One row per task — Plane shows the work-item key + name
       + a trailing "{N} day(s)" duration label. Clickable → peek. -->
  <aside class={ganttSidebar}>
    <div class={ganttSidebarHeader}>Issue</div>
    {#each tasks as task (task.id)}
      {@const duration = durationLabel(task.id)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <button type="button" class={cn(ganttSidebarRow, "w-full text-left", taskDetail.openId === task.id && "bg-hover-gray")} onclick={() => open(task.id)} title={task.title}>
        <span class={ganttSidebarKey}>{shortKey(task)}</span>
        <span class="min-w-0 flex-1 truncate font-medium">{task.title}</span>
        {#if duration}
          <span class={ganttSidebarDuration}>{duration}</span>
        {/if}
      </button>
    {/each}
  </aside>

  <!-- RIGHT: the scrollable timeline pane. A single inner track sized to the full
       chart width holds the ruler, lanes, bars, and today line in one coordinate
       space, so they all scroll together horizontally. -->
  <div class={ganttTimeline} bind:this={timelineEl}>
    <div class="relative" style:width={`${trackWidth}px`}>
      <!-- Sticky two-tier ruler: month band over the day band. -->
      <div class={ganttRuler}>
        <!-- Month band: each month spans its day cells. -->
        <div class="relative h-6">
          {#each monthBands as band (band.key)}
            <div class={cn(ganttRulerMonth, "absolute top-0")} style:left={`${band.leftPx}px`} style:width={`${band.widthPx}px`}>
              <span class="truncate">{band.label}</span>
            </div>
          {/each}
        </div>
        <!-- Day band: one fixed-width cell per day. -->
        <div class="flex h-6">
          {#each dayTicks as tick (tick.ms)}
            <div class={cn(ganttRulerDay, tick.isWeekend && "bg-surface-alt", tick.isToday && "text-accent font-semibold")} style:width={`${DAY_WIDTH}px`}>
              {tick.day}
            </div>
          {/each}
        </div>
      </div>

      <!-- Lanes + bars: one lane per task, row-for-row with the sidebar. -->
      <div class="relative">
        {#each tasks as task (task.id)}
          {@const geo = previewGeometry(task)}
          {@const isDragging = dragging?.taskId === task.id}
          <div class={ganttRow}>
            {#if geo}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class={cn(ganttBar, isDragging && ganttBarDragging, pendingIds.has(task.id) && "opacity-70")}
                style:left={`${geo.leftPx}px`}
                style:width={`${geo.widthPx}px`}
                style:background-color={stateColor(task.status)}
                style:mask-image={maskGradient(task)}
                style:-webkit-mask-image={maskGradient(task)}
                role="button"
                tabindex="0"
                title={task.title}
                onclick={() => open(task.id)}
                onkeydown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    open(task.id);
                  }
                }}
              >
                <!-- Translucent wash over the state color so the label reads on any
                     hue (Plane's bg-surface-1/50 overlay). -->
                <span class={ganttBarOverlay} aria-hidden="true"></span>
                <!-- Sticky name label, offset by the sidebar width so it stays
                     readable as the bar scrolls under the frozen sidebar (Plane's
                     `left=SIDEBAR_WIDTH`). -->
                <span class={ganttBarLabel} style:left={`${SIDEBAR_WIDTH}px`}>{task.title}</span>
                <!-- Left handle → startDate. Hidden for a due-only bar would still
                     let you ADD a start by dragging the left edge, so we keep it. -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <span
                  class={cn(ganttBarHandle, ganttBarHandleStart)}
                  aria-label="Drag to set start date"
                  onpointerdown={(e) => onHandleDown(e, task, "start")}
                  onpointermove={onHandleMove}
                  onpointerup={(e) => void onHandleUp(e, task)}
                ></span>
                <!-- Right handle → dueAt. -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <span
                  class={cn(ganttBarHandle, ganttBarHandleEnd)}
                  aria-label="Drag to set due date"
                  onpointerdown={(e) => onHandleDown(e, task, "end")}
                  onpointermove={onHandleMove}
                  onpointerup={(e) => void onHandleUp(e, task)}
                ></span>
              </div>
            {/if}
          </div>
        {/each}

        <!-- Vertical "today" line across every lane. -->
        <div class={ganttTodayLine} style:left={`${todayLeft}px`}></div>
      </div>
    </div>
  </div>
</div>
