<script lang="ts">
  // WS4 — the mobile Tasks CALENDAR layout, degraded to a phone-native AGENDA.
  // The desktop calendar places tasks on a 6-week month grid; a phone can't show
  // that densely, so we re-present it as:
  //   • a compact, steppable MONTH OVERVIEW at the top (built from buildMonth
  //     verbatim) — each day tile carries a dot when it has work due; tapping a
  //     day opens a bottom-sheet DAY DRAWER listing that day's tasks plus a
  //     per-day "+ Add" that seeds dueAt = endOfDay(day);
  //   • a scrollable AGENDA below it: day-grouped sections (Overdue / Today /
  //     Tomorrow / each later dated day / Unscheduled), built with bucketByDay
  //     verbatim via buildAgendaSections. Rows are the shared TaskRowMobile (tap
  //     → the detail route); long-press is intentionally unused here (no quick
  //     edits on the agenda — reschedule happens in the detail date picker).
  //
  // READ-ONLY-DEGRADED (locked, v1): NO drag, NO redate-by-drag. The ONLY write
  // path is the day drawer's "+ Add" → oncreate({ dueAt }); rescheduling an
  // existing task is done in the detail view's date picker, out of scope here.
  //
  // Day-key discipline: the grid dots, the day drawer's task list, and the agenda
  // sections all bucket by the SAME local-day key (bucketByDay → dayKey), and the
  // "+ Add" seeds dueAt with the SAME endOfDay(day) the calendar uses — so a task
  // created from a day reliably lands in that day's drawer + agenda section once
  // the cyborg:tasks_changed broadcast updates the prop.
  import { client } from "$lib/state/client.js";
  import { workspaceState } from "$lib/state/app.svelte.js";
  import { openTaskDetailMobileAware } from "$lib/tasks/openDetail.js";
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
  import { buildAgendaSections } from "$lib/tasks/agenda.js";
  import { type AssigneePools } from "$lib/tasks/assignee.js";
  import TaskRowMobile from "./TaskRowMobile.svelte";
  import MobileSheet from "$lib/components/MobileSheet.svelte";
  import PullToRefresh from "$lib/components/PullToRefresh.svelte";
  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import PlusIcon from "@lucide/svelte/icons/plus";
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
    pools,
    oncreate,
  }: {
    workspaceId: string;
    tasks: Task[];
    pools: AssigneePools;
    oncreate?: (init?: TaskInit) => void;
  } = $props();

  // `today` is captured once at mount (matches the desktop calendar) — it drives
  // the today highlight + the agenda's relative sections; a re-render refreshes it.
  const today = Date.now();
  let anchor = $state(thisMonth(today));

  const month = $derived(buildMonth(anchor, today));
  // bucketByDay verbatim — the grid dots + the day drawer read from `byDay`.
  const buckets = $derived(bucketByDay(tasks, (t) => t.dueAt));
  // The agenda sections (reuses bucketByDay under the hood, same day key).
  const sections = $derived(buildAgendaSections(tasks, (t) => t.dueAt, today));

  function tasksForDay(day: CalendarDay): Task[] {
    return buckets.byDay.get(dayKey(day.date)) ?? [];
  }

  // The agenda rows hide the due chip: the section header (and the day drawer's
  // title) already encode the day, so the per-row "due" chip would be redundant.
  const rowDisplay = { dueAt: false };

  // ── Day drawer ─────────────────────────────────────────────────────────────
  let drawerDay = $state<CalendarDay | null>(null);
  let drawerOpen = $state(false);
  const drawerTasks = $derived(drawerDay ? tasksForDay(drawerDay) : []);

  function openDay(day: CalendarDay): void {
    drawerDay = day;
    drawerOpen = true;
  }
  // Null-safe (the drawer day is reassignable $state, so callbacks can't rely on
  // an {#if} narrowing): both helpers no-op on a null day.
  function drawerTitle(day: CalendarDay | null): string {
    if (!day) return "";
    return new Date(day.date).toLocaleDateString([], {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }
  // Per-day "+ Add": seed dueAt with this day's end-of-day (the SAME endOfDay the
  // calendar uses as the bucket day), close the drawer, hand off to the shared
  // create sheet. The new card lands in this day's section after the broadcast.
  function addOnDay(day: CalendarDay | null): void {
    if (!day) return;
    drawerOpen = false;
    oncreate?.({ dueAt: endOfDay(day.date) });
  }

  // Pull-to-refresh: re-fetch the workspace's tasks (the SAME gated RPC the boot
  // path uses — no visibility bypass). The page re-narrows to this project.
  async function refresh(): Promise<void> {
    const fresh = await client.fetchTasks(workspaceId);
    if (workspaceState.current?.id === workspaceId) workspaceState.tasks = fresh;
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-surface">
  <!-- Compact month stepper (pinned above the scroll region). -->
  <div class="material-bar hairline-b flex shrink-0 items-center gap-1 px-2 py-1.5">
    <button
      type="button"
      onclick={() => (anchor = prevMonth(anchor))}
      aria-label="Previous month"
      title="Previous month"
      class="grid size-9 place-items-center rounded-[var(--radius-md)] text-content-dim transition-colors hover:bg-hover-gray hover:text-content focus-ring"
    >
      <ChevronLeftIcon class="size-5" />
    </button>
    <h2 class="min-w-0 flex-1 truncate text-center text-sm font-semibold text-content">
      {monthLabel(month)}
    </h2>
    <button
      type="button"
      onclick={() => (anchor = nextMonth(anchor))}
      aria-label="Next month"
      title="Next month"
      class="grid size-9 place-items-center rounded-[var(--radius-md)] text-content-dim transition-colors hover:bg-hover-gray hover:text-content focus-ring"
    >
      <ChevronRightIcon class="size-5" />
    </button>
    <button
      type="button"
      onclick={() => (anchor = thisMonth(today))}
      class="ml-1 shrink-0 rounded-[var(--radius-md)] border border-edge px-2.5 py-1.5 text-xs font-medium text-content-dim transition-colors hover:bg-hover-gray hover:text-content focus-ring"
    >
      Today
    </button>
  </div>

  <!-- Scroll region: month overview grid + the agenda sections. ONE scroll
       region with keyed rows + native scroll anchoring (we never set
       overflow-anchor:none), so a live cyborg:tasks_changed insert does not jump
       the scroll. PullToRefresh owns the scroll element. -->
  <PullToRefresh onRefresh={refresh}>
    <!-- Compact month overview: a tap on any day opens the day drawer. -->
    <div class="px-2 pt-2">
      <div class="grid grid-cols-7">
        {#each WEEKDAY_LABELS as label (label)}
          <div class="pb-1 text-center text-[10px] font-medium uppercase tracking-wide text-content-muted">
            {label.slice(0, 1)}
          </div>
        {/each}
      </div>
      <div class="grid grid-cols-7">
        {#each month.weeks as week, wi (wi)}
          {#each week as day (day.date)}
            {@const count = tasksForDay(day).length}
            <button
              type="button"
              onclick={() => openDay(day)}
              aria-label={`${drawerTitle(day)}${count > 0 ? `, ${count} work item${count === 1 ? "" : "s"}` : ""}`}
              class={cn(
                "pressable-row flex aspect-square flex-col items-center justify-center gap-0.5 rounded-[var(--radius-md)] transition-colors hover:bg-hover-gray focus-ring",
                !day.inMonth && "opacity-40",
              )}
            >
              {#if day.isToday}
                <span class="grid size-6 place-items-center rounded-full bg-accent text-xs font-semibold text-[color:var(--brand-contrast)]">
                  {day.dayOfMonth}
                </span>
              {:else}
                <span class="text-xs font-medium text-content">{day.dayOfMonth}</span>
              {/if}
              <span
                class={cn(
                  "size-1.5 rounded-full",
                  count > 0 ? "bg-accent" : "bg-transparent",
                )}
                aria-hidden="true"
              ></span>
            </button>
          {/each}
        {/each}
      </div>
    </div>

    <!-- Agenda: day-grouped sections (Overdue / Today / Tomorrow / days /
         Unscheduled). Read-only rows — tap opens the detail route. -->
    <div class="hairline-t mt-2">
      {#if sections.length === 0}
        <div class="flex flex-col items-center justify-center gap-2 px-8 py-12 text-center">
          <p class="text-sm text-content-muted">No work items</p>
        </div>
      {:else}
        {#each sections as section (section.key)}
          <section>
            <header class="flex items-center gap-2 bg-surface px-3 pb-1.5 pt-3">
              <span
                class={cn(
                  "min-w-0 truncate text-sm font-semibold",
                  section.kind === "overdue" ? "text-error" : "text-content",
                )}
              >
                {section.label}
              </span>
              <span class="tabular-nums text-sm font-medium text-content-muted">
                {section.tasks.length}
              </span>
            </header>
            {#each section.tasks as task (task.id)}
              <TaskRowMobile
                {task}
                {pools}
                display={rowDisplay}
                ontap={() => openTaskDetailMobileAware(task.id)}
              />
            {/each}
          </section>
        {/each}
      {/if}
    </div>
  </PullToRefresh>
</div>

<!-- Day drawer: that day's tasks + a per-day "+ Add" (the faithful per-day quick
     create — there is no global FAB on the agenda). Always mounted; renders
     nothing while closed. -->
<MobileSheet bind:open={drawerOpen} title={drawerTitle(drawerDay)} onclose={() => (drawerDay = null)}>
  <div class="flex flex-col gap-2 pb-2">
    <button
      type="button"
      onclick={() => addOnDay(drawerDay)}
      class="touch-target-row flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-2.5 text-left text-sm font-medium text-accent transition-colors hover:bg-hover-gray focus-ring"
    >
      <PlusIcon class="size-4" />
      Add work item
    </button>

    {#if drawerTasks.length === 0}
      <p class="px-3 py-6 text-center text-sm text-content-muted">No work items due this day</p>
    {:else}
      <div class="hairline-t">
        {#each drawerTasks as task (task.id)}
          <TaskRowMobile
            {task}
            {pools}
            display={rowDisplay}
            ontap={() => openTaskDetailMobileAware(task.id)}
          />
        {/each}
      </div>
    {/if}
  </div>
</MobileSheet>
