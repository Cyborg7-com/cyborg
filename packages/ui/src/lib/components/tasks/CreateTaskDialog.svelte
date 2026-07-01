<script lang="ts">
  // "New task" modal, ported to Plane's create-issue modal look. Creates a
  // one-off task in the workspace with an optional description, status, priority,
  // due date, and assignee (a workspace member, a cybo, or a live agent). On
  // success the dialog closes and clears; the board updates live via the
  // cyborg:tasks_changed broadcast (so no manual refetch here).
  //
  // Layout follows Plane's issue-modal/form.tsx: a bare borderless title input
  // (no box), a full-width description, then a responsive 2-col properties grid
  // of inline pickers (Status / Priority / Due date / Assignee), with a bordered
  // header (title + close) and a divider-top footer holding right-aligned
  // secondary "Cancel" + primary "Create".
  //
  // Visual is composed from $lib/tasks/ui.ts (the single source of the Plane
  // look) — this component only adds stateful classes at the call site. Every
  // color/surface/border resolves through an app.css semantic token, so dark and
  // light both work; there are no hardcoded colors here.
  //
  // create_task only accepts title/description/dueAt/assigneeId, so status +
  // priority can't ride the create RPC. To keep the per-column quick-add HONEST
  // (a task added from a Status or Priority column must land there), we create
  // the task, then issue ONE follow-up updateTask to apply a non-default status /
  // priority. The create is authoritative: if the follow-up fails the task still
  // exists, so we log and move on rather than surface a hard error.
  import { client } from "$lib/state/client.js";
  import { workspaceState } from "$lib/state/app.svelte.js";
  import { cyboState } from "$lib/plugins/agents/state.svelte.js";
  import { fieldInputClass } from "$lib/components/Field.svelte";
  import AssigneePicker from "$lib/components/tasks/AssigneePicker.svelte";
  import StateDropdown from "$lib/components/tasks/StateDropdown.svelte";
  import * as Select from "$lib/components/ui/select/index.js";
  import type { AssigneePools } from "$lib/tasks/assignee.js";
  import type { TaskState } from "$lib/core/types.js";
  import { STATUS_OPTIONS, statusLabel, dueToInputValue, type StatusKey } from "$lib/tasks/detail.js";
  import { columnForStatus } from "$lib/tasks/board.js";
  import {
    PRIORITY_ORDER,
    priorityStyle,
    type Priority,
  } from "$lib/tasks/priority.js";
  import { cn } from "$lib/utils.js";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
  } from "$lib/components/ui/dialog/index.js";
  import {
    btnPrimary,
    btnSecondary,
    fieldGrid,
    fieldLabel,
    modalBody,
    modalFooter,
    modalHeader,
    modalPanel,
    priorityDot,
    titleInput,
  } from "$lib/tasks/ui.js";

  let {
    open = $bindable(false),
    workspaceId,
    initialValues,
    projectId,
    states = [],
    initialLabels = [],
  }: {
    open?: boolean;
    workspaceId: string;
    // Label NAMES to pre-tag the new task with (auto-created by the relay's
    // resolveLabels). The Department Views bar uses this so creating the first
    // task in a new department MATERIALIZES that department's label on prod.
    initialLabels?: string[];
    // When the create dialog is opened from a project-scoped view (the Work
    // Items board), the new task is filed into that project. Absent on the
    // workspace-level Tasks tab, where a task lands in the Inbox.
    projectId?: string;
    // The project's workflow states (client.fetchProjectStates), ordered by
    // `sequence`. When present, the Status field becomes the data-driven
    // StateDropdown listing the project's real states (Backlog / Todo / In
    // Progress / Done / Cancelled) — the new task is filed straight into the
    // chosen state via `stateId`. Empty (the workspace-level Tasks tab, no
    // project) falls back to the legacy four-status Select.
    states?: TaskState[];
    // Pre-population seed for the board's per-column quick-add (Plane's "+ New"
    // on a kanban column opens the create form with that column's properties
    // already filled). `status` arrives as a board column key (e.g. "todo" for
    // the Inbox column); `priority` as a Priority bucket. All four seed real form
    // fields. create_task only persists title/description/dueAt/assigneeId, so a
    // non-default status/priority is applied via a follow-up updateTask (see
    // confirm()).
    initialValues?: {
      status?: string;
      assigneeId?: string | null;
      priority?: string;
      dueAt?: number | null;
      // When a data-driven board column (a real project state) opens the create
      // dialog, the new task is filed straight into that workflow state.
      stateId?: string;
    };
  } = $props();

  // Only active members are assignable (an invited-but-not-joined member can't
  // own work yet) — same filter the channel member picker uses.
  const pools = $derived<AssigneePools>({
    members: (workspaceState.members ?? []).filter((m) => m.membershipType === "active"),
    cybos: cyboState.list ?? [],
    agents: workspaceState.agents ?? [],
  });

  // The default status for a brand-new task: "pending" (Inbox), matching the
  // daemon's own create_task default. It buckets into the board's "todo" column,
  // so seeding from the To Do column resolves back to this same value. Only used
  // for the legacy fallback Select when the project has no state catalog.
  const DEFAULT_STATUS: StatusKey = "pending";
  // Priority Select values are strings, so the "none" bucket rides a sentinel
  // (mirrors TaskDetailCard) and maps back to "none" on selection.
  const PRIORITY_SENTINEL_NONE = "__none__";

  // The project's real workflow states drive the Status field when present.
  // They arrive ordered by `sequence`, so the FIRST state is the project's
  // backlog/default entry — the sensible default for a brand-new task (Plane
  // opens the create form on the project's default state, never a legacy
  // "Inbox"). The board column quick-add seeds a specific state via
  // initialValues.stateId, which takes precedence over the default.
  const hasStates = $derived(states.length > 0);
  function defaultStateId(): string | null {
    return initialValues?.stateId ?? states[0]?.id ?? null;
  }

  let title = $state("");
  let description = $state("");
  let status = $state<StatusKey>(DEFAULT_STATUS);
  // The chosen project state id (data-driven Status field). Defaults to the
  // seeded state or the project's first/backlog state on open.
  let stateId = $state<string | null>(null);
  let priority = $state<Priority>("none");
  // <input type="date"> value, e.g. "2026-06-30"; empty = no due date.
  let dueDate = $state("");
  let assigneeId = $state<string | null>(null);
  let submitting = $state(false);
  let error = $state<string | null>(null);
  // Plane's "Create more" footer toggle: when on, a successful create keeps the
  // modal open, clears the fields, and refocuses the title for rapid entry.
  let createMore = $state(false);
  // The title input, so we can auto-focus on open and re-focus after a
  // "Create more" submit.
  let titleEl = $state<HTMLInputElement | null>(null);

  const canSubmit = $derived(title.trim().length > 0 && !submitting);

  // The Select trigger binds to a string; map the priority sentinel both ways.
  const priorityValue = $derived(priority === "none" ? PRIORITY_SENTINEL_NONE : priority);

  // Normalize a seeded status into one of the STATUS_OPTIONS values. The board
  // passes a column key ("todo" for the Inbox column) which has no STATUS_OPTIONS
  // entry, so resolve it through the column bucket: anything that buckets into
  // "todo" is the DEFAULT_STATUS ("pending"/Inbox); the other three columns map
  // 1:1 to their status key. Falls back to DEFAULT_STATUS for an absent/unknown
  // seed so the select always lands on a real option.
  function normalizeStatus(seed: string | undefined): StatusKey {
    if (!seed) return DEFAULT_STATUS;
    const column = columnForStatus(seed);
    if (column === "todo") return DEFAULT_STATUS;
    return column;
  }

  // Coerce a seeded priority into a Priority bucket; unknown/absent → "none".
  function normalizePriority(seed: string | undefined): Priority {
    if (seed === "urgent" || seed === "high" || seed === "medium" || seed === "low") return seed;
    return "none";
  }

  // Seed the form fields from `initialValues`, or clear them to sensible defaults
  // when none is supplied.
  function applyInitial(): void {
    status = normalizeStatus(initialValues?.status);
    // Seed the data-driven Status field to the column's state (quick-add) or
    // the project's first/backlog state. Resolves to null with no catalog, where
    // the legacy `status` Select takes over instead.
    stateId = defaultStateId();
    priority = normalizePriority(initialValues?.priority);
    assigneeId = initialValues?.assigneeId ?? null;
    dueDate = dueToInputValue(initialValues?.dueAt ?? null);
  }

  // Clear the entry fields back to the seeded baseline (used on open and after a
  // "Create more" submit). Title + description always start empty.
  function resetFields(): void {
    title = "";
    description = "";
    applyInitial();
  }

  // Reset transient state each time the dialog opens, pre-populating from
  // initialValues, then auto-focus the title input.
  $effect(() => {
    if (!open) return;
    error = null;
    submitting = false;
    resetFields();
    // Focus after the dialog content has mounted.
    requestAnimationFrame(() => titleEl?.focus());
  });

  async function confirm(): Promise<void> {
    if (!canSubmit) return;
    submitting = true;
    error = null;
    // A date input has no time-of-day; treat it as the local end-of-day cutoff so
    // a task due "today" isn't already overdue. NaN guards a malformed value.
    let dueAt: number | undefined;
    if (dueDate) {
      const ts = new Date(`${dueDate}T23:59:59`).getTime();
      if (!Number.isNaN(ts)) dueAt = ts;
    }
    try {
      const created = await client.createTask(workspaceId, title.trim(), {
        description: description.trim() || undefined,
        assigneeId: assigneeId ?? undefined,
        dueAt,
        // File into the active project when opened from a project-scoped view.
        projectId: projectId || undefined,
        // File into the chosen workflow state. With a project state catalog the
        // user picks a real state (Status field); the create RPC honors it
        // directly, so the task lands there server-side with no follow-up.
        stateId: (hasStates ? stateId : initialValues?.stateId) || undefined,
        // Pre-tag with any seeded department label NAMES (relay auto-creates them).
        labels: initialLabels.length > 0 ? initialLabels : undefined,
      });
      // priority isn't part of create_task, so apply a non-default choice with a
      // follow-up update. The legacy `status` only rides the follow-up when the
      // project has NO state catalog (the workspace Tasks tab) — with states the
      // chosen `stateId` already filed the task, and the relay keeps `status` in
      // sync with the state's phase, so no status write is needed. Status is
      // compared by board COLUMN so we never fire a no-op when the chosen status
      // already buckets where the created task landed (e.g. Inbox === default).
      const updates: { status?: string; priority?: string } = {};
      if (!hasStates && columnForStatus(status) !== columnForStatus(created.status)) {
        updates.status = status;
      }
      if (priority !== "none") updates.priority = priority;
      if (updates.status !== undefined || updates.priority !== undefined) {
        // The task already exists — a failed follow-up must NOT fail the create.
        // Log and continue; the board still shows the new task, just without the
        // status/priority change, which the user can re-apply from the card.
        try {
          await client.updateTask(workspaceId, created.id, updates);
        } catch (err) {
          console.error("Failed to apply status/priority to the new task", err);
        }
      }
      if (createMore) {
        // Keep the modal open for the next task: clear fields back to the seed
        // and refocus the title (Plane's rapid-entry flow).
        resetFields();
        requestAnimationFrame(() => titleEl?.focus());
      } else {
        open = false;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "Couldn't create the task.";
    }
    submitting = false;
  }
</script>

<Dialog bind:open>
  <DialogContent class={cn(modalPanel, "p-0 sm:max-w-2xl")}>
    <!-- Header: title + auto close button (×) from DialogContent -->
    <div class={modalHeader}>
      <DialogTitle class="text-[15px] font-semibold text-content">New task</DialogTitle>
      <DialogDescription class="sr-only">
        Create a task and optionally set its status, priority, due date, and assignee.
      </DialogDescription>
    </div>

    <!-- Body -->
    <div class={modalBody}>
      <!-- Bare title input (Plane's title is a borderless field) -->
      <input
        bind:this={titleEl}
        bind:value={title}
        placeholder="Task title"
        aria-label="Task title"
        class={cn(titleInput, "text-[18px]")}
      />

      <!-- Description -->
      <textarea
        bind:value={description}
        rows="3"
        placeholder="Add a description…"
        aria-label="Description"
        class={cn(
          "w-full resize-none bg-transparent text-[14px] text-content",
          "placeholder:text-content-muted focus:outline-none",
        )}
      ></textarea>

      <!-- Properties grid: status + priority + due date + assignee -->
      <div class={fieldGrid}>
        <div class="flex flex-col gap-1.5">
          <span class={fieldLabel}>Status</span>
          {#if hasStates}
            <!-- Data-driven Status: the project's real workflow states (Backlog /
                 Todo / In Progress / Done / Cancelled), grouped with their phase
                 icon + editable color. Defaults to the seeded / first state; the
                 chosen id rides the create RPC's `stateId`. -->
            <StateDropdown
              value={stateId}
              options={states}
              variant="row"
              onChange={(next) => (stateId = next)}
              class={cn(fieldInputClass, "h-8")}
            />
          {:else}
            <!-- Legacy fallback (no project catalog — the workspace Tasks tab):
                 the four fixed statuses, applied via a follow-up update. -->
            <Select.Root type="single" value={status} onValueChange={(v) => (status = v as StatusKey)}>
              <Select.Trigger class={cn(fieldInputClass, "h-8")}>
                {statusLabel(status)}
              </Select.Trigger>
              <Select.Content>
                {#each STATUS_OPTIONS as s (s.value)}
                  <Select.Item value={s.value} label={s.label}>{s.label}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          {/if}
        </div>

        <div class="flex flex-col gap-1.5">
          <span class={fieldLabel}>Priority</span>
          <Select.Root
            type="single"
            value={priorityValue}
            onValueChange={(v) => (priority = (v === PRIORITY_SENTINEL_NONE ? "none" : v) as Priority)}
          >
            <Select.Trigger class={cn(fieldInputClass, "h-8")}>
              {#if priorityStyle(priority)}
                {@const ps = priorityStyle(priority)}
                <span class="flex items-center gap-2">
                  <span class={cn(priorityDot, ps?.dot)}></span>
                  {ps?.label}
                </span>
              {:else}
                <span class="text-content-muted">No priority</span>
              {/if}
            </Select.Trigger>
            <Select.Content>
              <Select.Item value={PRIORITY_SENTINEL_NONE} label="No priority">
                <span class="text-content-muted">No priority</span>
              </Select.Item>
              {#each PRIORITY_ORDER as p (p)}
                {@const ps = priorityStyle(p)}
                <Select.Item value={p} label={ps?.label ?? p}>
                  <span class="flex items-center gap-2">
                    <span class={cn(priorityDot, ps?.dot)}></span>
                    {ps?.label}
                  </span>
                </Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>

        <div class="flex flex-col gap-1.5">
          <label for="create-task-due" class={fieldLabel}>Due date</label>
          <input
            id="create-task-due"
            type="date"
            bind:value={dueDate}
            class={fieldInputClass}
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <span class={fieldLabel}>Assignee</span>
          <AssigneePicker bind:value={assigneeId} {pools} />
        </div>
      </div>

      {#if error}
        <p class="text-[12px] text-error" role="alert">{error}</p>
      {/if}
    </div>

    <!-- Footer: left "Create more" toggle (Plane), right Cancel + Create -->
    <div class={cn(modalFooter, "justify-between")}>
      <!-- Plane's "Create more" switch: keep the modal open after a create. -->
      <label class="flex cursor-pointer items-center gap-2 text-[13px] text-content-dim select-none">
        <input
          type="checkbox"
          bind:checked={createMore}
          class="size-3.5 accent-[color:var(--c7-accent)]"
        />
        Create more
      </label>

      <div class="flex items-center gap-2">
        <button
          type="button"
          class={btnSecondary}
          onclick={() => {
            open = false;
          }}
        >
          Cancel
        </button>
        <button type="button" class={btnPrimary} onclick={confirm} disabled={!canSubmit}>
          {submitting ? "Creating…" : "Create"}
        </button>
      </div>
    </div>
  </DialogContent>
</Dialog>
