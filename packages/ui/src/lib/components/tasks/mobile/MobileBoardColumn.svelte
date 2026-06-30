<script module lang="ts">
  import type { TaskState } from "$lib/core/types.js";

  // One board column's identity + drop target. `stateId` for a data-driven
  // workflow-state column (the board's normal mode), `status` for the legacy
  // four-column fallback. `statePhase` / `stateColor` drive the header glyph.
  export interface BoardColumn {
    key: string;
    label: string;
    stateId?: string;
    status?: string;
    statePhase?: TaskState["group"];
    stateColor?: string;
  }
</script>

<script lang="ts">
  // WS2 — one full-width PAGE of the mobile board's status pager. A column maps
  // to one workflow state (data-driven: `stateId`) or, with no project states, a
  // legacy status bucket (`status`). It carries `data-col-key` / `data-state-id`
  // / `data-status` so the drag controller (touchBoardDnd) can resolve a drop
  // target off the DOM, and each card carries `data-task-id`.
  //
  // The card list arrives ALREADY locally sorted by the board (sortOrder asc,
  // NULLS-LAST → createdAt) — the column does not re-sort. While a card is being
  // dragged it is dropped from THIS column's render (its slot closes up) and,
  // when this column is the drag target, a thin insertion line marks where the
  // card would land. `animate:flip` makes post-drop reorders / cross-state moves
  // glide instead of snapping.
  import { flip } from "svelte/animate";
  import StateGroupIcon from "$lib/components/tasks/StateGroupIcon.svelte";
  import MobileBoardCard from "./MobileBoardCard.svelte";
  import { boardQuickAddCard, boardQuickAddInput, boardQuickAddHint } from "$lib/tasks/ui.js";
  import type { Task, TaskLabel } from "$lib/core/types.js";
  import type { AssigneePools } from "$lib/tasks/assignee.js";
  import { cn } from "$lib/utils.js";

  // The create prefill a column seeds (mirrors TasksBoard initialValuesFor): the
  // state column seeds `stateId`, the legacy column seeds `status`.
  type TaskInit = { status?: string; stateId?: string };

  let {
    column,
    tasks,
    labels = [],
    pools,
    projectIdentifier = null,
    draggingId = null,
    isDragTarget = false,
    dropIndex = 0,
    pendingIds,
    onpickup,
    ontap,
    onmenu,
    oncreate,
    onquickcreate,
  }: {
    column: BoardColumn;
    tasks: Task[];
    labels?: TaskLabel[];
    pools: AssigneePools;
    projectIdentifier?: string | null;
    // The id of the card currently being dragged (dropped from this render).
    draggingId?: string | null;
    // This column is the drag's current target → show the insertion line.
    isDragTarget?: boolean;
    dropIndex?: number;
    pendingIds?: Set<string>;
    onpickup: (e: PointerEvent, taskId: string, colKey: string) => void;
    ontap: (taskId: string) => void;
    onmenu: (task: Task) => void;
    oncreate?: (init: TaskInit) => void;
    onquickcreate?: (title: string, init: TaskInit) => Promise<boolean>;
  } = $props();

  const init = $derived<TaskInit>(
    column.stateId ? { stateId: column.stateId } : column.status ? { status: column.status } : {},
  );
  const canCreate = $derived(column.stateId != null || column.status != null);

  // Cards rendered now: the dragged card is dropped so the column closes up. The
  // controller skips it by id anyway, so no DOM placeholder is needed.
  const visibleTasks = $derived(tasks.filter((t) => t.id !== draggingId));

  // ── Inline quick-add (Plane KanbanQuickAddIssue), foot of the column ─────────
  let composerOpen = $state(false);
  let composerTitle = $state("");
  let composerEl = $state<HTMLInputElement | null>(null);

  function openComposer(): void {
    if (onquickcreate) {
      composerTitle = "";
      composerOpen = true;
    } else {
      oncreate?.(init);
    }
  }
  function closeComposer(): void {
    composerOpen = false;
    composerTitle = "";
  }
  async function submitComposer(): Promise<void> {
    const title = composerTitle.trim();
    if (!title || !onquickcreate) return;
    composerTitle = "";
    composerEl?.focus();
    await onquickcreate(title, init);
  }
  function focusOnMount(node: HTMLInputElement): void {
    node.focus();
  }
</script>

<section
  data-col-key={column.key}
  data-state-id={column.stateId ?? ""}
  data-status={column.status ?? ""}
  aria-label={column.label}
  class="flex min-h-0 shrink-0 snap-start flex-col"
  style="flex-basis: var(--board-col-w);"
>
  <!-- Column header: state glyph + name + count + create. -->
  <header class="material-bar hairline-b flex shrink-0 items-center gap-2 px-3 py-2">
    {#if column.statePhase}
      <StateGroupIcon group={column.statePhase} color={column.stateColor} size={16} class="shrink-0" />
    {/if}
    <span class="min-w-0 flex-1 truncate text-sm font-semibold text-content">{column.label}</span>
    <span class="shrink-0 tabular-nums text-sm font-medium text-content-muted">{tasks.length}</span>
    {#if canCreate && (oncreate || onquickcreate)}
      <button
        type="button"
        aria-label={`Add work item to ${column.label}`}
        title="Add work item"
        onclick={openComposer}
        class="grid size-7 shrink-0 place-items-center rounded-[var(--radius-sm)] text-content-muted transition-colors hover:bg-hover-gray hover:text-content focus-ring"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    {/if}
  </header>

  <!-- Card stack: scrolls within the column; the pager scrolls horizontally. -->
  <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-2 py-2">
    {#each visibleTasks as task, i (task.id)}
      <!-- The animated wrapper must be the SOLE child of the keyed each, so the
           insertion line above the drop index is drawn as a ::before accent bar
           (`.drop-here`) sitting in the gap — no layout shift, no extra node. -->
      <div animate:flip={{ duration: 180 }} class={cn(isDragTarget && dropIndex === i && "drop-here")}>
        <MobileBoardCard
          {task}
          {labels}
          {pools}
          {projectIdentifier}
          pending={pendingIds?.has(task.id) ?? false}
          onpickup={(e) => onpickup(e, task.id, column.key)}
          ontap={() => ontap(task.id)}
          onmenu={() => onmenu(task)}
        />
      </div>
    {/each}
    {#if isDragTarget && dropIndex >= visibleTasks.length}
      <div class="h-0.5 shrink-0 rounded-full bg-accent" aria-hidden="true"></div>
    {/if}

    <!-- Foot quick-add: inline composer (onquickcreate) or a New-work-item row. -->
    {#if canCreate && (oncreate || onquickcreate)}
      <div class="shrink-0 pt-0.5">
        {#if composerOpen}
          <div class={boardQuickAddCard}>
            <div class="p-3">
              {#if projectIdentifier}
                <span class="block text-[11px] font-medium leading-5 text-content-muted">
                  {projectIdentifier}
                </span>
              {/if}
              <input
                bind:this={composerEl}
                bind:value={composerTitle}
                use:focusOnMount
                type="text"
                autocomplete="off"
                placeholder="Work item title"
                aria-label="Work item title"
                class={boardQuickAddInput}
                onkeydown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submitComposer();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    closeComposer();
                  }
                }}
                onblur={closeComposer}
              />
            </div>
            <div class={boardQuickAddHint}>Press 'Enter' to add another work item</div>
          </div>
        {:else}
          <button
            type="button"
            aria-label={`New work item in ${column.label}`}
            onclick={openComposer}
            class={cn(
              "flex w-full items-center gap-1.5 rounded-[var(--radius-md)] px-2 py-2 text-sm text-content-muted",
              "transition-colors hover:bg-hover-gray hover:text-content focus-ring",
            )}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>New work item</span>
          </button>
        {/if}
      </div>
    {/if}
  </div>
</section>

<style>
  /* Insertion indicator: a 2px accent bar in the gap ABOVE the drop slot. A
     ::before keeps the animated wrapper the sole each child (animation_invalid_
     placement) and avoids any layout shift while dragging. */
  .drop-here {
    position: relative;
  }
  .drop-here::before {
    content: "";
    position: absolute;
    top: -5px;
    left: 0;
    right: 0;
    height: 2px;
    border-radius: 9999px;
    background: var(--color-accent);
  }
</style>
