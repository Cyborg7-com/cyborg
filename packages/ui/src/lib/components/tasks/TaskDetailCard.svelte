<script lang="ts">
  // The editable task DETAIL BODY — our own Svelte 5 reimplementation of Plane's
  // work-item detail panel STRUCTURE + UX + colorimetry. It shows the ENRICHED
  // task and lets every field be edited.
  //
  // WS0 NOTE: the data + RPC logic (live task read, catalog hydration, the
  // optimistic commit() + every per-field saver, label id→name mapping, parent
  // options, dates ms↔ISO, mark-read, approve/reject, in-flight pendingIds) was
  // EXTRACTED VERBATIM into the shared `useTaskDetail` hook so the mobile detail
  // (WS3) reuses the exact same behavior. This component is now PRESENTATION ONLY:
  // it consumes the hook and owns the render-local state (title/description drafts,
  // tabs, peek-mode, delete/schedule dialogs, breadcrumb/key derives). The render
  // output is IDENTICAL to the pre-extraction card — the same values flow to the
  // same props; only the savers' source moved to the hook.
  //
  // This component is presentation only; it's reused by both the in-board peek
  // (<TaskDetailDialog>) and the /tasks/item/[taskId] route card, so it owns no
  // open/close state. The host decides how it's framed.
  import { untrack } from "svelte";
  import { workspaceState, projectsCache } from "$lib/state/app.svelte.js";
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
  // ── Shared dropdown EDITORS (props-controlled). Each is fed its options/pools +
  // a controlled value here, and persists through the hook's optimistic savers. ─
  import StateDropdown from "$lib/components/tasks/StateDropdown.svelte";
  import PriorityDropdown from "$lib/components/tasks/PriorityDropdown.svelte";
  import AssigneeDropdown from "$lib/components/tasks/AssigneeDropdown.svelte";
  import DateRangeDropdown from "$lib/components/tasks/DateRangeDropdown.svelte";
  import LabelDropdown from "$lib/components/tasks/LabelDropdown.svelte";
  import CycleSelect from "$lib/components/tasks/CycleSelect.svelte";
  import ModuleSelect from "$lib/components/tasks/ModuleSelect.svelte";
  import ParentSelect from "$lib/components/tasks/ParentSelect.svelte";
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
  import { resolveTaskScheduleBinding } from "$lib/schedule/task-binding.js";
  import { cronToLabel } from "$lib/schedule/recurrence.js";
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
  import { cn } from "$lib/utils.js";
  import { useTaskDetail } from "$lib/tasks/useTaskDetail.svelte.js";

  let {
    taskId,
    workspaceId,
    onclose,
  }: {
    taskId: string;
    workspaceId: string;
    onclose?: () => void;
  } = $props();

  // The shared non-visual detail hook owns data + RPC (catalog hydration, commit,
  // every saver, mark-read, approve/reject, pendingIds). taskId is a getter so the
  // hook tracks the route/peek changing which task is shown.
  const detail = useTaskDetail(() => taskId);

  // Reactive aliases so the template markup below stays IDENTICAL to the
  // pre-extraction card — the same values flow to the same props.
  const task = $derived(detail.task);
  const pools = $derived(detail.pools);
  const assignee = $derived(detail.assignee);
  const priority = $derived(detail.priority);
  const dateRange = $derived(detail.dateRange);
  const parentOptions = $derived(detail.parentOptions);
  const states = $derived(detail.states);
  const labels = $derived(detail.labels);
  const cycles = $derived(detail.cycles);
  const modules = $derived(detail.modules);

  // ── Render-only derives (project breadcrumb, KEY, parent chip, schedule) ─────
  // Resolved from the warm projects cache by task.projectId — the SAME source the
  // board uses to build each card's "MONK-2" key. A task with no project resolves
  // to null and the header degrades gracefully.
  const project = $derived(
    task?.projectId
      ? (projectsCache.get(workspaceId)?.projects.find((p) => p.id === task.projectId) ?? null)
      : null,
  );
  const projectIdentifier = $derived(project ? projectKeyPrefix(project.name) : null);
  const key = $derived(task ? taskKey(task.sequenceId, task.id, projectIdentifier) : "");
  const stateGroup = $derived(task ? stateGroupForStatus(task.status) : "unstarted");
  // The parent task (when this is a sub-task) — resolved from the same live array.
  const parent = $derived(
    task?.parentId ? (workspaceState.tasks.find((t) => t.id === task.parentId) ?? null) : null,
  );

  // ── Inline title edit (render state) ───────────────────────────────────────
  // Title is the one click-to-edit field; we snapshot into a draft on edit-enter
  // and commit on blur / Enter so a mid-edit broadcast doesn't clobber typing.
  let editingTitle = $state(false);
  let titleDraft = $state("");
  let descDraft = $state("");
  let editingDescription = $state(false);

  // ── Tabs (Plane work-item tabs): Details · Activity ─────────────────────────
  type DetailTab = "details" | "activity";
  let activeTab = $state<DetailTab>("details");

  // The peek mode toggle (Plane's side/modal/full switch), persisted so the host
  // panel (TaskDetailDialog) re-frames itself.
  const mode = $derived(preferencesState.tasksPeekMode);
  const wide = $derived(mode === "full");
  const bodyPad = $derived(wide ? detailReadingColumn : "px-1");
  const MODES: { value: TasksPeekMode; label: string; Icon: typeof PanelRightIcon }[] = [
    { value: "side", label: "Side peek", Icon: PanelRightIcon },
    { value: "modal", label: "Modal", Icon: SquareIcon },
    { value: "full", label: "Full screen", Icon: MaximizeIcon },
  ];

  // Subscribe toggle (local-only): the activity-subscription RPC is PENDING-SERVER.
  let subscribed = $state(false);
  // Drives the "Delete task" confirmation opened from the work-item "…" menu.
  let showDelete = $state(false);

  // Per-task scheduling: which cybo runs it + the read-only cadence summary.
  const scheduleBinding = $derived(task ? resolveTaskScheduleBinding(task, pools) : null);
  const scheduleLabel = $derived(
    task?.schedule ? cronToLabel(task.schedule.cronExpr, task.schedule.timezone) : "",
  );
  let showSchedule = $state(false);

  // Keep the description draft in sync with the task when NOT mid-save, NOT
  // mid-edit, and when the value actually differs, so a board broadcast updates it
  // but neither a save round-trip nor the user's active typing gets clobbered.
  $effect(() => {
    const t = detail.task;
    if (!t) return;
    const next = t.description ?? "";
    if (
      untrack(() => descDraft) !== next &&
      !detail.pendingIds.has("description") &&
      !untrack(() => editingDescription)
    ) {
      descDraft = next;
    }
  });

  function startTitleEdit(): void {
    const t = detail.task;
    if (!t) return;
    titleDraft = t.title;
    editingTitle = true;
  }

  // Title commits route through the single onblur path: close the editor, then the
  // hook's saver applies the trimmed change (no-op if unchanged / empty).
  function onTitleBlur(): void {
    editingTitle = false;
    void detail.saveTitle(titleDraft);
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
    <!-- ════════ HEADER (Plane work-item header) ════════ -->
    <div class={cn("flex items-center gap-2", bodyPad)}>
      {#if project}
        <span class="max-w-40 truncate text-[12px] font-medium text-content" title={project.name}>
          {project.name}
        </span>
        <span class="text-content-muted" aria-hidden="true">/</span>
      {/if}
      <span class="text-[12px] font-medium text-content-muted">{key}</span>

      <div class="ml-auto flex items-center gap-1.5">
        {#if detail.pendingIds.size > 0}
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

    <!-- ════════ PARENT BREADCRUMB → TITLE ════════ -->
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
          onblur={onTitleBlur}
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

    <!-- Scroll body: the active tab's content. -->
    <div class="mt-3 flex-1 overflow-y-auto pb-1">
    <div class={cn(bodyPad)}>
    {#if activeTab === "details"}
      <!-- ════════ HORIZONTAL PROPERTY STRIP (Plane WIDE view) ════════ -->
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
              onChange={detail.saveState}
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
            onChange={detail.savePriority}
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
            onChange={detail.saveAssignee}
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
            onChange={detail.saveDates}
            class="min-w-0"
          />
        </div>

        <!-- Schedule — opens the per-task schedule editor (pre-bound to this task). -->
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

      <!-- ════════ DESCRIPTION (WIDE) ════════ -->
      <div class="mt-4 flex flex-col gap-1.5">
        <span class={fieldLabel}>Description</span>
        <TaskDescriptionEditor
          bind:value={descDraft}
          bind:editing={editingDescription}
          onsave={() => detail.saveDescription(descDraft)}
        />
      </div>

      <!-- ════════ SUB-WORK-ITEMS + LINKS + ATTACHMENTS (Plane work-item body) ════ -->
      <div class="mt-5 flex flex-col gap-1.5 border-t border-edge/60 pt-3">
        <TaskSubItemsWidget {task} {workspaceId} />
        <TaskLinksWidget {task} />
        <TaskAttachmentsWidget {task} />
      </div>

      <!-- ════════ PROPERTIES (Plane "Properties" section) ════════ -->
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
                  onChange={detail.saveParent}
                  class="min-w-0 flex-1"
                />
              {/snippet}
            </SidebarPropertyListItem>

            <!-- Labels → LabelDropdown (project labels; onCreate creates a label). -->
            <SidebarPropertyListItem label="Labels">
              {#snippet icon()}<TagIcon class="size-4" />{/snippet}
              {#snippet children()}
                {#if labels.length > 0}
                  <LabelDropdown
                    value={task.labelIds ?? []}
                    options={labels}
                    variant="row"
                    onChange={detail.saveLabels}
                    onCreate={detail.createLabel}
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
            <!-- Cycle → CycleSelect (project cycles). -->
            <SidebarPropertyListItem label="Cycle">
              {#snippet icon()}<RefreshCwIcon class="size-4" />{/snippet}
              {#snippet children()}
                {#if cycles.length > 0}
                  <CycleSelect
                    value={task.cycleId ?? null}
                    options={cycles}
                    variant="row"
                    onChange={detail.saveCycle}
                    class="min-w-0 flex-1"
                  />
                {:else if task.cycleId}
                  <span class="truncate text-content">{task.cycleId.slice(0, 8)}</span>
                {:else}
                  <span class="text-content-muted">Empty</span>
                {/if}
              {/snippet}
            </SidebarPropertyListItem>

            <!-- Modules → ModuleSelect (project modules). -->
            <SidebarPropertyListItem label="Modules">
              {#snippet icon()}<LayersIcon class="size-4" />{/snippet}
              {#snippet children()}
                {#if modules.length > 0}
                  <ModuleSelect
                    value={task.moduleIds ?? []}
                    options={modules}
                    variant="row"
                    onChange={detail.saveModules}
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
          <button type="button" onclick={detail.reject} disabled={detail.pendingIds.has("status")} class={btnSecondary}>
            Reject
          </button>
          <button type="button" onclick={detail.approve} disabled={detail.pendingIds.has("status")} class={btnPrimary}>
            Approve
          </button>
        </div>
      {/if}
    {:else}
      <!-- ════════ ACTIVITY (Plane work-item activity feed) ════════ -->
      <TaskActivityFeed {task} {pools} {workspaceId} />
    {/if}
    </div>
    </div>
  </div>

  <!-- Destructive "Delete task" confirmation, opened from the "…" menu. -->
  <DeleteTaskDialog bind:open={showDelete} {workspaceId} {task} onDeleted={onclose} />

  <!-- Per-task schedule editor, opened from the Schedule property row. -->
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
