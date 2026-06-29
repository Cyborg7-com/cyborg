<script lang="ts">
  // The editable task DETAIL BODY — our own Svelte 5 reimplementation of Plane's
  // work-item detail panel STRUCTURE + UX + colorimetry (NOT a port of Plane's
  // React). It shows the ENRICHED task and lets every field be edited; each
  // commit calls client.updateTask and patches workspaceState.tasks
  // optimistically so the board + this body reflect the change immediately, with
  // a revert on failure.
  //
  // Layout (Plane WIDE work-item detail — the full view):
  //   HEADER     → state pill · task KEY · copy-link · subscribe · side/modal/full
  //                mode toggle (persists to preferencesState.tasksPeekMode) · "…"
  //                overflow (delete). The panel surface is wired to --shadow-peek.
  //   BREADCRUMB → parent chip (when parentId) → big inline TITLE (click-to-edit).
  //   STRIP      → a HORIZONTAL property strip directly under the title: State ·
  //                Priority · Assignee · Start/Due (inline), each the matching
  //                SHARED dropdown editor (variant="row") laid out inline instead
  //                of in a SidebarPropertyListItem row.
  //   DESCRIPTION→ a WIDE rich editor (TaskDescriptionEditor) full-width below.
  //   SUB-ITEMS  → the "Add sub-work item" row + Links + Attachments widgets.
  //   PROPERTIES → a "Properties" section split into two labeled sub-groups:
  //                "Details" (Parent, Labels) and "Project structure" (Cycle,
  //                Modules), still vertical SidebarPropertyListItem rows. Every
  //                editor is props-controlled — this card supplies its options
  //                (the project catalog fetched on open via client.fetch*, plus
  //                the assignee pools) and persists every onChange through the
  //                optimistic `commit` (client.updateTask). A row/strip item
  //                without a loaded catalog degrades to a read-only chip.
  //   TABS       → Details (the above) · Activity (the feed).
  //
  // The full/wide mode is the PROMINENT layout (the default peek mode): the body
  // reads inside a centered, bounded column. Side/modal stay one toggle away.
  //
  // This component is presentation + RPC only; it's reused by both the in-board
  // peek (<TaskDetailDialog>) and the /tasks/[taskId] route card, so it owns no
  // open/close state. The host decides how it's framed.
  import { untrack } from "svelte";
  import { client } from "$lib/state/client.js";
  import { workspaceState, projectsCache, activityState } from "$lib/state/app.svelte.js";
  import { cyboState } from "$lib/plugins/agents/state.svelte.js";
  import { preferencesState } from "$lib/state/preferences.svelte.js";
  import type { TasksPeekMode } from "$lib/state/preferences.svelte.js";
  import { toast } from "svelte-sonner";
  import { fieldInputClass } from "$lib/components/Field.svelte";
  import AssigneeAvatar from "$lib/components/tasks/AssigneeAvatar.svelte";
  import DeleteTaskDialog from "$lib/components/tasks/DeleteTaskDialog.svelte";
  import CreateScheduleDialog from "$lib/components/tasks/CreateScheduleDialog.svelte";
  import TaskDescriptionEditor from "$lib/components/tasks/TaskDescriptionEditor.svelte";
  import StateGroupIcon from "$lib/components/tasks/StateGroupIcon.svelte";
  import PriorityIcon from "$lib/components/tasks/PriorityIcon.svelte";
  import SidebarPropertyListItem from "$lib/components/tasks/SidebarPropertyListItem.svelte";
  // ── Shared dropdown EDITORS (the parallel-built, props-controlled components) ─
  // Each is fed its options/pools + a controlled value here, and persists through
  // this card's optimistic `commit` (client.updateTask) in its onChange.
  import StateDropdown from "$lib/components/tasks/StateDropdown.svelte";
  import PriorityDropdown from "$lib/components/tasks/PriorityDropdown.svelte";
  import AssigneeDropdown from "$lib/components/tasks/AssigneeDropdown.svelte";
  import DateRangeDropdown, { type DateRange } from "$lib/components/tasks/DateRangeDropdown.svelte";
  import LabelDropdown from "$lib/components/tasks/LabelDropdown.svelte";
  import CycleSelect from "$lib/components/tasks/CycleSelect.svelte";
  import ModuleSelect from "$lib/components/tasks/ModuleSelect.svelte";
  import ParentSelect from "$lib/components/tasks/ParentSelect.svelte";
  import type { TaskState, TaskLabel, Cycle, Module } from "$lib/core/types.js";
  import TaskSubItemsWidget from "$lib/components/tasks/TaskSubItemsWidget.svelte";
  import TaskLinksWidget from "$lib/components/tasks/TaskLinksWidget.svelte";
  import TaskAttachmentsWidget from "$lib/components/tasks/TaskAttachmentsWidget.svelte";
  import TaskActivityFeed from "$lib/components/tasks/TaskActivityFeed.svelte";
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
  } from "$lib/components/ui/dropdown-menu/index.js";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import LinkIcon from "@lucide/svelte/icons/link";
  import BellIcon from "@lucide/svelte/icons/bell";
  import BellOffIcon from "@lucide/svelte/icons/bell-off";
  import PanelRightIcon from "@lucide/svelte/icons/panel-right";
  import SquareIcon from "@lucide/svelte/icons/square";
  import MaximizeIcon from "@lucide/svelte/icons/maximize";
  import CalendarClockIcon from "@lucide/svelte/icons/calendar-clock";
  import TagIcon from "@lucide/svelte/icons/tag";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import LayersIcon from "@lucide/svelte/icons/layers";
  import GitBranchIcon from "@lucide/svelte/icons/git-branch";
  import { resolveAssignee, type AssigneePools } from "$lib/tasks/assignee.js";
  import { resolveTaskScheduleBinding } from "$lib/schedule/task-binding.js";
  import { cronToLabel } from "$lib/schedule/recurrence.js";
  import { priorityForTask, type Priority } from "$lib/tasks/priority.js";
  import {
    statusLabel,
    statusPillClass,
    taskKey,
    projectKeyPrefix,
    stateGroupForStatus,
  } from "$lib/tasks/detail.js";
  import {
    fieldLabel,
    btnPrimary,
    btnSecondary,
    tabBar,
    tabActive,
    tabIdle,
    peekModeBar,
    peekModeBtn,
    peekModeBtnActive,
    propertyStrip,
    stripItem,
    stripItemLabel,
    detailSectionLabel,
    detailReadingColumn,
  } from "$lib/tasks/ui.js";
  import type { Task } from "$lib/core/types.js";
  import { cn } from "$lib/utils.js";

  let {
    taskId,
    workspaceId,
    onclose,
  }: {
    taskId: string;
    workspaceId: string;
    onclose?: () => void;
  } = $props();

  // The live task is read straight from workspaceState so it tracks board moves
  // and incoming broadcasts; this card patches that same array on every save.
  const task = $derived(workspaceState.tasks.find((t) => t.id === taskId) ?? null);

  // Opening a task clears its Activity notification (assignment / status change),
  // from Tasks just like opening a channel/DM clears its mentions. This card is
  // the single open path shared by the in-board peek (TaskDetailDialog) AND the
  // /tasks/item/[taskId] deep-link route, so hooking it here covers both. Clear
  // locally for an instant badge update + persist server-side (markTaskRead) so
  // the row clears on the user's other devices too. Keyed on taskId/workspaceId
  // so reopening a different task re-fires; markTaskRead is idempotent.
  $effect(() => {
    if (!taskId || !workspaceId) return;
    activityState.markReadByTask(taskId);
    client.markTaskRead(workspaceId, taskId);
  });

  const pools = $derived<AssigneePools>({
    members: workspaceState.members ?? [],
    cybos: cyboState.list ?? [],
    agents: workspaceState.agents ?? [],
  });

  const assignee = $derived(task ? resolveAssignee(task.assigneeId, pools) : null);
  const priority = $derived<Priority>(task ? priorityForTask(task) : "none");

  // ── Project catalog (states / labels / cycles / modules) ───────────────────
  // The shared dropdown editors are PROPS-CONTROLLED: the parent owns the option
  // lists. We hydrate them from the task's project on open (client.fetch*), keyed
  // off task.projectId so reopening a task in another project refetches. When a
  // list is empty (no project, or the catalog RPC is still PENDING-SERVER) the
  // matching row falls back to its read-only chip rather than an empty editor.
  let states = $state<TaskState[]>([]);
  let labels = $state<TaskLabel[]>([]);
  let cycles = $state<Cycle[]>([]);
  let modules = $state<Module[]>([]);

  $effect(() => {
    const projectId = task?.projectId ?? null;
    if (!projectId) {
      states = [];
      labels = [];
      cycles = [];
      modules = [];
      return;
    }
    let active = true;
    void Promise.all([
      client.fetchProjectStates(projectId),
      client.fetchProjectLabels(projectId),
      client.fetchCycles(projectId),
      client.fetchModules(projectId),
    ])
      .then(([s, l, c, m]) => {
        if (!active) return;
        states = s;
        labels = l;
        cycles = c;
        modules = m;
        return undefined;
      })
      // The catalog RPCs are best-effort: a failure (or a relay that doesn't yet
      // serve them) leaves the lists empty and the rows in their read-only fallback.
      // intentional: pending-server catalog hydration; rows degrade to read-only.
      .catch(() => {});
    return () => {
      active = false;
    };
  });

  // updateTask persists labels by NAME (auto-created), not id; map the editor's
  // chosen ids back through the loaded catalog for the commit, while the
  // optimistic patch still carries the id set the editor speaks.
  function labelIdsToNames(ids: string[]): string[] {
    return ids.map((id) => labels.find((l) => l.id === id)?.name).filter((n): n is string => Boolean(n));
  }

  // The DateRangeDropdown speaks ISO strings; tasks carry epoch-ms. Convert at
  // this boundary so the editor renders and the commit stays in the task model's
  // ms shape (matching client.updateTask's startDate/dueAt: number | null).
  function msToIso(ms: number | null | undefined): string | null {
    return ms == null ? null : new Date(ms).toISOString();
  }
  function isoToMs(iso: string | null): number | null {
    if (!iso) return null;
    const ms = new Date(iso).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const dateRange = $derived<DateRange>({
    startDate: msToIso(task?.startDate),
    dueAt: msToIso(task?.dueAt),
  });

  // Parent candidates: the other tasks in this workspace, excluding the task
  // itself (avoid a self-parent). ParentSelect filters locally over this list, so
  // no server search RPC is needed — onSearch is a no-op narrowing hook.
  const parentOptions = $derived(
    workspaceState.tasks
      .filter((t) => t.id !== taskId)
      .map((t) => ({
        id: t.id,
        sequenceId: t.sequenceId != null ? `#${t.sequenceId}` : `#${t.id.slice(0, 8)}`,
        title: t.title,
      })),
  );

  // The task's project (name + identifier), resolved from the warm projects
  // cache by task.projectId — the SAME source the work-items board uses to build
  // each card's "MONK-2" key. A task with no project (the workspace Inbox) or a
  // not-yet-cached project resolves to null, and the header degrades gracefully
  // (no project breadcrumb, a "#<seq>" key) instead of showing a stale "Inbox".
  const project = $derived(
    task?.projectId
      ? (projectsCache.get(workspaceId)?.projects.find((p) => p.id === task.projectId) ?? null)
      : null,
  );
  // The project's task-key prefix ("MONK"). The client Project type carries no
  // `identifier` yet (app.svelte.ts ProjectsCacheEntry), so derive the uppercase
  // ≤4-char fallback from the project NAME — matching the board card's prefix so
  // the peek header's key reads identically to the card's ("MONK-2").
  const projectIdentifier = $derived(project ? projectKeyPrefix(project.name) : null);

  // The Plane-style header bits: the project NAME breadcrumb, the human-scannable
  // issue KEY (PREFIX-sequence, e.g. "MONK-2"), and the state GROUP the legacy
  // `status` maps to (drives the StateGroupIcon glyph + tint until the per-project
  // state catalog lands server-side).
  const key = $derived(task ? taskKey(task.sequenceId, task.id, projectIdentifier) : "");
  const stateGroup = $derived(task ? stateGroupForStatus(task.status) : "unstarted");

  // The parent task (when this is a sub-task) — resolved from the same live
  // array so the breadcrumb shows the parent's key + title, not a bare id.
  const parent = $derived(
    task?.parentId ? (workspaceState.tasks.find((t) => t.id === task.parentId) ?? null) : null,
  );

  // ── Inline title edit ──────────────────────────────────────────────
  // Title is the one click-to-edit field (Plane-style); everything else is an
  // always-live control. We snapshot into a draft on edit-enter and commit on
  // blur / Enter so a mid-edit broadcast doesn't clobber the user's typing.
  let editingTitle = $state(false);
  let titleDraft = $state("");
  let descDraft = $state("");
  let editingDescription = $state(false);
  let savingField = $state<string | null>(null);

  // ── Tabs (Plane work-item tabs) ────────────────────────────────────────────
  //   • "details"  → the full editable field set + description
  //   • "activity" → the task's activity FEED (client.fetchTaskActivity), with an
  //     honest minimal fallback (created-by + updated) when the feed is empty.
  type DetailTab = "details" | "activity";
  let activeTab = $state<DetailTab>("details");

  // The peek mode toggle (Plane's side/modal/full switch), persisted to the
  // shared preference so the host panel (TaskDetailDialog) re-frames itself.
  const mode = $derived(preferencesState.tasksPeekMode);
  // The full/wide mode is the prominent layout: the body reads inside a centered,
  // bounded column (Plane's page main) instead of edge-to-edge. Side/modal keep
  // the body flush (just `px-1`) since their panels are already narrow. `bodyPad`
  // is the horizontal-padding class every body block shares so the title, strip,
  // description, and properties all stay on the same reading column edge.
  const wide = $derived(mode === "full");
  const bodyPad = $derived(wide ? detailReadingColumn : "px-1");
  const MODES: { value: TasksPeekMode; label: string; Icon: typeof PanelRightIcon }[] = [
    { value: "side", label: "Side peek", Icon: PanelRightIcon },
    { value: "modal", label: "Modal", Icon: SquareIcon },
    { value: "full", label: "Full screen", Icon: MaximizeIcon },
  ];

  // Subscribe toggle (local-only): the activity-subscription RPC is PENDING-SERVER,
  // so this reflects intent without a fabricated backend call. Mirrors Plane's
  // header bell — wired to the real RPC when it lands.
  let subscribed = $state(false);

  // Drives the "Delete task" confirmation opened from the work-item "…" menu. On a
  // successful delete the row is gone from state (broadcast), so the host closes
  // via onclose.
  let showDelete = $state(false);

  // Per-task scheduling: which cybo runs it, why it can't be scheduled, and the
  // read-only cadence summary denormalized onto the task. The Schedule property row
  // opens the editor pre-bound to this task.
  const scheduleBinding = $derived(task ? resolveTaskScheduleBinding(task, pools) : null);
  const scheduleLabel = $derived(
    task?.schedule ? cronToLabel(task.schedule.cronExpr, task.schedule.timezone) : "",
  );
  let showSchedule = $state(false);

  // Keep the description draft in sync with the task when NOT mid-save, NOT
  // mid-edit, and when the value actually differs, so a board broadcast updates
  // it but neither a save round-trip nor the user's active typing gets clobbered.
  $effect(() => {
    if (!task) return;
    const next = task.description ?? "";
    if (
      untrack(() => descDraft) !== next &&
      savingField !== "description" &&
      !untrack(() => editingDescription)
    ) {
      descDraft = next;
    }
  });

  function startTitleEdit(): void {
    if (!task) return;
    titleDraft = task.title;
    editingTitle = true;
  }

  // Apply a partial update: optimistic patch, RPC, reconcile with the server's
  // row (or revert on failure). One path for every field so behavior is uniform.
  async function commit(
    field: string,
    updates: Parameters<typeof client.updateTask>[2],
    optimistic: Partial<Task>,
  ): Promise<void> {
    if (!task) return;
    const prev = task;
    savingField = field;
    workspaceState.tasks = workspaceState.tasks.map((t) =>
      t.id === task.id ? { ...t, ...optimistic } : t,
    );
    try {
      const updated = await client.updateTask(workspaceId, task.id, updates);
      workspaceState.tasks = workspaceState.tasks.map((t) => (t.id === updated.id ? updated : t));
    } catch (err) {
      workspaceState.tasks = workspaceState.tasks.map((t) => (t.id === prev.id ? prev : t));
      toast.error(err instanceof Error ? err.message : "Couldn't save the change");
      // Rethrow so callers (approve/reject) can tell success from failure and
      // not show a success toast on a save that actually failed.
      throw err;
    } finally {
      savingField = null;
    }
  }

  // The field-level savers are wired straight to event handlers. commit()
  // rethrows on failure, but it has already reverted state + toasted the error,
  // so these swallow it — the rethrow only matters to approve/reject.
  async function saveTitle(): Promise<void> {
    editingTitle = false;
    const next = titleDraft.trim();
    if (!task || !next || next === task.title) return;
    await commit("title", { title: next }, { title: next }).catch(() => {}); // intentional: commit() already reverted + toasted; rethrow only matters to approve/reject
  }

  async function saveDescription(): Promise<void> {
    const next = descDraft.trim();
    if (!task || next === (task.description ?? "")) return;
    await commit("description", { description: next }, { description: next || null }).catch(() => {}); // intentional: commit() already reverted + toasted; rethrow only matters to approve/reject
  }

  // State — commits the chosen workflow state id (StateDropdown). The relay keeps
  // legacy `status` in sync with the state's group, so we patch only stateId.
  async function saveState(value: string): Promise<void> {
    if (!task || value === task.stateId) return;
    await commit("state", { stateId: value }, { stateId: value } as Partial<Task>).catch(() => {}); // intentional: commit() already reverted + toasted; rethrow only matters to approve/reject
  }

  async function saveAssignee(value: string | null): Promise<void> {
    if (!task || value === task.assigneeId) return;
    await commit("assignee", { assigneeId: value }, { assigneeId: value }).catch(() => {}); // intentional: commit() already reverted + toasted; rethrow only matters to approve/reject
  }

  // Dates — one DateRangeDropdown edits start + due together; it echoes the full
  // pair back as ISO, which we map to the task model's epoch-ms. Skip the commit
  // when neither half actually changed.
  async function saveDates(range: DateRange): Promise<void> {
    if (!task) return;
    const nextStart = isoToMs(range.startDate);
    const nextDue = isoToMs(range.dueAt);
    if (nextStart === (task.startDate ?? null) && nextDue === (task.dueAt ?? null)) return;
    await commit(
      "dates",
      { startDate: nextStart, dueAt: nextDue },
      { startDate: nextStart, dueAt: nextDue } as Partial<Task>,
      // intentional: commit() already reverted + toasted; rethrow only matters to approve/reject
    ).catch(() => {});
  }

  async function savePriority(value: Priority): Promise<void> {
    if (!task || value === priority) return;
    await commit(
      "priority",
      { priority: value === "none" ? null : value },
      { priority: value === "none" ? null : value } as Partial<Task>,
      // intentional: commit() already reverted + toasted; rethrow only matters to approve/reject
    ).catch(() => {});
  }

  // Labels — the editor speaks ids; updateTask persists NAMES (auto-created).
  // Optimistic patch carries the id set, the RPC sends the resolved names.
  async function saveLabels(ids: string[]): Promise<void> {
    if (!task) return;
    await commit(
      "labels",
      { labels: labelIdsToNames(ids) },
      { labelIds: ids } as Partial<Task>,
      // intentional: commit() already reverted + toasted; rethrow only matters to approve/reject
    ).catch(() => {});
  }

  // Create-by-name from the label menu: append the new name to the current set so
  // the relay auto-creates it in the project's catalog and assigns it. We refetch
  // the catalog after so the new label's id resolves on the next open.
  async function createLabel(name: string): Promise<void> {
    if (!task) return;
    const projectId = task.projectId ?? null;
    const currentNames = labelIdsToNames(task.labelIds ?? []);
    await commit("labels", { labels: [...currentNames, name] }, {}).catch(() => {}); // intentional: commit() already reverted + toasted; rethrow only matters to approve/reject
    if (projectId) {
      try {
        labels = await client.fetchProjectLabels(projectId);
      } catch {
        // Best-effort: a failed refetch just means the new chip resolves on reopen.
      }
    }
  }

  async function saveCycle(value: string | null): Promise<void> {
    if (!task || value === (task.cycleId ?? null)) return;
    await commit("cycle", { cycleId: value }, { cycleId: value } as Partial<Task>).catch(() => {}); // intentional: commit() already reverted + toasted; rethrow only matters to approve/reject
  }

  async function saveModules(ids: string[]): Promise<void> {
    if (!task) return;
    await commit("modules", { moduleIds: ids }, { moduleIds: ids } as Partial<Task>).catch(() => {}); // intentional: commit() already reverted + toasted; rethrow only matters to approve/reject
  }

  async function saveParent(value: string | null): Promise<void> {
    if (!task || value === (task.parentId ?? null)) return;
    await commit("parent", { parentId: value }, { parentId: value } as Partial<Task>).catch(() => {}); // intentional: commit() already reverted + toasted; rethrow only matters to approve/reject
  }

  // Copy a deep link to this task to the clipboard (Plane's header copy-link).
  async function copyLink(): Promise<void> {
    if (typeof window === "undefined") return;
    const url = `${window.location.origin}/workspace/${workspaceId}/tasks/${taskId}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
  }

  // Approve / reject only for a task awaiting review — same semantics the old
  // detail page had, kept on the card so a reviewer can act without leaving it.
  let actionLoading = $state(false);
  async function approve(): Promise<void> {
    actionLoading = true;
    try {
      await commit("status", { status: "done" }, { status: "done" });
      toast.success("Task approved");
    } catch {
      // commit already reverted + toasted the error; don't show a success toast.
    } finally {
      actionLoading = false;
    }
  }
  async function reject(): Promise<void> {
    actionLoading = true;
    try {
      await commit("status", { status: "pending" }, { status: "pending" });
      toast.success("Task sent back to inbox");
    } catch {
      // commit already reverted + toasted the error; don't show a success toast.
    } finally {
      actionLoading = false;
    }
  }

</script>

{#if !task}
  <div class="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
    <p class="text-sm text-content-muted">Task not found</p>
    {#if onclose}
      <button type="button" onclick={onclose} class="text-xs font-medium text-accent hover:underline">
        Close
      </button>
    {/if}
  </div>
{:else}
  <div class="flex max-h-full flex-col">
    <!-- ════════ HEADER (Plane work-item header) ════════
         State pill · task KEY · saving hint · copy-link · subscribe · the
         side/modal/full mode toggle (persists to preferencesState) · the "…"
         overflow (delete). The panel surface is wired to --shadow-peek so the
         body floats above the board like Plane's peek. -->
    <div class={cn("flex items-center gap-2", bodyPad)}>
      <!-- Plane work-item breadcrumb: the PROJECT name + the issue KEY
           ("monkmode" · "MONK-2"). The lifecycle state lives in the property
           strip below, so the header reads as a project breadcrumb, not a status
           pill. The project name is omitted for an unscoped (workspace Inbox)
           task so we never render a stale "Inbox" label. -->
      {#if project}
        <span class="max-w-40 truncate text-[12px] font-medium text-content" title={project.name}>
          {project.name}
        </span>
        <span class="text-content-muted" aria-hidden="true">/</span>
      {/if}
      <span class="text-[12px] font-medium text-content-muted">{key}</span>

      <div class="ml-auto flex items-center gap-1.5">
        {#if savingField}
          <span class="text-[11px] text-content-muted">Saving…</span>
        {/if}

        <!-- Copy link -->
        <button
          type="button"
          title="Copy link"
          aria-label="Copy link"
          onclick={copyLink}
          class="grid size-7 place-items-center rounded-[4px] text-content-muted transition-colors hover:bg-hover-gray hover:text-content focus-ring"
        >
          <LinkIcon class="size-4" />
        </button>

        <!-- Subscribe -->
        <button
          type="button"
          title={subscribed ? "Unsubscribe" : "Subscribe"}
          aria-label={subscribed ? "Unsubscribe" : "Subscribe"}
          aria-pressed={subscribed}
          onclick={() => (subscribed = !subscribed)}
          class={cn(
            "grid size-7 place-items-center rounded-[4px] transition-colors hover:bg-hover-gray focus-ring",
            subscribed ? "text-accent" : "text-content-muted hover:text-content",
          )}
        >
          {#if subscribed}
            <BellIcon class="size-4" />
          {:else}
            <BellOffIcon class="size-4" />
          {/if}
        </button>

        <!-- Side / modal / full mode toggle (Plane's peek-mode switch). -->
        <div class={peekModeBar} role="group" aria-label="Peek mode">
          {#each MODES as m (m.value)}
            <button
              type="button"
              title={m.label}
              aria-label={m.label}
              aria-pressed={mode === m.value}
              onclick={() => preferencesState.setTasksPeekMode(m.value)}
              class={cn(peekModeBtn, mode === m.value && peekModeBtnActive)}
            >
              <m.Icon class="size-3.5" />
            </button>
          {/each}
        </div>

        <!-- "…" overflow: a destructive Delete (Plane's header overflow). -->
        <DropdownMenu>
          <DropdownMenuTrigger
            title="More actions"
            aria-label="More actions"
            class="grid size-7 place-items-center rounded-[4px] text-content-muted transition-colors hover:bg-hover-gray hover:text-content focus-ring data-[state=open]:bg-hover-gray"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
            </svg>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-44">
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

    <!-- ════════ PARENT BREADCRUMB → TITLE ════════
         When this is a sub-task, a parent chip (its key + title) sits above the
         title, matching Plane's work-item breadcrumb. The title is the one
         click-to-edit field. In the wide/full layout the breadcrumb + big title
         read inside the centered reading column. -->
    {#if parent}
      <div class={cn("mt-3", bodyPad)}>
        <span class="inline-flex max-w-full items-center gap-1.5 rounded-[4px] bg-deeper px-2 py-1 text-[12px] text-content-dim">
          <GitBranchIcon class="size-3.5 shrink-0 text-content-muted" />
          <span class="shrink-0 text-content-muted">{taskKey(parent.sequenceId, parent.id)}</span>
          <span class="truncate">{parent.title}</span>
        </span>
      </div>
    {/if}

    <div class={cn("mt-2", bodyPad)}>
      {#if editingTitle}
        <!-- svelte-ignore a11y_autofocus -->
        <textarea
          bind:value={titleDraft}
          rows="2"
          autofocus
          onblur={saveTitle}
          onkeydown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              // Blur to route through the single onblur save path.
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              editingTitle = false;
            }
          }}
          class={cn(
            fieldInputClass,
            "h-auto resize-none py-1.5 font-semibold leading-snug",
            wide ? "text-2xl" : "text-lg",
          )}
        ></textarea>
      {:else}
        <button
          type="button"
          onclick={startTitleEdit}
          title="Click to edit title"
          class={cn(
            "-mx-1 block w-full rounded-md px-1 py-0.5 text-left font-semibold leading-snug text-content transition-colors hover:bg-hover-gray focus-ring",
            wide ? "text-2xl" : "text-lg",
          )}
        >
          {task.title}
        </button>
      {/if}
    </div>

    <!-- ════════ TABS (Plane work-item tabs) ════════ -->
    <div class={cn(tabBar, "mt-3", bodyPad)} role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "details"}
        onclick={() => (activeTab = "details")}
        class={cn("text-[13px] font-medium focus-ring", activeTab === "details" ? tabActive : tabIdle)}
      >
        Details
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "activity"}
        onclick={() => (activeTab = "activity")}
        class={cn("text-[13px] font-medium focus-ring", activeTab === "activity" ? tabActive : tabIdle)}
      >
        Activity
      </button>
    </div>

    <!-- Scroll body: the active tab's content, laid out inside the centered
         reading column (wide/full) or flush (side/modal) via `bodyPad`. -->
    <div class="mt-3 flex-1 overflow-y-auto pb-1">
    <div class={cn(bodyPad)}>
    {#if activeTab === "details"}
      <!-- ════════ HORIZONTAL PROPERTY STRIP (Plane WIDE view) ════════
           Directly under the title: State · Priority · Assignee · Start/Due laid
           out INLINE (not as SidebarPropertyListItem rows). Same shared dropdown
           editors (variant="row"), same props-controlled persistence through the
           optimistic `commit`. A strip item degrades to a read-only chip when its
           catalog isn't loaded (State falls back to the legacy status pill). -->
      <div class={propertyStrip}>
        <!-- State -->
        <div class={stripItem}>
          <span class={stripItemLabel}>
            <StateGroupIcon group={stateGroup} size={14} />
            State
          </span>
          {#if states.length > 0}
            <StateDropdown
              value={task.stateId ?? null}
              options={states}
              variant="row"
              onChange={saveState}
              class="min-w-0"
            />
          {:else}
            <span class={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium", statusPillClass(task.status))}>
              <StateGroupIcon group={stateGroup} size={13} />
              {statusLabel(task.status)}
            </span>
          {/if}
        </div>

        <!-- Priority -->
        <div class={stripItem}>
          <span class={stripItemLabel}>
            <PriorityIcon {priority} size={14} />
            Priority
          </span>
          <PriorityDropdown
            value={priority}
            variant="row"
            onChange={savePriority}
            class="min-w-0"
          />
        </div>

        <!-- Assignee -->
        <div class={stripItem}>
          <span class={stripItemLabel}>
            <AssigneeAvatar {assignee} size={14} />
            Assignee
          </span>
          <AssigneeDropdown
            value={task.assigneeId}
            {pools}
            variant="row"
            onChange={saveAssignee}
            class="min-w-0"
          />
        </div>

        <!-- Start + Due (one combined DateRangeDropdown; overdue tints red). -->
        <div class={stripItem}>
          <span class={stripItemLabel}>
            <CalendarClockIcon class="size-3.5" />
            Dates
          </span>
          <DateRangeDropdown
            value={dateRange}
            variant="row"
            onChange={saveDates}
            class="min-w-0"
          />
        </div>

        <!-- Schedule — opens the per-task schedule editor (pre-bound to this task).
             Shows the live cadence chip when a schedule is bound (greyed/struck when
             paused), else a quiet "Set schedule" affordance. Only cybos execute, so
             a human-assigned/unassigned task shows the disabled hint inside the
             editor. -->
        <div class={stripItem}>
          <span class={stripItemLabel}>
            <CalendarClockIcon class="size-3.5" />
            Schedule
          </span>
          <button
            type="button"
            onclick={() => (showSchedule = true)}
            class="inline-flex min-w-0 items-center gap-1.5 rounded-[4px] px-2 py-1 text-[13px] text-content transition-colors hover:bg-hover-gray focus-ring"
          >
            {#if task.schedule && scheduleLabel}
              <span class={cn("truncate", task.schedule.enabled ? "text-content" : "text-content-muted line-through")}>
                {scheduleLabel}
              </span>
            {:else}
              <span class="text-content-muted">Set schedule</span>
            {/if}
          </button>
        </div>
      </div>

      <!-- ════════ DESCRIPTION (WIDE) ════════
           Full-width rich editor: renders formatted markdown when not editing,
           edits as markdown with the chat composer's toolbar. -->
      <div class="mt-4 flex flex-col gap-1.5">
        <span class={fieldLabel}>Description</span>
        <TaskDescriptionEditor
          bind:value={descDraft}
          bind:editing={editingDescription}
          onsave={saveDescription}
        />
      </div>

      <!-- ════════ SUB-WORK-ITEMS + LINKS + ATTACHMENTS (Plane work-item body) ════
           The "Add sub-work item" row lives in TaskSubItemsWidget (child tasks +
           progress ring + inline add). Links / Attachments follow, each a
           count/progress Collapsible. -->
      <div class="mt-5 flex flex-col gap-1.5 border-t border-edge/60 pt-3">
        <TaskSubItemsWidget {task} {workspaceId} />
        <TaskLinksWidget {task} />
        <TaskAttachmentsWidget {task} />
      </div>

      <!-- ════════ PROPERTIES (Plane "Properties" section) ════════
           The secondary properties live under a "Properties" heading, split into
           two labeled sub-groups — "Details" (Parent, Labels) and "Project
           structure" (Cycle, Modules) — kept as vertical SidebarPropertyListItem
           rows. Each editor stays props-controlled and persists through the
           optimistic `commit`; a row degrades to a read-only chip when its catalog
           isn't loaded. -->
      <div class="mt-6 border-t border-edge/60 pt-4">
        <h5 class="text-[13px] font-semibold text-content">Properties</h5>

        <!-- Details: Parent + Labels -->
        <div class="mt-3">
          <span class={detailSectionLabel}>Details</span>
          <div class="mt-1 flex flex-col divide-y divide-edge/60">
            <!-- Parent → ParentSelect (other workspace tasks; local filter). -->
            <SidebarPropertyListItem label="Parent">
              {#snippet icon()}<GitBranchIcon class="size-4" />{/snippet}
              {#snippet children()}
                <ParentSelect
                  value={task.parentId ?? null}
                  options={parentOptions}
                  variant="row"
                  onChange={saveParent}
                  class="min-w-0 flex-1"
                />
              {/snippet}
            </SidebarPropertyListItem>

            <!-- Labels → LabelDropdown (project labels; onCreate creates a label).
                 Falls back to read-only id chips when the catalog isn't loaded. -->
            <SidebarPropertyListItem label="Labels">
              {#snippet icon()}<TagIcon class="size-4" />{/snippet}
              {#snippet children()}
                {#if labels.length > 0}
                  <LabelDropdown
                    value={task.labelIds ?? []}
                    options={labels}
                    variant="row"
                    onChange={saveLabels}
                    onCreate={createLabel}
                    class="min-w-0 flex-1"
                  />
                {:else if task.labelIds && task.labelIds.length > 0}
                  <span class="truncate text-content">{task.labelIds.length} label{task.labelIds.length === 1 ? "" : "s"}</span>
                {:else}
                  <span class="text-content-muted">Empty</span>
                {/if}
              {/snippet}
            </SidebarPropertyListItem>
          </div>
        </div>

        <!-- Project structure: Cycle + Modules -->
        <div class="mt-4">
          <span class={detailSectionLabel}>Project structure</span>
          <div class="mt-1 flex flex-col divide-y divide-edge/60">
            <!-- Cycle → CycleSelect (project cycles). Falls back to read-only when
                 the cycle catalog isn't loaded. -->
            <SidebarPropertyListItem label="Cycle">
              {#snippet icon()}<RefreshCwIcon class="size-4" />{/snippet}
              {#snippet children()}
                {#if cycles.length > 0}
                  <CycleSelect
                    value={task.cycleId ?? null}
                    options={cycles}
                    variant="row"
                    onChange={saveCycle}
                    class="min-w-0 flex-1"
                  />
                {:else if task.cycleId}
                  <span class="truncate text-content">{task.cycleId.slice(0, 8)}</span>
                {:else}
                  <span class="text-content-muted">Empty</span>
                {/if}
              {/snippet}
            </SidebarPropertyListItem>

            <!-- Modules → ModuleSelect (project modules). Falls back to read-only
                 when the module catalog isn't loaded. -->
            <SidebarPropertyListItem label="Modules">
              {#snippet icon()}<LayersIcon class="size-4" />{/snippet}
              {#snippet children()}
                {#if modules.length > 0}
                  <ModuleSelect
                    value={task.moduleIds ?? []}
                    options={modules}
                    variant="row"
                    onChange={saveModules}
                    class="min-w-0 flex-1"
                  />
                {:else if task.moduleIds && task.moduleIds.length > 0}
                  <span class="truncate text-content">{task.moduleIds.length} module{task.moduleIds.length === 1 ? "" : "s"}</span>
                {:else}
                  <span class="text-content-muted">Empty</span>
                {/if}
              {/snippet}
            </SidebarPropertyListItem>
          </div>
        </div>
      </div>

      <!-- Approve / reject for a task awaiting review -->
      {#if task.status === "pending_review"}
        <div class="mt-4 flex justify-end gap-2">
          <button type="button" onclick={reject} disabled={actionLoading} class={btnSecondary}>
            Reject
          </button>
          <button type="button" onclick={approve} disabled={actionLoading} class={btnPrimary}>
            Approve
          </button>
        </div>
      {/if}
    {:else}
      <!-- ════════ ACTIVITY (Plane work-item activity feed) ════════
           The timeline + comment composer live in TaskActivityFeed: it fetches
           client.fetchTaskActivity, tolerates the PENDING-SERVER feed with the
           created/updated metadata fallback, and reuses TaskDescriptionEditor for
           the comment input (a comment is an activity row with field=comment). -->
      <TaskActivityFeed {task} {pools} {workspaceId} />
    {/if}
    </div>
    </div>
  </div>

  <!-- Destructive "Delete task" confirmation, opened from the "…" menu. On
       success the row is dropped from state via the tasks_changed "deleted"
       broadcast, so we close the host. Portals to <body>. -->
  <DeleteTaskDialog bind:open={showDelete} {workspaceId} {task} onDeleted={onclose} />

  <!-- Per-task schedule editor, opened from the Schedule property row. Pre-bound to
       this task (cybo = its assignee cybo, channel = its channelId, taskId = its
       id). Portals to <body>. -->
  {#if scheduleBinding}
    <CreateScheduleDialog
      bind:open={showSchedule}
      {workspaceId}
      taskId={task.id}
      cyboId={scheduleBinding.cyboId}
      channelId={scheduleBinding.channelId}
      disabledReason={scheduleBinding.disabledReason}
    />
  {/if}
{/if}
