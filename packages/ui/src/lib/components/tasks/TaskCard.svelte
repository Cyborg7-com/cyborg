<script lang="ts">
  // A single task CARD for the kanban board, ported to Plane's block.tsx look via
  // the shared Tasks foundation (lib/tasks/ui.ts). Anatomy mirrors Plane's kanban
  // block exactly:
  //   row 1  issue-id (muted) + hover-revealed "…" quick-actions menu
  //   row 2  title, line-clamped, 14px/500
  //   row 3  properties row: priority dot + due chip + assignee avatar
  // The card is bg-raised (Plane's bg-layer-2) with a two-step elevation
  // (shadow-task-card → -hover) and a border that lifts to border-edge-light on
  // hover; the peeked/open card gets the accent ring. Every class resolves
  // through an app.css token so dark + light both work; the only bracket-literals
  // are font-size geometry and var(--…) references, no raw colors.
  //
  // Reused across every board group (status / assignee / priority columns) so the
  // card is identical regardless of how the board is grouped. Drag wiring is
  // delegated to the parent via callbacks — the card stays presentation-first.
  //
  // DATA-DRIVEN STATE: when the page passes the project's `states`
  // (client.fetchProjectStates), the card resolves the task's `stateId` to the
  // real workflow state (name + editable color + Plane phase) and the "Move to"
  // menu lists those states (moving writes `stateId` via onmovestate). With no
  // states it falls back to the legacy four fixed board columns (onmove + status).
  import { toast } from "svelte-sonner";
  import { client } from "$lib/state/client.js";
  import { workspaceState } from "$lib/state/app.svelte.js";
  import DeleteTaskDialog from "$lib/components/tasks/DeleteTaskDialog.svelte";
  import CreateScheduleDialog from "$lib/components/tasks/CreateScheduleDialog.svelte";
  import StateGroupIcon from "$lib/components/tasks/StateGroupIcon.svelte";
  import WorkItemProperties from "$lib/components/tasks/WorkItemProperties.svelte";
  import { type AssigneePools } from "$lib/tasks/assignee.js";
  import { resolveTaskScheduleBinding } from "$lib/schedule/task-binding.js";
  import { COLUMNS, columnForStatus, type ColumnKey } from "$lib/tasks/board.js";
  import { priorityForTask, type Priority } from "$lib/tasks/priority.js";
  import type { DateRange } from "$lib/components/tasks/DateRangeDropdown.svelte";
  import { taskKey } from "$lib/tasks/detail.js";
  import { isDisplayed, type StateLite } from "$lib/tasks/view.js";
  import { preferencesState } from "$lib/state/preferences.svelte.js";
  import type { TaskLabel, Cycle, Module } from "$lib/core/types.js";
  import {
    cardBase,
    cardPeeked,
    cardDragging,
    cardStack,
    cardIdRow,
    cardTitle,
    cardQuickAction,
  } from "$lib/tasks/ui.js";
  import type { Task } from "$lib/core/types.js";
  import { cn } from "$lib/utils.js";
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
  } from "$lib/components/ui/dropdown-menu/index.js";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";

  let {
    task,
    workspaceId,
    pools,
    states = [],
    labels = [],
    cycles = [],
    modules = [],
    projectIdentifier = null,
    dragging = false,
    pending = false,
    peeked = false,
    onopen,
    onmove,
    onmovestate,
    ondragstart,
    ondragend,
  }: {
    task: Task;
    // The workspace this card's task lives in — needed so the chip strip's inline
    // editors can persist via client.updateTask.
    workspaceId: string;
    pools: AssigneePools;
    // The project's workflow states (data-driven "Move to" menu + the real state
    // chip / inline StateDropdown). Empty = legacy four-column fallback.
    states?: StateLite[];
    // The project's label catalog, to resolve task.labelIds → name + color dots and
    // feed the inline LabelDropdown.
    labels?: TaskLabel[];
    // The project's cycle / module catalogs, feeding the inline CycleSelect /
    // ModuleSelect editors (the chip strip only renders those when non-empty).
    cycles?: Cycle[];
    modules?: Module[];
    // The project's task-key prefix ("ENG"); null falls back to a "#<seq|id>" key.
    projectIdentifier?: string | null;
    dragging?: boolean;
    pending?: boolean;
    // The card whose detail peek is currently open — gets the accent outline.
    peeked?: boolean;
    onopen: (id: string) => void;
    onmove: (task: Task, to: ColumnKey) => void;
    // Data-driven move: write the task's `stateId` (used when `states` are passed).
    onmovestate?: (task: Task, stateId: string) => void;
    ondragstart?: (e: DragEvent, id: string) => void;
    ondragend?: () => void;
  } = $props();

  const currentColumn = $derived(columnForStatus(task.status));
  // Plane shows a short, human-scannable task KEY ("ENG-12") built from the
  // project identifier + per-project sequenceId; falls back to "#<seq>" or a short
  // id slice when either is unknown (no invented data — see detail.ts taskKey).
  const shortId = $derived(taskKey(task.sequenceId, task.id, projectIdentifier));

  // Plane gates the card's sub-item / link / attachment counts. The wire Task
  // carries none of those counts today, so we read them forward-compatibly (any
  // future denormalized count field shows automatically; absent = nothing).
  const subItemCount = $derived(
    (task as { subItemCount?: number }).subItemCount ?? 0,
  );

  // The current priority value the chip strip's PriorityDropdown is controlled by.
  const priority = $derived<Priority>(priorityForTask(task));

  // The issue-KEY chip in row 1 is gated by the "taskId" Display toggle (separate
  // from the chip strip's WorkItemProperties display map below).
  const showId = $derived(isDisplayed(preferencesState.tasksDisplay, "taskId"));

  // Plane's "Display properties" toggles decide which property chips a card renders
  // (all-on by default; the user opts OUT). We map the preference singleton onto
  // WorkItemProperties' DisplayMap so the editable chip strip honors the same
  // toggles; reading reactively re-renders the moment a toggle flips. "status"
  // gates the state chip/editor (separate from the card's column membership); the
  // "…" quick-actions menu is an ACTION, not a display property, so it always
  // stays available. (Labels/cycle/module aren't in the toolbar's narrower toggle
  // set — they're always shown when their catalog feeds an editor.)
  const display = $derived({
    status: isDisplayed(preferencesState.tasksDisplay, "status"),
    priority: isDisplayed(preferencesState.tasksDisplay, "priority"),
    dueAt: isDisplayed(preferencesState.tasksDisplay, "dueAt"),
    scheduled: isDisplayed(preferencesState.tasksDisplay, "scheduled"),
    assignee: isDisplayed(preferencesState.tasksDisplay, "assignee"),
  });

  // The DateRangeDropdown speaks ISO strings; tasks carry epoch-ms. Convert at this
  // boundary (matches TaskDetailCard) so the editor renders and the commit stays in
  // the task model's ms shape.
  function msToIso(ms: number | null | undefined): string | null {
    return ms == null ? null : new Date(ms).toISOString();
  }
  function isoToMs(iso: string | null): number | null {
    if (!iso) return null;
    const ms = new Date(iso).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const dateRange = $derived<DateRange>({
    startDate: msToIso(task.startDate),
    dueAt: msToIso(task.dueAt),
  });

  // updateTask persists labels by NAME (auto-created), not id; map the editor's
  // chosen ids back through the loaded catalog for the commit, while the optimistic
  // patch still carries the id set the editor speaks. (Mirrors TaskDetailCard.)
  function labelIdsToNames(ids: string[]): string[] {
    return ids
      .map((id) => labels.find((l) => l.id === id)?.name)
      .filter((n): n is string => Boolean(n));
  }

  // The per-task schedule binding (which cybo runs it, why it can't be scheduled).
  const scheduleBinding = $derived(resolveTaskScheduleBinding(task, pools));

  // Drives the "Delete task" confirmation modal opened from the quick-actions menu.
  let showDelete = $state(false);
  // Drives the per-task schedule editor, opened from the cadence chip.
  let showSchedule = $state(false);
  // Dims the card while an inline chip-strip edit is saving.
  let saving = $state(false);

  // Single optimistic-update path for every inline chip edit, mirroring the detail
  // card / list commit(): patch workspaceState.tasks immediately, RPC, reconcile
  // with the server row (or revert + toast on failure).
  async function commit(
    updates: Parameters<typeof client.updateTask>[2],
    optimistic: Partial<Task>,
  ): Promise<void> {
    if (saving) return;
    const prev = task;
    saving = true;
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
      saving = false;
    }
  }

  function saveState(id: string): void {
    if (id === task.stateId) return;
    void commit({ stateId: id }, { stateId: id } as Partial<Task>);
  }
  function savePriority(p: Priority): void {
    if (p === priority) return;
    const raw = p === "none" ? null : p;
    void commit({ priority: raw }, { priority: raw } as Partial<Task>);
  }
  function saveAssignee(id: string | null): void {
    if (id === task.assigneeId) return;
    void commit({ assigneeId: id }, { assigneeId: id });
  }
  function saveDates(range: DateRange): void {
    const nextStart = isoToMs(range.startDate);
    const nextDue = isoToMs(range.dueAt);
    if (nextStart === (task.startDate ?? null) && nextDue === (task.dueAt ?? null)) return;
    void commit(
      { startDate: nextStart, dueAt: nextDue },
      { startDate: nextStart, dueAt: nextDue } as Partial<Task>,
    );
  }
  function saveLabels(ids: string[]): void {
    void commit({ labels: labelIdsToNames(ids) }, { labelIds: ids } as Partial<Task>);
  }
  function saveCycle(id: string | null): void {
    if (id === (task.cycleId ?? null)) return;
    void commit({ cycleId: id }, { cycleId: id } as Partial<Task>);
  }
  function saveModules(ids: string[]): void {
    void commit({ moduleIds: ids }, { moduleIds: ids } as Partial<Task>);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  role="button"
  tabindex="0"
  draggable="true"
  ondragstart={(e) => ondragstart?.(e, task.id)}
  ondragend={() => ondragend?.()}
  onclick={() => onopen(task.id)}
  onkeydown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onopen(task.id);
    }
  }}
  class={cn(
    cardBase,
    cardStack,
    "cursor-pointer text-left",
    peeked && cardPeeked,
    dragging && cardDragging,
    (pending || saving) && "opacity-60",
  )}
>
  <!-- Row 1: issue-id (display-gated) in normal flow + the quick-actions ("…")
       status menu ABSOLUTELY positioned at the top-right (Plane block.tsx: a
       `relative` box with IssueIdentifier in flow and the actions pinned at
       `-top-1 right-0`, revealed on kanban-block hover). The menu is an ACTION —
       always available, never gated by Display properties — and overlays the
       corner so the KEY never reserves layout space for it. -->
  <div class="relative min-h-5">
    {#if showId}
      <span class={cardIdRow}>{shortId}</span>
    {/if}

    <!-- Status menu (portal'd by DropdownMenu so it never clips behind columns).
         Stop propagation so opening / picking doesn't also open the detail view.
         Hover-revealed via cardQuickAction (absolute -top-1 right-0, opacity-0
         group-hover/kanban-block:opacity-100). -->
    <div
      class={cn(cardQuickAction, "data-[open=true]:opacity-100")}
      role="presentation"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          title="Change status"
          aria-label="Change status"
          disabled={pending}
          class="grid size-5 place-items-center rounded-[4px] text-content-muted transition-colors hover:bg-hover-gray hover:text-content focus-ring disabled:opacity-50"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
          </svg>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-44">
          <DropdownMenuLabel class="text-[11px] font-semibold uppercase tracking-wide text-content-muted">Move to</DropdownMenuLabel>
          {#if states.length > 0 && onmovestate}
            <!-- Data-driven: list the project's real workflow states (writes stateId). -->
            <DropdownMenuRadioGroup
              value={task.stateId ?? ""}
              onValueChange={(v) => onmovestate?.(task, v)}
            >
              {#each states as s (s.id)}
                <DropdownMenuRadioItem value={s.id} class="cursor-pointer">
                  <span class="flex items-center gap-2">
                    <StateGroupIcon group={s.group} color={s.color} size={14} />
                    {s.name}
                  </span>
                </DropdownMenuRadioItem>
              {/each}
            </DropdownMenuRadioGroup>
          {:else}
            <!-- Legacy fallback: the four fixed board columns (writes status). -->
            <DropdownMenuRadioGroup value={currentColumn} onValueChange={(v) => onmove(task, v as ColumnKey)}>
              {#each COLUMNS as c (c.key)}
                <DropdownMenuRadioItem value={c.key} class="cursor-pointer">{c.label}</DropdownMenuRadioItem>
              {/each}
            </DropdownMenuRadioGroup>
          {/if}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            class="cursor-pointer"
            onclick={() => (showDelete = true)}
          >
            <Trash2Icon class="size-4" />
            Delete task
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>

  <!-- Row 2: title, single line, 14px/500. -->
  <h4 class={cardTitle}>{task.title}</h4>

  <!-- Row 3: properties strip — the ONE shared WorkItemProperties row, editable
       (variant="chip"). Each chip is its A/B-batch editor (State / Priority /
       DateRange / Assignee / Label / Cycle / Module), props-controlled: this card
       supplies the project catalog (states / labels / cycles / modules) + the
       assignee pools and persists every onChange through the optimistic `commit`
       (client.updateTask). An editor only renders when its handler is supplied AND
       its data is present, so a chip degrades to read-only when its catalog isn't
       loaded. The whole row drops out when every enabled chip is empty.
       stopPropagation so editing a chip never opens the detail peek; drag-to-change
       status (the "…" Move-to menu above) stays untouched. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div role="presentation" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
    <WorkItemProperties
      stateId={task.stateId ?? null}
      {priority}
      assigneeId={task.assigneeId}
      startDate={dateRange.startDate}
      dueAt={dateRange.dueAt}
      schedule={task.schedule ?? null}
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
      editable
      onStateChange={saveState}
      onPriorityChange={savePriority}
      onAssigneeChange={saveAssignee}
      onDatesChange={saveDates}
      onLabelsChange={saveLabels}
      onCycleChange={saveCycle}
      onModulesChange={saveModules}
      onScheduleClick={() => (showSchedule = true)}
    />
  </div>
</div>

<!-- Destructive "Delete task" confirmation, opened from the card's quick-actions
     menu. Portals to <body>, so it lives outside the card wrapper and never
     inherits the card's open-on-click handler. The board drops the row live via
     the tasks_changed "deleted" broadcast. -->
<DeleteTaskDialog bind:open={showDelete} workspaceId={task.workspaceId} {task} />

<!-- Per-task schedule editor, opened from the cadence chip. Pre-bound to this task
     (cybo = its assignee cybo, channel = its channelId, taskId = its id). Portals
     to <body>, so it lives outside the card wrapper and never inherits the card's
     open-on-click handler. -->
<CreateScheduleDialog
  bind:open={showSchedule}
  workspaceId={task.workspaceId}
  taskId={task.id}
  cyboId={scheduleBinding.cyboId}
  channelId={scheduleBinding.channelId}
  disabledReason={scheduleBinding.disabledReason}
/>
