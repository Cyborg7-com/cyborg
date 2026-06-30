<script lang="ts">
  // WS1 — the long-press quick-edit sheet for a list row. A bottom MobileSheet of
  // field rows; tapping a field opens the matching WS0 picker sheet (stacked on
  // top, so the action sheet stays put and several fields can be edited in a row).
  // Every edit persists through the shared useTaskDetail savers — optimistic, with
  // revert + toast.error on failure baked into the hook — so list edits behave
  // exactly like the detail screen. Also offers "Open work item" (→ the detail
  // route) and a destructive Delete (the centered DeleteTaskSheet dialog).
  //
  // OPTION SOURCES: state / cycle / module picker options come from the PAGE's
  // per-project catalog (always populated for this route, including the Inbox,
  // whose tasks carry a null projectId the hook can't fetch from); their savers
  // write ids directly so the catalog source is purely cosmetic. Labels use the
  // HOOK's catalog (detail.labels) because saveLabels maps ids → names through it,
  // so picker and saver must agree. Assignee/parent options come from the hook
  // (workspace-wide, always present).
  import MobileSheet from "$lib/components/MobileSheet.svelte";
  import StatePickerSheet from "./StatePickerSheet.svelte";
  import PriorityPickerSheet from "./PriorityPickerSheet.svelte";
  import AssigneePickerSheet from "./AssigneePickerSheet.svelte";
  import DateRangeSheet from "./DateRangeSheet.svelte";
  import LabelPickerSheet from "./LabelPickerSheet.svelte";
  import CycleModulePickerSheet from "./CycleModulePickerSheet.svelte";
  import ParentPickerSheet from "./ParentPickerSheet.svelte";
  import DeleteTaskSheet from "./DeleteTaskSheet.svelte";
  import { useTaskDetail } from "$lib/tasks/useTaskDetail.svelte.js";
  import { openTaskDetailMobileAware } from "$lib/tasks/openDetail.js";
  import { taskKey } from "$lib/tasks/detail.js";
  import { priorityForTask } from "$lib/tasks/priority.js";
  import { PRIORITIES } from "$lib/tasks/constants.js";
  import { resolveAssignee, type AssigneePools } from "$lib/tasks/assignee.js";
  import type { Task, TaskState, Cycle, Module } from "$lib/core/types.js";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";

  let {
    open = $bindable(false),
    task,
    workspaceId,
    projectIdentifier = null,
    states = [],
    cycles = [],
    modules = [],
    pools,
    onclose,
  }: {
    open?: boolean;
    task: Task;
    workspaceId: string;
    projectIdentifier?: string | null;
    states?: TaskState[];
    cycles?: Cycle[];
    modules?: Module[];
    pools: AssigneePools;
    onclose?: () => void;
  } = $props();

  // The shared, non-visual detail hook owns the catalog + every saver (optimistic
  // commit + revert + toast). taskId is a getter so the hook tracks the live row.
  const detail = useTaskDetail(() => task.id);
  // The live row (tracks optimistic patches + broadcasts); falls back to the prop
  // if the row vanishes (e.g. a delete broadcast) so the header never goes blank.
  const liveTask = $derived(detail.task ?? task);

  const key = $derived(taskKey(liveTask.sequenceId, liveTask.id, projectIdentifier));

  // Picker visibility (separate booleans so each picker's own `open=false` on pick
  // syncs back via bind:open — a single shared enum wouldn't round-trip).
  let stateOpen = $state(false);
  let priorityOpen = $state(false);
  let assigneeOpen = $state(false);
  let datesOpen = $state(false);
  let labelsOpen = $state(false);
  let cycleModOpen = $state(false);
  let parentOpen = $state(false);
  let deleteOpen = $state(false);

  // Catalog option sources (see header note).
  const stateOptions = $derived(states.length > 0 ? states : detail.states);
  const cycleOptions = $derived(cycles.length > 0 ? cycles : detail.cycles);
  const moduleOptions = $derived(modules.length > 0 ? modules : detail.modules);

  // ── current-value summaries (the trailing muted text on each row) ───────────
  const stateName = $derived(stateOptions.find((s) => s.id === liveTask.stateId)?.name ?? "—");
  const priorityName = $derived(
    PRIORITIES.find((p) => p.key === priorityForTask(liveTask))?.label ?? "—",
  );
  const assigneeName = $derived(resolveAssignee(liveTask.assigneeId, pools)?.name ?? "Unassigned");
  const labelCount = $derived((liveTask.labelIds ?? []).length);
  const labelSummary = $derived(labelCount === 0 ? "None" : `${labelCount}`);
  const cycleModSummary = $derived.by(() => {
    const c = cycleOptions.find((x) => x.id === (liveTask.cycleId ?? null))?.name;
    const m = (liveTask.moduleIds ?? []).length;
    if (c && m) return `${c} · ${m}`;
    if (c) return c;
    if (m) return `${m} module${m === 1 ? "" : "s"}`;
    return "None";
  });
  const dueSummary = $derived(
    liveTask.dueAt == null ? "None" : new Date(liveTask.dueAt).toLocaleDateString([], { month: "short", day: "numeric" }),
  );
  const parentSummary = $derived(
    liveTask.parentId
      ? (detail.parentOptions.find((p) => p.id === liveTask.parentId)?.title ?? "1")
      : "None",
  );

  function openDetailRoute(): void {
    open = false;
    onclose?.();
    openTaskDetailMobileAware(task.id);
  }
</script>

<MobileSheet bind:open {onclose} ariaLabel="Quick edit work item">
  <div class="pb-1">
    <!-- target header -->
    <div class="px-1 pb-2 text-center">
      <div class="text-xs tabular-nums text-content-muted">{key}</div>
      <div class="truncate text-sm font-semibold text-content">{liveTask.title}</div>
    </div>

    {#snippet fieldRow(label: string, current: string, onclick: () => void)}
      <button
        type="button"
        {onclick}
        class="touch-target-row pressable-row flex w-full items-center gap-3 rounded-[var(--radius-md)] px-2 py-3 text-left"
      >
        <span class="shrink-0 text-sm font-medium text-content">{label}</span>
        <span class="ml-auto min-w-0 truncate text-sm text-content-muted">{current}</span>
        <ChevronRightIcon class="size-4 shrink-0 text-content-muted" />
      </button>
    {/snippet}

    {@render fieldRow("State", stateName, () => (stateOpen = true))}
    {@render fieldRow("Priority", priorityName, () => (priorityOpen = true))}
    {@render fieldRow("Assignee", assigneeName, () => (assigneeOpen = true))}
    {@render fieldRow("Due date", dueSummary, () => (datesOpen = true))}
    {@render fieldRow("Labels", labelSummary, () => (labelsOpen = true))}
    {@render fieldRow("Cycle & Modules", cycleModSummary, () => (cycleModOpen = true))}
    {@render fieldRow("Parent", parentSummary, () => (parentOpen = true))}

    <div class="my-1 hairline-t"></div>

    <button
      type="button"
      onclick={openDetailRoute}
      class="touch-target-row pressable-row flex w-full items-center gap-3 rounded-[var(--radius-md)] px-2 py-3 text-left text-content"
    >
      <ExternalLinkIcon class="size-4 shrink-0 text-content-muted" />
      <span class="text-sm font-medium">Open work item</span>
    </button>
    <button
      type="button"
      onclick={() => (deleteOpen = true)}
      class="touch-target-row pressable-row flex w-full items-center gap-3 rounded-[var(--radius-md)] px-2 py-3 text-left text-error"
    >
      <Trash2Icon class="size-4 shrink-0" />
      <span class="text-sm font-medium">Delete</span>
    </button>
  </div>
</MobileSheet>

<!-- Picker sheets stacked ABOVE the action sheet (mounted after it in the DOM, so
     at equal --z-menu they paint on top). Each saver is the WS0 useTaskDetail one:
     optimistic + revert + toast on failure. -->
<StatePickerSheet
  bind:open={stateOpen}
  value={liveTask.stateId ?? null}
  options={stateOptions}
  onChange={(id) => detail.saveState(id)}
/>
<PriorityPickerSheet
  bind:open={priorityOpen}
  value={priorityForTask(liveTask)}
  onChange={(p) => detail.savePriority(p)}
/>
<AssigneePickerSheet
  bind:open={assigneeOpen}
  value={liveTask.assigneeId ?? null}
  {pools}
  onChange={(v) => detail.saveAssignee(v)}
/>
<DateRangeSheet
  bind:open={datesOpen}
  value={detail.dateRange}
  onChange={(r) => detail.saveDates(r)}
/>
<LabelPickerSheet
  bind:open={labelsOpen}
  value={liveTask.labelIds ?? []}
  options={detail.labels}
  onChange={(ids) => detail.saveLabels(ids)}
  onCreate={(name) => detail.createLabel(name)}
/>
<CycleModulePickerSheet
  bind:open={cycleModOpen}
  cycleValue={liveTask.cycleId ?? null}
  cycleOptions={cycleOptions}
  moduleValue={liveTask.moduleIds ?? []}
  moduleOptions={moduleOptions}
  onCycleChange={(v) => detail.saveCycle(v)}
  onModulesChange={(ids) => detail.saveModules(ids)}
/>
<ParentPickerSheet
  bind:open={parentOpen}
  value={liveTask.parentId ?? null}
  options={detail.parentOptions}
  onChange={(v) => detail.saveParent(v)}
/>

{#if deleteOpen}
  <DeleteTaskSheet
    bind:open={deleteOpen}
    {workspaceId}
    task={liveTask}
    onDeleted={() => {
      open = false;
      onclose?.();
    }}
  />
{/if}
