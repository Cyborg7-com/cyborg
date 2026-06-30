<script lang="ts">
  // WS3 — the full-screen, phone-native task DETAIL screen. This REPLACES the WS0
  // interim (which just framed the desktop TaskDetailCard). It is a pushed ROUTE
  // (mounted by /tasks/item/[taskId]/+page.svelte on mobile), never a sheet.
  //
  // Behavior is shared VERBATIM with the desktop peek via the frozen `useTaskDetail`
  // hook (live task read, catalog hydration, the optimistic commit() + every
  // per-field saver, mark-read, approve/reject, pendingIds) — this component is
  // PRESENTATION ONLY and owns just the render-local state (title/description
  // drafts, the Details/Activity segment, the picker-sheet open flags). Every
  // scalar / multiselect edit goes through a WS0 picker sheet wired to the hook's
  // saver, so it is optimistic with a revert + toast on failure (the hook owns
  // that). Title + description edit in place. Activity is READ-ONLY (no
  // add_task_comment RPC exists). Token-only; no client path bypasses workspace
  // visibility (every read/write flows through the hook).
  import { untrack } from "svelte";
  import { workspaceState, projectsCache } from "$lib/state/app.svelte.js";
  import { toast } from "svelte-sonner";
  import { useTaskDetail } from "$lib/tasks/useTaskDetail.svelte.js";
  import { openTaskDetailMobileAware } from "$lib/tasks/openDetail.js";
  import { goBackFromConversation } from "$lib/mobile/swipeBack.js";
  import { applyMarkdown } from "$lib/composer-markdown.js";

  // Shared primitives + WS0 picker sheets (consumed, never re-created).
  import MobileSheet from "$lib/components/MobileSheet.svelte";
  import SegmentedControl from "$lib/components/ui/SegmentedControl.svelte";
  import MobilePropertyRow from "./MobilePropertyRow.svelte";
  import StatePickerSheet from "./StatePickerSheet.svelte";
  import PriorityPickerSheet from "./PriorityPickerSheet.svelte";
  import AssigneePickerSheet from "./AssigneePickerSheet.svelte";
  import LabelPickerSheet from "./LabelPickerSheet.svelte";
  import DateRangeSheet from "./DateRangeSheet.svelte";
  import ParentPickerSheet from "./ParentPickerSheet.svelte";
  import CycleModulePickerSheet from "./CycleModulePickerSheet.svelte";
  import DeleteTaskSheet from "./DeleteTaskSheet.svelte";

  // Reused leaf widgets (presentation + RPC owned by the leaf; not edited here).
  import TaskSubItemsWidget from "$lib/components/tasks/TaskSubItemsWidget.svelte";
  import TaskLinksWidget from "$lib/components/tasks/TaskLinksWidget.svelte";
  import TaskAttachmentsWidget from "$lib/components/tasks/TaskAttachmentsWidget.svelte";
  import TaskActivityFeed from "$lib/components/tasks/TaskActivityFeed.svelte";
  import CreateScheduleDialog from "$lib/components/tasks/CreateScheduleDialog.svelte";

  // Leaf glyphs for the compact value displays + the description renderer.
  import StateGroupIcon from "$lib/components/tasks/StateGroupIcon.svelte";
  import PriorityIcon from "$lib/components/tasks/PriorityIcon.svelte";
  import AssigneeAvatar from "$lib/components/tasks/AssigneeAvatar.svelte";
  import MessageRenderer from "$lib/components/message/MessageRenderer.svelte";

  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
  import GitBranchIcon from "@lucide/svelte/icons/git-branch";
  import TagIcon from "@lucide/svelte/icons/tag";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import LayersIcon from "@lucide/svelte/icons/layers";
  import CalendarClockIcon from "@lucide/svelte/icons/calendar-clock";
  import LinkIcon from "@lucide/svelte/icons/link";
  import BellIcon from "@lucide/svelte/icons/bell";
  import BellOffIcon from "@lucide/svelte/icons/bell-off";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
  import UserIcon from "@lucide/svelte/icons/user";
  import FlagIcon from "@lucide/svelte/icons/flag";
  import BoldIcon from "@lucide/svelte/icons/bold";
  import ItalicIcon from "@lucide/svelte/icons/italic";
  import ListIcon from "@lucide/svelte/icons/list";

  import {
    statusLabel,
    statusPillClass,
    taskKey,
    projectKeyPrefix,
    stateGroupForStatus,
  } from "$lib/tasks/detail.js";
  import { resolveTaskScheduleBinding } from "$lib/schedule/task-binding.js";
  import { cronToLabel } from "$lib/schedule/recurrence.js";
  import { fieldInputClass } from "$lib/components/Field.svelte";
  import { btnPrimary, btnSecondary, detailSectionLabel } from "$lib/tasks/ui.js";
  import { cn } from "$lib/utils.js";

  // Frozen prop contract (set by the route page): { taskId, workspaceId }.
  let {
    taskId,
    workspaceId,
  }: {
    taskId: string;
    workspaceId: string;
  } = $props();

  // The shared non-visual detail hook owns DATA + RPC. taskId is a getter so the
  // hook re-tracks when a sub-item / parent navigation swaps the route param.
  const detail = useTaskDetail(() => taskId);

  // Reactive aliases (getters keep the consumer reactive).
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

  // ── Render-only derives (breadcrumb / KEY / parent / state name) ─────────────
  const project = $derived(
    task?.projectId
      ? (projectsCache.get(workspaceId)?.projects.find((p) => p.id === task.projectId) ?? null)
      : null,
  );
  const projectIdentifier = $derived(project ? projectKeyPrefix(project.name) : null);
  const key = $derived(task ? taskKey(task.sequenceId, task.id, projectIdentifier) : "");
  const stateGroup = $derived(task ? stateGroupForStatus(task.status) : "unstarted");
  const parent = $derived(
    task?.parentId ? (workspaceState.tasks.find((t) => t.id === task.parentId) ?? null) : null,
  );
  const selectedState = $derived(
    task?.stateId ? (states.find((s) => s.id === task.stateId) ?? null) : null,
  );

  // Compact value-display derives for the property rows.
  const stateName = $derived(selectedState?.name ?? statusLabel(task?.status ?? ""));
  const labelNames = $derived(
    (task?.labelIds ?? [])
      .map((id) => labels.find((l) => l.id === id)?.name)
      .filter((n): n is string => Boolean(n)),
  );
  const labelCount = $derived(task?.labelIds?.length ?? 0);
  const cycleName = $derived(
    task?.cycleId ? (cycles.find((c) => c.id === task.cycleId)?.name ?? null) : null,
  );
  const moduleCount = $derived(task?.moduleIds?.length ?? 0);
  const datesLabel = $derived(formatDates(task?.startDate ?? null, task?.dueAt ?? null));

  // Per-task scheduling: which cybo runs it + the read-only cadence summary.
  const scheduleBinding = $derived(task ? resolveTaskScheduleBinding(task, pools) : null);
  const scheduleLabel = $derived(
    task?.schedule ? cronToLabel(task.schedule.cronExpr, task.schedule.timezone) : "",
  );

  function formatDate(ms: number | null): string {
    if (ms == null) return "";
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function formatDates(start: number | null, due: number | null): string {
    const s = formatDate(start);
    const d = formatDate(due);
    if (s && d) return `${s} → ${d}`;
    if (d) return `Due ${d}`;
    if (s) return `Starts ${s}`;
    return "";
  }

  // ── Details / Activity segment ───────────────────────────────────────────────
  let activeTab = $state<"details" | "activity">("details");
  const tabOptions = [
    { value: "details", label: "Details" },
    { value: "activity", label: "Activity" },
  ];

  // ── Inline title edit ────────────────────────────────────────────────────────
  let editingTitle = $state(false);
  let titleDraft = $state("");
  function startTitleEdit(): void {
    const t = detail.task;
    if (!t) return;
    titleDraft = t.title;
    editingTitle = true;
  }
  function onTitleBlur(): void {
    editingTitle = false;
    void detail.saveTitle(titleDraft);
  }

  // ── Inline description edit (4-button toolbar via applyMarkdown) ──────────────
  let editingDescription = $state(false);
  let descDraft = $state("");
  let descTextarea = $state<HTMLTextAreaElement | null>(null);
  let descEditorEl = $state<HTMLDivElement | null>(null);

  // Keep the draft in sync with the task when NOT mid-save and NOT mid-edit, so an
  // incoming broadcast updates it but neither a save round-trip nor active typing
  // gets clobbered (mirrors TaskDetailCard).
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

  const hasDescription = $derived(descDraft.trim().length > 0);

  function startDescriptionEdit(): void {
    if (!detail.task) return;
    editingDescription = true;
  }
  // Commit on blur ONLY when focus left the editor entirely (so tapping a format
  // button — which keeps focus via pointerdown preventDefault — never exits/saves
  // mid-format). Tapping elsewhere on the page commits and closes the editor.
  function onDescriptionBlur(e: FocusEvent): void {
    const next = e.relatedTarget as Node | null;
    if (next && descEditorEl?.contains(next)) return;
    editingDescription = false;
    void detail.saveDescription(descDraft);
  }
  function commitDescription(): void {
    editingDescription = false;
    void detail.saveDescription(descDraft);
  }

  // Pure markdown transforms over the textarea's live selection, writing the result
  // back + restoring the caret — the exact web/composer path (mirrors
  // TaskDescriptionEditor). The toolbar buttons keep textarea focus via
  // pointerdown→preventDefault, so the caret/selection survives the tap.
  function wrapSelection(before: string, after: string): void {
    if (!descTextarea) return;
    const r = applyMarkdown(descDraft, descTextarea.selectionStart, descTextarea.selectionEnd, {
      kind: "wrap",
      before,
      after,
      trimSelection: false,
    });
    descDraft = r.text;
    requestAnimationFrame(() => {
      if (!descTextarea) return;
      descTextarea.selectionStart = r.selStart;
      descTextarea.selectionEnd = r.selEnd;
      descTextarea.focus();
    });
  }
  function insertBulletPrefix(): void {
    if (!descTextarea) return;
    const start = descTextarea.selectionStart;
    const r = applyMarkdown(descDraft, start, start, { kind: "linePrefix", prefix: "• " });
    descDraft = r.text;
    requestAnimationFrame(() => {
      if (!descTextarea) return;
      descTextarea.selectionStart = r.selEnd;
      descTextarea.selectionEnd = r.selEnd;
      descTextarea.focus();
    });
  }
  function insertLink(): void {
    if (!descTextarea) return;
    const r = applyMarkdown(descDraft, descTextarea.selectionStart, descTextarea.selectionEnd, {
      kind: "insert",
      content: "[text](url)",
    });
    descDraft = r.text;
    requestAnimationFrame(() => {
      if (!descTextarea) return;
      descTextarea.selectionStart = r.selEnd - 4;
      descTextarea.selectionEnd = r.selEnd - 1;
      descTextarea.focus();
    });
  }
  function toggleBold(): void {
    wrapSelection("*", "*");
  }
  function toggleItalic(): void {
    wrapSelection("_", "_");
  }

  // ── Picker sheets (one instance each; the property row opens its sheet) ───────
  let stateSheet = $state(false);
  let prioritySheet = $state(false);
  let assigneeSheet = $state(false);
  let dateSheet = $state(false);
  let labelSheet = $state(false);
  let parentSheet = $state(false);
  let cycleModuleSheet = $state(false);

  // ── Header overflow (copy-link · subscribe[honest] · delete) ─────────────────
  let overflowSheet = $state(false);
  let showDelete = $state(false);
  let showSchedule = $state(false);
  // Subscribe is LOCAL-ONLY (no server persistence); labeled honestly in the menu.
  let subscribed = $state(false);

  async function copyLink(): Promise<void> {
    overflowSheet = false;
    if (typeof window === "undefined") return;
    const url = `${window.location.origin}/workspace/${workspaceId}/tasks/item/${taskId}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
  }
  function openDelete(): void {
    overflowSheet = false;
    showDelete = true;
  }
  // The task is gone after a confirmed delete — return to the list it was opened
  // from (swipeBack computes the origin / falls back to history).
  function onDeleted(): void {
    goBackFromConversation();
  }

  // Parent breadcrumb tap → push the parent's detail (mobile-aware opener records
  // this route as the back origin, so the parent's back returns here).
  function openParent(): void {
    if (parent) openTaskDetailMobileAware(parent.id);
  }
</script>

<div class="flex h-full flex-col overflow-hidden bg-surface">
  <!-- ════════ HEADER (back · breadcrumb · overflow) ════════ -->
  <header class="material-bar hairline-b flex h-11 shrink-0 items-center gap-1 px-1">
    <button
      type="button"
      onclick={goBackFromConversation}
      aria-label="Back"
      class="grid size-9 shrink-0 place-items-center rounded-full text-content transition-colors hover:bg-hover-gray focus-ring"
    >
      <ChevronLeftIcon class="size-5" />
    </button>

    <div class="flex min-w-0 flex-1 items-center gap-1.5">
      {#if project}
        <span class="max-w-32 truncate text-[13px] font-medium text-content" title={project.name}>
          {project.name}
        </span>
        <span class="text-content-muted" aria-hidden="true">/</span>
      {/if}
      {#if key}
        <span class="shrink-0 text-[13px] font-medium text-content-muted">{key}</span>
      {/if}
    </div>

    <div class="flex shrink-0 items-center gap-1">
      {#if detail.pendingIds.size > 0}
        <span class="text-[11px] text-content-muted">Saving…</span>
      {/if}
      <button
        type="button"
        onclick={() => (overflowSheet = true)}
        aria-label="More actions"
        class="grid size-9 place-items-center rounded-full text-content-muted transition-colors hover:bg-hover-gray hover:text-content focus-ring"
      >
        <EllipsisIcon class="size-5" />
      </button>
    </div>
  </header>

  {#if !task}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <p class="text-sm text-content-muted">Work item not found</p>
      <button
        type="button"
        onclick={goBackFromConversation}
        class="text-xs font-medium text-accent hover:underline"
      >
        Back
      </button>
    </div>
  {:else}
    <!-- ════════ SCROLL BODY ════════ -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="px-4 pb-10 pt-3">
        <!-- Parent breadcrumb → tap to open the parent's detail. -->
        {#if parent}
          <button
            type="button"
            onclick={openParent}
            class="pressable-row mb-2 inline-flex max-w-full items-center gap-1.5 rounded-[4px] bg-deeper px-2 py-1 text-[12px] text-content-dim"
          >
            <GitBranchIcon class="size-3.5 shrink-0 text-content-muted" />
            <span class="shrink-0 text-content-muted">{taskKey(parent.sequenceId, parent.id)}</span>
            <span class="truncate">{parent.title}</span>
          </button>
        {/if}

        <!-- Title — tap to edit in place. -->
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
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                editingTitle = false;
              }
            }}
            class={cn(fieldInputClass, "h-auto resize-none py-1.5 text-lg font-semibold leading-snug")}
          ></textarea>
        {:else}
          <button
            type="button"
            onclick={startTitleEdit}
            title="Tap to edit title"
            class="-mx-1 block w-full rounded-md px-1 py-0.5 text-left text-lg font-semibold leading-snug text-content transition-colors hover:bg-hover-gray focus-ring"
          >
            {task.title}
          </button>
        {/if}

        <!-- Details / Activity segment. -->
        <div class="mt-3">
          <SegmentedControl
            options={tabOptions}
            value={activeTab}
            onChange={(v) => (activeTab = v as "details" | "activity")}
            ariaLabel="Detail sections"
          />
        </div>

        {#if activeTab === "details"}
          <!-- ════════ PROPERTIES (each row → its WS0 picker sheet) ════════ -->
          <section class="mt-4">
            <h2 class={cn(detailSectionLabel, "px-4")}>Properties</h2>
            <div class="mt-1 divide-y divide-edge/60">
              <!-- State -->
              <MobilePropertyRow
                label="State"
                onclick={() => (stateSheet = true)}
                pending={detail.pendingIds.has("state")}
              >
                {#snippet icon()}<StateGroupIcon group={selectedState?.group ?? stateGroup} color={selectedState?.color} size={16} />{/snippet}
                {#snippet value()}
                  {#if selectedState}
                    <span class="truncate">{stateName}</span>
                  {:else}
                    <span class={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium", statusPillClass(task.status))}>
                      {statusLabel(task.status)}
                    </span>
                  {/if}
                {/snippet}
              </MobilePropertyRow>

              <!-- Priority -->
              <MobilePropertyRow
                label="Priority"
                onclick={() => (prioritySheet = true)}
                pending={detail.pendingIds.has("priority")}
              >
                {#snippet icon()}{#if priority !== "none"}<PriorityIcon {priority} size={16} />{:else}<FlagIcon class="size-4" />{/if}{/snippet}
                {#snippet value()}
                  {#if priority !== "none"}
                    <span class="truncate capitalize">{priority}</span>
                  {:else}
                    <span class="text-content-muted">No priority</span>
                  {/if}
                {/snippet}
              </MobilePropertyRow>

              <!-- Assignee -->
              <MobilePropertyRow
                label="Assignee"
                onclick={() => (assigneeSheet = true)}
                pending={detail.pendingIds.has("assignee")}
              >
                {#snippet icon()}{#if assignee}<AssigneeAvatar {assignee} size={16} />{:else}<UserIcon class="size-4" />{/if}{/snippet}
                {#snippet value()}
                  {#if assignee}
                    <span class="truncate">{assignee.name}</span>
                  {:else}
                    <span class="text-content-muted">Unassigned</span>
                  {/if}
                {/snippet}
              </MobilePropertyRow>

              <!-- Dates (start + due) -->
              <MobilePropertyRow
                label="Dates"
                onclick={() => (dateSheet = true)}
                pending={detail.pendingIds.has("dates")}
              >
                {#snippet icon()}<CalendarClockIcon class="size-4" />{/snippet}
                {#snippet value()}
                  {#if datesLabel}
                    <span class="truncate">{datesLabel}</span>
                  {:else}
                    <span class="text-content-muted">No dates</span>
                  {/if}
                {/snippet}
              </MobilePropertyRow>

              <!-- Labels (multi-select) -->
              <MobilePropertyRow
                label="Labels"
                onclick={() => (labelSheet = true)}
                pending={detail.pendingIds.has("labels")}
              >
                {#snippet icon()}<TagIcon class="size-4" />{/snippet}
                {#snippet value()}
                  {#if labelNames.length > 0}
                    <span class="truncate">{labelNames.join(", ")}</span>
                  {:else if labelCount > 0}
                    <span class="truncate">{labelCount} label{labelCount === 1 ? "" : "s"}</span>
                  {:else}
                    <span class="text-content-muted">Empty</span>
                  {/if}
                {/snippet}
              </MobilePropertyRow>

              <!-- Parent -->
              <MobilePropertyRow
                label="Parent"
                onclick={() => (parentSheet = true)}
                pending={detail.pendingIds.has("parent")}
              >
                {#snippet icon()}<GitBranchIcon class="size-4" />{/snippet}
                {#snippet value()}
                  {#if parent}
                    <span class="truncate">{taskKey(parent.sequenceId, parent.id)} {parent.title}</span>
                  {:else}
                    <span class="text-content-muted">None</span>
                  {/if}
                {/snippet}
              </MobilePropertyRow>

              <!-- Cycle + Modules (one sheet — both are assignable properties) -->
              <MobilePropertyRow
                label="Cycle"
                onclick={() => (cycleModuleSheet = true)}
                pending={detail.pendingIds.has("cycle")}
              >
                {#snippet icon()}<RefreshCwIcon class="size-4" />{/snippet}
                {#snippet value()}
                  {#if cycleName}
                    <span class="truncate">{cycleName}</span>
                  {:else}
                    <span class="text-content-muted">Empty</span>
                  {/if}
                {/snippet}
              </MobilePropertyRow>

              <MobilePropertyRow
                label="Modules"
                onclick={() => (cycleModuleSheet = true)}
                pending={detail.pendingIds.has("modules")}
              >
                {#snippet icon()}<LayersIcon class="size-4" />{/snippet}
                {#snippet value()}
                  {#if moduleCount > 0}
                    <span class="truncate">{moduleCount} module{moduleCount === 1 ? "" : "s"}</span>
                  {:else}
                    <span class="text-content-muted">Empty</span>
                  {/if}
                {/snippet}
              </MobilePropertyRow>

              <!-- Schedule — opens the per-task schedule editor (parity with desktop). -->
              {#if scheduleBinding}
                <MobilePropertyRow label="Schedule" onclick={() => (showSchedule = true)}>
                  {#snippet icon()}<CalendarClockIcon class="size-4" />{/snippet}
                  {#snippet value()}
                    {#if task.schedule && scheduleLabel}
                      <span class={cn("truncate", task.schedule.enabled ? "" : "text-content-muted line-through")}>
                        {scheduleLabel}
                      </span>
                    {:else}
                      <span class="text-content-muted">Set schedule</span>
                    {/if}
                  {/snippet}
                </MobilePropertyRow>
              {/if}
            </div>
          </section>

          <!-- ════════ DESCRIPTION (tap-to-edit; 4-button toolbar) ════════ -->
          <section class="mt-5">
            <h2 class={detailSectionLabel}>Description</h2>
            {#if editingDescription}
              <!-- descEditorEl is `flex` (overflow VISIBLE) so the sticky toolbar's
                   containing block is the detail SCROLL body, not this box — an
                   `overflow-hidden` wrapper would trap the sticky to the box and it
                   would NOT track the keyboard. The toolbar is a sibling of the
                   textarea (both inside descEditorEl) so a toolbar tap stays "inside
                   the editor" for the blur-containment check. -->
              <div bind:this={descEditorEl} class="mt-1.5 flex flex-col gap-2">
                <!-- svelte-ignore a11y_autofocus -->
                <textarea
                  bind:this={descTextarea}
                  bind:value={descDraft}
                  rows="6"
                  autofocus
                  placeholder="Add more detail…"
                  onfocus={(e) => e.currentTarget.scrollIntoView({ block: "center", behavior: "smooth" })}
                  onblur={onDescriptionBlur}
                  onkeydown={(e) => {
                    if (e.key === "Escape") e.currentTarget.blur();
                  }}
                  class={cn(fieldInputClass, "h-auto resize-none rounded-lg py-2")}
                ></textarea>
                <!-- Primary toolbar — sticks above the keyboard while editing.
                     Solid token bg (NOT .material-bar: its `position: relative`
                     would beat Tailwind's `sticky`). -->
                <div
                  class="sticky bottom-0 z-[1] flex items-center gap-1 rounded-lg border border-edge bg-surface-alt px-2 py-1.5 shadow-sm"
                >
                  <button type="button" aria-label="Bold" onpointerdown={(e) => e.preventDefault()} onclick={toggleBold} class="grid size-9 place-items-center rounded-[6px] text-content-dim transition-colors hover:bg-hover-gray hover:text-content focus-ring">
                    <BoldIcon class="size-4" />
                  </button>
                  <button type="button" aria-label="Italic" onpointerdown={(e) => e.preventDefault()} onclick={toggleItalic} class="grid size-9 place-items-center rounded-[6px] text-content-dim transition-colors hover:bg-hover-gray hover:text-content focus-ring">
                    <ItalicIcon class="size-4" />
                  </button>
                  <button type="button" aria-label="Bullet list" onpointerdown={(e) => e.preventDefault()} onclick={insertBulletPrefix} class="grid size-9 place-items-center rounded-[6px] text-content-dim transition-colors hover:bg-hover-gray hover:text-content focus-ring">
                    <ListIcon class="size-4" />
                  </button>
                  <button type="button" aria-label="Link" onpointerdown={(e) => e.preventDefault()} onclick={insertLink} class="grid size-9 place-items-center rounded-[6px] text-content-dim transition-colors hover:bg-hover-gray hover:text-content focus-ring">
                    <LinkIcon class="size-4" />
                  </button>
                  <button type="button" onclick={commitDescription} class="ml-auto rounded-[6px] px-3 py-1.5 text-[13px] font-medium text-accent transition-colors hover:bg-hover-gray focus-ring">
                    Done
                  </button>
                </div>
              </div>
            {:else if hasDescription}
              <!-- VIEW: rendered markdown. A div (not a button) so links stay live;
                   tapping the body (not a link) enters edit. -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                role="button"
                tabindex="0"
                onclick={(e) => {
                  if ((e.target as HTMLElement)?.closest("a, [data-mention], [data-channel-mention]")) return;
                  startDescriptionEdit();
                }}
                onkeydown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    startDescriptionEdit();
                  }
                }}
                title="Tap to edit description"
                class="-mx-1 mt-1.5 cursor-text rounded-md px-1 py-1 text-left transition-colors hover:bg-hover-gray focus-ring"
              >
                <MessageRenderer text={descDraft} class="text-sm text-content" />
              </div>
            {:else}
              <button
                type="button"
                onclick={startDescriptionEdit}
                class="-mx-1 mt-1.5 block w-full rounded-md px-1 py-1.5 text-left text-sm text-content-muted transition-colors hover:bg-hover-gray focus-ring"
              >
                Add more detail…
              </button>
            {/if}
          </section>

          <!-- ════════ SUB-ITEMS · LINKS · ATTACHMENTS (reused leaves) ════════ -->
          <!-- CSS-only touch-target wrapper: lift the leaves' sub-44px interactive
               rows/buttons to a comfortable touch size on coarse pointers without
               editing the leaf logic (Rule: CSS wrappers only). -->
          <section class="detail-widgets mt-6 flex flex-col gap-1.5 border-t border-edge/60 pt-4">
            <TaskSubItemsWidget {task} {workspaceId} />
            <TaskLinksWidget {task} />
            <TaskAttachmentsWidget {task} />
          </section>

          <!-- Approve / reject for a task awaiting review. -->
          {#if task.status === "pending_review"}
            <div class="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onclick={detail.reject}
                disabled={detail.pendingIds.has("status")}
                class={btnSecondary}
              >
                Reject
              </button>
              <button
                type="button"
                onclick={detail.approve}
                disabled={detail.pendingIds.has("status")}
                class={btnPrimary}
              >
                Approve
              </button>
            </div>
          {/if}
        {:else}
          <!-- ════════ ACTIVITY (read-only — no comment composer exists) ════════ -->
          <div class="mt-4">
            <TaskActivityFeed {task} {pools} {workspaceId} />
          </div>
        {/if}
      </div>
    </div>

    <!-- ════════ PICKER SHEETS (WS0; wired to the hook's optimistic savers) ════ -->
    <StatePickerSheet
      bind:open={stateSheet}
      value={task.stateId ?? null}
      options={states}
      onChange={detail.saveState}
    />
    <PriorityPickerSheet bind:open={prioritySheet} value={priority} onChange={detail.savePriority} />
    <AssigneePickerSheet
      bind:open={assigneeSheet}
      value={task.assigneeId}
      {pools}
      onChange={detail.saveAssignee}
    />
    <DateRangeSheet bind:open={dateSheet} value={dateRange} onChange={detail.saveDates} />
    <LabelPickerSheet
      bind:open={labelSheet}
      value={task.labelIds ?? []}
      options={labels}
      onChange={detail.saveLabels}
      onCreate={detail.createLabel}
    />
    <ParentPickerSheet
      bind:open={parentSheet}
      value={task.parentId ?? null}
      options={parentOptions}
      onChange={detail.saveParent}
    />
    <CycleModulePickerSheet
      bind:open={cycleModuleSheet}
      cycleValue={task.cycleId ?? null}
      cycleOptions={cycles}
      moduleValue={task.moduleIds ?? []}
      moduleOptions={modules}
      onCycleChange={detail.saveCycle}
      onModulesChange={detail.saveModules}
    />

    <!-- Header overflow action sheet (copy-link · subscribe[honest] · delete). -->
    <MobileSheet bind:open={overflowSheet} title="Work item" ariaLabel="Work item actions">
      <div class="flex flex-col pb-1">
        <button type="button" onclick={copyLink} class="touch-target-row pressable-row flex items-center gap-3 px-1 py-2 text-left text-[15px] text-content">
          <LinkIcon class="size-5 shrink-0 text-content-muted" />
          Copy link
        </button>
        <button
          type="button"
          onclick={() => (subscribed = !subscribed)}
          aria-pressed={subscribed}
          class="touch-target-row pressable-row flex items-center gap-3 px-1 py-2 text-left text-[15px] text-content"
        >
          {#if subscribed}
            <BellIcon class="size-5 shrink-0 text-accent" />
          {:else}
            <BellOffIcon class="size-5 shrink-0 text-content-muted" />
          {/if}
          <span class="flex flex-col">
            <span>{subscribed ? "Subscribed" : "Subscribe"}</span>
            <span class="text-[12px] text-content-muted">Notifies on this device only</span>
          </span>
        </button>
        <button type="button" onclick={openDelete} class="touch-target-row pressable-row flex items-center gap-3 px-1 py-2 text-left text-[15px] text-error">
          <Trash2Icon class="size-5 shrink-0" />
          Delete work item
        </button>
      </div>
    </MobileSheet>

    <!-- Destructive delete = centered confirm Dialog (DeleteTaskSheet → Dialog). -->
    <DeleteTaskSheet bind:open={showDelete} {workspaceId} {task} {onDeleted} />

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
</div>

<style>
  /* CSS-only touch-target lift for the reused detail widgets (sub-items / links /
     attachments). Their rows/affordances are tuned for the dense desktop peek
     (h-9 rows, size-6 icon buttons); on a coarse pointer we floor the interactive
     rows + buttons to the 44px touch target WITHOUT editing the leaf components.
     Min-HEIGHT only (never min-width) so the leaves' flex layouts are untouched. */
  @media (pointer: coarse), (max-width: 640px) {
    .detail-widgets :global(button),
    .detail-widgets :global(a) {
      min-height: 44px;
    }
    /* The widgets' inline "add" title <input>s are single-line; give them the same
       comfortable height so the tap target matches the rows. */
    .detail-widgets :global(input) {
      min-height: 40px;
    }
  }
</style>
