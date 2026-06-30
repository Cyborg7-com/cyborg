<script lang="ts">
  // WS2 — the mobile board CARD. Presentation + the per-card affordances the
  // board needs: a long-press PICKUP target (drag handled by touchBoardDnd via
  // `onpickup`), a tap that opens detail (pointer taps come through the drag
  // controller's onTap; keyboard Enter/Space comes through `ontap`), and a
  // visible ⋯ button (hover-only affordances are dead on touch) that opens the
  // board's state-move + delete menu. Read-only chips mirror TaskRowMobile (leaf
  // glyphs — StateGroupIcon / PriorityIcon / AssigneeAvatar + due + label dots —
  // NOT WorkItemProperties, which is `hidden sm:flex` and renders nothing on a
  // phone). Token-only; no portal'd dropdown opens from a card (only the board's
  // sheets do).
  //
  // Three render modes:
  //   • normal    — interactive card in a column.
  //   • ghost      — the floating clone that follows the finger during a drag
  //                  (no handlers, elevated, pointer-events:none set by the host).
  // While a card is being dragged the column drops it from the render entirely
  // (its slot closes up); the controller skips it by id when measuring, so it
  // never needs a DOM placeholder.
  import PriorityIcon from "$lib/components/tasks/PriorityIcon.svelte";
  import AssigneeAvatar from "$lib/components/tasks/AssigneeAvatar.svelte";
  import { resolveAssignee, type AssigneePools } from "$lib/tasks/assignee.js";
  import { priorityForTask, type Priority } from "$lib/tasks/priority.js";
  import { formatDue, dueChipClass } from "$lib/tasks/due.js";
  import { taskKey } from "$lib/tasks/detail.js";
  import { workPriorityBox, dueChip, workLabelDot } from "$lib/tasks/ui.js";
  import type { Task, TaskLabel } from "$lib/core/types.js";
  import { cn } from "$lib/utils.js";

  let {
    task,
    labels = [],
    pools,
    projectIdentifier = null,
    ghost = false,
    pending = false,
    onpickup,
    ontap,
    onmenu,
  }: {
    task: Task;
    labels?: TaskLabel[];
    pools: AssigneePools;
    projectIdentifier?: string | null;
    ghost?: boolean;
    pending?: boolean;
    // Pointer-down on the card body — the board's drag controller arms the
    // long-press pickup from here. Absent in ghost mode.
    onpickup?: (e: PointerEvent) => void;
    // Keyboard activation (Enter/Space) — opens detail. Pointer taps are routed
    // by the drag controller's onTap, not here, so a drag never also opens detail.
    ontap?: () => void;
    // The ⋯ button — opens the board's move-state + delete menu for this task.
    onmenu?: () => void;
  } = $props();

  const shortId = $derived(taskKey(task.sequenceId, task.id, projectIdentifier));
  const priority = $derived<Priority>(priorityForTask(task));
  const assignee = $derived(resolveAssignee(task.assigneeId, pools));
  const isDone = $derived(task.status === "done");

  const dueLabel = $derived(task.dueAt == null ? "" : formatDue(task.dueAt));
  const dueClass = $derived(
    task.dueAt == null
      ? ""
      : isDone
        ? "bg-surface-alt text-content-muted"
        : dueChipClass(task.dueAt),
  );

  // Label dots stay on the --label-* token palette (per CLAUDE.md — never the raw
  // stored label.color). An unknown color degrades to the neutral dot.
  const PALETTE = ["indigo", "emerald", "grey", "crimson", "yellow", "orange", "pink", "purple"];
  function dotFill(color: string): string {
    return `bg-label-${PALETTE.includes(color) ? color : "grey"}-text`;
  }
  const pickedLabels = $derived(labels.filter((l) => (task.labelIds ?? []).includes(l.id)));

  const PRIORITY_BORDER: Record<Priority, string> = {
    urgent: "border-priority-urgent",
    high: "border-priority-high",
    medium: "border-priority-medium",
    low: "border-priority-low",
    none: "border-edge",
  };

  const showPriority = $derived(priority !== "none");
  const showDue = $derived(Boolean(dueLabel));
  const showAssignee = $derived(Boolean(task.assigneeId));
  const hasChips = $derived(showPriority || showDue || showAssignee || pickedLabels.length > 0);

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      ontap?.();
    }
  }
  function onContextMenu(e: Event): void {
    // Suppress the native long-press context menu on touch.
    e.preventDefault();
  }
  function onMenuPointerDown(e: PointerEvent): void {
    // Keep a tap on ⋯ from arming a card drag.
    e.stopPropagation();
  }
  function onMenuClick(e: MouseEvent): void {
    e.stopPropagation();
    onmenu?.();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  data-task-id={task.id}
  role="button"
  tabindex={ghost ? -1 : 0}
  aria-label={`${shortId} ${task.title}`}
  aria-hidden={ghost ? "true" : undefined}
  onpointerdown={ghost ? undefined : onpickup}
  oncontextmenu={ghost ? undefined : onContextMenu}
  onkeydown={ghost ? undefined : onKeyDown}
  class={cn(
    "select-none rounded-[var(--radius-md)] border border-edge bg-tasks-card-bg px-3 py-2.5 text-left",
    !ghost && "pressable-scale",
    ghost && "pointer-events-none scale-[1.03] shadow-2xl ring-1 ring-accent/40",
    pending && "opacity-60",
  )}
>
  <!-- line 1: KEY + ⋯ -->
  <div class="flex w-full min-w-0 items-center gap-2">
    <span class="min-w-0 flex-1 truncate text-xs tabular-nums text-content-muted">{shortId}</span>
    {#if !ghost}
      <button
        type="button"
        aria-label="Work item actions"
        title="Actions"
        onpointerdown={onMenuPointerDown}
        onclick={onMenuClick}
        class="-mr-1 grid size-7 shrink-0 place-items-center rounded-[var(--radius-sm)] text-content-muted transition-colors hover:bg-hover-gray hover:text-content focus-ring"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
    {/if}
  </div>

  <!-- line 2: title (up to two lines) -->
  <p class="mt-0.5 line-clamp-2 text-sm leading-snug text-content">{task.title}</p>

  <!-- line 3: gated property chips from leaf glyphs (NOT WorkItemProperties) -->
  {#if hasChips}
    <div class="mt-2 flex w-full min-w-0 items-center gap-1.5 overflow-hidden text-content-muted">
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
