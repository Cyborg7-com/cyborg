<script lang="ts">
  // WS1 — the mobile work-item ROW. Presentation-only, props-in / callbacks-out so
  // it can be reused verbatim by the List, the Calendar agenda, and the
  // Cycles/Modules drill rows (a sibling never re-implements a row). It is a
  // TWO-LINE row:
  //   line 1 — the work-item KEY (display-gated) + the title (truncates).
  //   line 2 — gated property chips built from the LEAF glyphs (StateGroupIcon /
  //            PriorityIcon / AssigneeAvatar + the due chip + label dots). We do
  //            NOT render WorkItemProperties here — that component is `hidden
  //            sm:flex` (desktop-only) and would render nothing on a phone; the
  //            chips below are the phone-native equivalent, token-only.
  //
  // Tap → ontap (the list maps it to openTaskDetailMobileAware). Long-press →
  // onlongpress (the list opens the TaskActionSheet). A long-press is detected
  // with a 500ms hold + a 10px movement slop so a scroll never fires it; the
  // subsequent click is suppressed so a long-press never also opens the detail.
  // No nested interactive controls (the chips are inert), so the whole row is one
  // clean tap/long-press target and nothing here opens a portal'd dropdown.
  import StateGroupIcon from "$lib/components/tasks/StateGroupIcon.svelte";
  import PriorityIcon from "$lib/components/tasks/PriorityIcon.svelte";
  import AssigneeAvatar from "$lib/components/tasks/AssigneeAvatar.svelte";
  import { resolveAssignee, type AssigneePools } from "$lib/tasks/assignee.js";
  import { priorityForTask, type Priority } from "$lib/tasks/priority.js";
  import { formatDue, dueChipClass } from "$lib/tasks/due.js";
  import { taskKey, statusLabel, stateGroupForStatus } from "$lib/tasks/detail.js";
  import { workChipPill, workPriorityBox, dueChip, workLabelDot } from "$lib/tasks/ui.js";
  import type { StateLite } from "$lib/tasks/view.js";
  import type { Task, TaskLabel } from "$lib/core/types.js";
  import { haptic } from "$lib/mobile/haptics.js";
  import { cn } from "$lib/utils.js";

  // Which line-2 chips the row renders (mirrors the desktop list's display map,
  // which the parent derives off preferencesState.tasksDisplay). `taskId` gates the
  // line-1 KEY. Each defaults ON (Plane opt-out semantics).
  interface RowDisplay {
    taskId?: boolean;
    status?: boolean;
    priority?: boolean;
    assignee?: boolean;
    dueAt?: boolean;
  }

  let {
    task,
    states = [],
    labels = [],
    pools,
    projectIdentifier = null,
    display = {},
    pending = false,
    ontap,
    onlongpress,
  }: {
    task: Task;
    // The project's workflow states (id/name/color/group). When the task's
    // stateId resolves here the state pill shows the real swatch + name; otherwise
    // we fall back to the legacy status → state-group glyph.
    states?: StateLite[];
    labels?: TaskLabel[];
    pools: AssigneePools;
    projectIdentifier?: string | null;
    display?: RowDisplay;
    // Dims the row while one of its fields has an in-flight optimistic save.
    pending?: boolean;
    ontap?: () => void;
    onlongpress?: () => void;
  } = $props();

  function shown(key: keyof RowDisplay): boolean {
    return display[key] !== false;
  }

  const shortId = $derived(taskKey(task.sequenceId, task.id, projectIdentifier));
  const state = $derived(states.find((s) => s.id === task.stateId) ?? null);
  const fallbackGroup = $derived(stateGroupForStatus(task.status));
  const priority = $derived<Priority>(priorityForTask(task));
  const assignee = $derived(resolveAssignee(task.assigneeId, pools));
  const isDone = $derived(task.status === "done");

  // Due chip (epoch-ms → relative label + tint). A done task keeps a quiet chip.
  const dueLabel = $derived(task.dueAt == null ? "" : formatDue(task.dueAt));
  const dueClass = $derived(
    task.dueAt == null
      ? ""
      : isDone
        ? "bg-surface-alt text-content-muted"
        : dueChipClass(task.dueAt),
  );

  // Label color dots stay on the --label-* token palette (per CLAUDE.md — never
  // the raw stored label.color). An unknown color degrades to the neutral dot.
  const PALETTE = ["indigo", "emerald", "grey", "crimson", "yellow", "orange", "pink", "purple"];
  function dotFill(color: string): string {
    return `bg-label-${PALETTE.includes(color) ? color : "grey"}-text`;
  }
  const pickedLabels = $derived(labels.filter((l) => (task.labelIds ?? []).includes(l.id)));

  // Priority box border is priority-keyed (full class strings so Tailwind keeps
  // the utilities). Mirrors WorkItemProperties' PRIORITY_BORDER.
  const PRIORITY_BORDER: Record<Priority, string> = {
    urgent: "border-priority-urgent",
    high: "border-priority-high",
    medium: "border-priority-medium",
    low: "border-priority-low",
    none: "border-edge",
  };

  const showPriority = $derived(shown("priority") && priority !== "none");
  const showDue = $derived(shown("dueAt") && Boolean(dueLabel));
  const showAssignee = $derived(shown("assignee") && Boolean(task.assigneeId));
  const showState = $derived(shown("status"));
  const hasChips = $derived(
    showState || showPriority || showDue || showAssignee || pickedLabels.length > 0,
  );

  // ── tap vs long-press ──────────────────────────────────────────────────────
  // 500ms hold opens the action sheet; a 10px move (= a scroll) cancels it; the
  // click that follows a long-press is swallowed so it never also opens detail.
  const LONG_MS = 500;
  const SLOP = 10;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let longFired = false;
  let startX = 0;
  let startY = 0;

  function clearTimer(): void {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  }
  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    longFired = false;
    startX = e.clientX;
    startY = e.clientY;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      longFired = true;
      haptic("medium");
      onlongpress?.();
    }, LONG_MS);
  }
  function onPointerMove(e: PointerEvent): void {
    if (timer == null) return;
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > SLOP) clearTimer();
  }
  function onPointerEnd(): void {
    clearTimer();
  }
  function onClick(e: MouseEvent): void {
    if (longFired) {
      longFired = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    ontap?.();
  }
  function onContextMenu(e: Event): void {
    // Suppress the native long-press context menu on touch.
    e.preventDefault();
  }
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      ontap?.();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  role="button"
  tabindex="0"
  aria-label={`${shortId} ${task.title}`}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerEnd}
  onpointercancel={onPointerEnd}
  onclick={onClick}
  oncontextmenu={onContextMenu}
  onkeydown={onKeyDown}
  class={cn(
    "touch-target-row pressable-row flex w-full select-none flex-col gap-1 px-3 py-2.5 text-left",
    pending && "opacity-60",
  )}
>
  <!-- line 1: KEY + title -->
  <div class="flex w-full min-w-0 items-center gap-2">
    {#if shown("taskId")}
      <span class="shrink-0 text-xs tabular-nums text-content-muted">{shortId}</span>
    {/if}
    <span class="min-w-0 flex-1 truncate text-sm text-content">{task.title}</span>
  </div>

  <!-- line 2: gated property chips from leaf glyphs (NOT WorkItemProperties) -->
  {#if hasChips}
    <div class="flex w-full min-w-0 items-center gap-1.5 overflow-hidden text-content-muted">
      {#if showState}
        {#if state}
          <span class={workChipPill}>
            <StateGroupIcon group={state.group} color={state.color} size={13} />
            <span class="max-w-32 truncate text-content-dim">{state.name}</span>
          </span>
        {:else}
          <span class={workChipPill}>
            <StateGroupIcon group={fallbackGroup} size={13} />
            <span class="max-w-32 truncate text-content-dim">{statusLabel(task.status)}</span>
          </span>
        {/if}
      {/if}

      {#if showPriority}
        <span class={cn(workPriorityBox, PRIORITY_BORDER[priority])}>
          <PriorityIcon {priority} size={12} />
        </span>
      {/if}

      {#if showDue}
        <span class={cn(dueChip, "h-5 shrink-0 gap-1.5 border-[0.5px] border-edge px-1.5", dueClass)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
          {dueLabel}
        </span>
      {/if}

      {#if pickedLabels.length > 0}
        <span class="flex shrink-0 items-center gap-1">
          {#each pickedLabels.slice(0, 3) as l (l.id)}
            <span class={cn(workLabelDot, dotFill(l.color))} title={l.name}></span>
          {/each}
        </span>
      {/if}

      {#if showAssignee}
        <span class="ml-auto shrink-0 pl-1">
          <AssigneeAvatar {assignee} size={20} />
        </span>
      {/if}
    </div>
  {/if}
</div>
