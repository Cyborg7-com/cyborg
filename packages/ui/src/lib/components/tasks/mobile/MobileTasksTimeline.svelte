<script lang="ts">
  // WS4 — the mobile Tasks GANTT layout, degraded to a READ-ONLY TIMELINE list.
  // The desktop gantt is a horizontal scrollable chart with a pixel ruler and
  // edge-drag-to-reschedule bars; neither fits a phone. We re-present it as a
  // vertical list ordered by start date, where each row carries a NORMALIZED
  // [0,1] mini-bar spanning the task's [start..due] window within the visible
  // range — computed with our OWN fractional normalization (percentages), NOT
  // the desktop's dayLeftPx / DEFAULT_DAY_WIDTH / 28px pixel math. A "Today"
  // divider splits the rows whose start is in the past from today/upcoming, and a
  // faint per-row today tick marks where "now" falls across each bar.
  //
  // READ-ONLY-DEGRADED (locked, v1): NO bars to drag, NO edge-resize, NO
  // redate-by-drag. Tapping a row opens the detail route; rescheduling happens in
  // the detail view's date picker, out of scope here. The view stays in the
  // layout switcher so the view count is honest.
  //
  // startDate is read DEFENSIVELY (startDateOf) — the UI Task may not surface it
  // on an older relay; a task with no start falls back to a single-day bar at its
  // due date, and a task with NEITHER date lists with no bar (no invented data).
  import { client } from "$lib/state/client.js";
  import { workspaceState } from "$lib/state/app.svelte.js";
  import { openTaskDetailMobileAware } from "$lib/tasks/openDetail.js";
  import { taskSpan, startOfDay, daysBetween, type GanttTaskInput } from "$lib/tasks/gantt.js";
  import { stateGroupForStatus, taskKey } from "$lib/tasks/detail.js";
  import { stateGroupColorVar } from "$lib/tasks/constants.js";
  import { type AssigneePools } from "$lib/tasks/assignee.js";
  import PullToRefresh from "$lib/components/PullToRefresh.svelte";
  import type { Task } from "$lib/core/types.js";
  import { cn } from "$lib/utils.js";

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
    // The gantt sidebar shows key + title + duration (no assignee), so the pools
    // are intentionally unused — kept on the frozen contract for prop-shape parity.
    pools: _pools,
    // Read-only view: no create affordance. Accepted for prop-shape parity only.
    oncreate: _oncreate,
  }: {
    workspaceId: string;
    tasks: Task[];
    pools: AssigneePools;
    oncreate?: (init?: TaskInit) => void;
  } = $props();

  const DAY_MS = 86_400_000;
  const today = Date.now();
  const todayStart = startOfDay(today);

  // Defensive startDate accessor (the UI Task type doesn't always surface it).
  function startDateOf(task: Task): number | null {
    const v = (task as { startDate?: number | null }).startDate;
    // Number.isFinite (not just typeof === "number") so NaN/Infinity can't reach
    // the sort comparator or a `left: NaN%` bar style. (Gemini PR #1075)
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  function toInput(task: Task): GanttTaskInput {
    return { id: task.id, startDate: startDateOf(task), dueAt: task.dueAt };
  }

  // Dated rows (a real [start..due] span), ordered by start then end. taskSpan
  // resolves the inclusive day-aligned window; a null span = no datable position.
  type DatedRow = { task: Task; startMs: number; endMs: number; dueOnly: boolean };
  const dated = $derived(
    tasks
      .map((task): DatedRow | null => {
        const span = taskSpan(toInput(task));
        return span ? { task, ...span } : null;
      })
      .filter((r): r is DatedRow => r != null)
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs),
  );
  // Tasks with no date list quietly at the foot (no bar) so they aren't lost.
  const undated = $derived(tasks.filter((t) => taskSpan(toInput(t)) == null));

  // The visible range = [earliest start, latest end] across dated tasks. We add
  // one DAY to the denominator so a single-day span still renders a visible bar
  // (start === end → non-zero width). null when there are no dated tasks.
  const range = $derived.by(() => {
    if (dated.length === 0) return null;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const d of dated) {
      if (d.startMs < min) min = d.startMs;
      if (d.endMs > max) max = d.endMs;
    }
    return { min, max, total: max - min + DAY_MS };
  });

  // Today fraction across the range (for the per-row today tick). Only shown when
  // "now" actually falls inside the visible window.
  const todayFrac = $derived(range ? (todayStart - range.min) / range.total : null);
  const todayInRange = $derived(todayFrac != null && todayFrac >= 0 && todayFrac <= 1);

  // Where the "Today" divider sits in the ordered list: before the first row that
  // starts today or later (dated.length when every row is in the past).
  const firstUpcoming = $derived.by(() => {
    const i = dated.findIndex((d) => d.startMs >= todayStart);
    return i === -1 ? dated.length : i;
  });

  // Fractional [0,1] bar geometry → percentages. A floor on the width keeps a
  // single-day bar visible/tappable; the left is clamped so the bar never spills
  // past the track's right edge.
  function bar(d: DatedRow): { left: number; width: number } {
    if (!range) return { left: 0, width: 100 };
    const left = ((d.startMs - range.min) / range.total) * 100;
    const spanMs = d.endMs - d.startMs + DAY_MS;
    const width = Math.max((spanMs / range.total) * 100, 6);
    return { left: Math.max(0, Math.min(left, 100 - width)), width };
  }

  // Inclusive whole-day duration label (matches the desktop gantt sidebar).
  function durationLabel(d: DatedRow): string {
    const days = daysBetween(d.startMs, d.endMs) + 1;
    return days === 1 ? "1 day" : `${days} days`;
  }

  // Bar fill = the task's STATE group color (token reference, never raw hex) —
  // the same coloring the desktop gantt uses.
  function stateColor(status: string): string {
    return stateGroupColorVar(stateGroupForStatus(status));
  }

  function shortDate(ms: number): string {
    return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
  }
  function shortKey(task: Task): string {
    return taskKey(task.sequenceId, task.id, null);
  }

  async function refresh(): Promise<void> {
    const fresh = await client.fetchTasks(workspaceId);
    if (workspaceState.current?.id === workspaceId) workspaceState.tasks = fresh;
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-surface">
  <!-- Range caption: the visible window the bars normalize against. -->
  {#if range}
    <div class="material-bar hairline-b flex shrink-0 items-center justify-between px-3 py-1.5 text-xs text-content-muted">
      <span class="tabular-nums">{shortDate(range.min)}</span>
      <span class="font-medium text-content-dim">Timeline</span>
      <span class="tabular-nums">{shortDate(range.max)}</span>
    </div>
  {/if}

  <!-- ONE scroll region, keyed rows, native scroll anchoring kept on (no
       overflow-anchor:none) so a live cyborg:tasks_changed insert never jumps. -->
  <PullToRefresh onRefresh={refresh}>
    <div class="pb-4">
      {#if dated.length === 0 && undated.length === 0}
        <div class="flex flex-col items-center justify-center gap-2 px-8 py-12 text-center">
          <p class="text-sm text-content-muted">No work items</p>
        </div>
      {/if}

      {#each dated as d, i (d.task.id)}
        {#if i === firstUpcoming}
          {@render todayDivider()}
        {/if}
        {@const geo = bar(d)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <button
          type="button"
          onclick={() => openTaskDetailMobileAware(d.task.id)}
          class="touch-target-row pressable-row flex w-full flex-col gap-1.5 px-3 py-2.5 text-left"
        >
          <div class="flex w-full min-w-0 items-center gap-2">
            <span class="shrink-0 text-xs tabular-nums text-content-muted">{shortKey(d.task)}</span>
            <span class="min-w-0 flex-1 truncate text-sm text-content">{d.task.title}</span>
            <span class="shrink-0 text-xs tabular-nums text-content-muted">{durationLabel(d)}</span>
          </div>
          <!-- Normalized [0,1] mini-bar within the visible range (NOT pixel/day
               math). The faint today tick marks "now" across the same track. -->
          <div class="relative h-2 w-full overflow-hidden rounded-full bg-surface-alt">
            <span
              class={cn("absolute inset-y-0 rounded-full", d.dueOnly && "opacity-70")}
              style:left={`${geo.left}%`}
              style:width={`${geo.width}%`}
              style:background-color={stateColor(d.task.status)}
              aria-hidden="true"
            ></span>
            {#if todayInRange && todayFrac != null}
              <span
                class="absolute inset-y-0 w-px bg-content/40"
                style:left={`${todayFrac * 100}%`}
                aria-hidden="true"
              ></span>
            {/if}
          </div>
        </button>
      {/each}

      <!-- Divider falls at the end when every dated row is in the past. -->
      {#if dated.length > 0 && firstUpcoming === dated.length}
        {@render todayDivider()}
      {/if}

      <!-- Undated tasks: listed without a bar (no invented dates). -->
      {#if undated.length > 0}
        <header class="px-3 pb-1.5 pt-4">
          <span class="text-sm font-semibold text-content-muted">No dates</span>
        </header>
        {#each undated as task (task.id)}
          <button
            type="button"
            onclick={() => openTaskDetailMobileAware(task.id)}
            class="touch-target-row pressable-row flex w-full items-center gap-2 px-3 py-2.5 text-left"
          >
            <span class="shrink-0 text-xs tabular-nums text-content-muted">{shortKey(task)}</span>
            <span class="min-w-0 flex-1 truncate text-sm text-content">{task.title}</span>
          </button>
        {/each}
      {/if}
    </div>
  </PullToRefresh>
</div>

{#snippet todayDivider()}
  <div class="flex items-center gap-2 px-3 py-2">
    <span class="size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true"></span>
    <span class="text-xs font-semibold uppercase tracking-wide text-accent">Today</span>
    <span class="h-px min-w-0 flex-1 bg-accent/30"></span>
  </div>
{/snippet}
