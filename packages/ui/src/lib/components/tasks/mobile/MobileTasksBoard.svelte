<script lang="ts">
  // WS2 — the mobile Tasks BOARD: a full-width scroll-snap STATUS pager (one
  // workflow-state column per screen, ~6% peek of the next + a reserved left-edge
  // gutter so iOS edge-swipe-back still has a band that isn't a card). A
  // jump-to-state rail (BoardStateRail) sits on top with per-column counts; the
  // board is ALWAYS grouped by status (the incoming `groupBy` prop is honored by
  // the List/other layouts, not here — the board is a status pager by definition).
  //
  // ── Local sort (the C1 fix) ───────────────────────────────────────────────
  // The shared view.ts sortTasks() never reads `sortOrder`, so a reorder written
  // through it would be invisible. This board therefore sorts EACH column LOCALLY
  // by `sortOrder` ASC, NULLS-LAST, with `createdAt` as the tiebreak — WITHOUT
  // touching view.ts / the OrderBy enum / the desktop board. `Task.sortOrder` is
  // emitted by the relay on every payload and survives mapRawTask, so within-
  // column reorder both persists and renders.
  //
  // ── DnD (touchBoardDnd) ───────────────────────────────────────────────────
  //   pickup       250ms long-press + 10px slop, medium haptic, isBoardDragging()
  //                true for the whole drag (swipeBack suppresses edge-back).
  //   reorder      same-column drop → boardMutations.reorder(anchors). Default
  //                drop = column tail (single reorder RPC); a positioned drop
  //                anchors between the real neighbours in the dropped column.
  //   move         cross-state drop → boardMutations.move({stateId|status}); a
  //                non-tail cross-state drop sequences move → reorder.
  //   settle       on drop we pin the card at the dropped slot until the server's
  //                sortOrder lands, so the local re-sort never snaps it back.
  //   cancel       pointercancel → revert (no mutation).
  import { groupByState, groupByStatus, type GroupBy } from "$lib/tasks/view.js";
  import { boardMutations } from "$lib/tasks/boardMutations.js";
  import { openTaskDetailMobileAware } from "$lib/tasks/openDetail.js";
  import {
    createBoardDrag,
    type BoardDragSnapshot,
    type BoardDragHost,
    type DropDecision,
  } from "$lib/mobile/touchBoardDnd.js";
  import MobileBoardColumn, { type BoardColumn } from "./MobileBoardColumn.svelte";
  import MobileBoardCard from "./MobileBoardCard.svelte";
  import BoardStateRail, { type RailItem } from "./BoardStateRail.svelte";
  import StatePickerSheet from "./StatePickerSheet.svelte";
  import DeleteTaskSheet from "./DeleteTaskSheet.svelte";
  import MobileSheet from "$lib/components/MobileSheet.svelte";
  import type { Task, TaskState, TaskLabel, Cycle, Module } from "$lib/core/types.js";
  import type { AssigneePools } from "$lib/tasks/assignee.js";
  import { cn } from "$lib/utils.js";

  type TaskInit = {
    status?: string;
    assigneeId?: string | null;
    priority?: string;
    dueAt?: number | null;
    stateId?: string;
  };

  let props: {
    workspaceId: string;
    tasks: Task[];
    pools: AssigneePools;
    states: TaskState[];
    labels: TaskLabel[];
    cycles: Cycle[];
    modules: Module[];
    projectIdentifier: string | null;
    groupBy: GroupBy;
    oncreate: (init?: TaskInit) => void;
    onquickcreate?: (title: string, init: TaskInit) => Promise<boolean>;
    onGroupByChange?: (groupBy: GroupBy) => void;
  } = $props();

  // Local column sort: sortOrder ASC, NULLS-LAST, createdAt tiebreak (ascending
  // so an unranked, freshly-created card settles at the column tail).
  function sortColumn(list: Task[]): Task[] {
    return [...list].sort((a, b) => {
      const ao = a.sortOrder ?? null;
      const bo = b.sortOrder ?? null;
      if (ao == null && bo == null) return a.createdAt - b.createdAt;
      if (ao == null) return 1;
      if (bo == null) return -1;
      if (ao !== bo) return ao - bo;
      return a.createdAt - b.createdAt;
    });
  }

  // One column per workflow state (data-driven) when the project has states,
  // else the legacy four fixed status columns. ALWAYS status grouping.
  interface ColModel {
    column: BoardColumn;
    tasks: Task[];
  }
  const columns = $derived<ColModel[]>(
    (props.states.length > 0 ? groupByState(props.tasks, props.states) : groupByStatus(props.tasks)).map(
      (g) => ({
        column: {
          key: g.key,
          label: g.label,
          stateId: g.stateId,
          status: g.columnKey,
          statePhase: g.statePhase,
          stateColor: g.stateColor,
        },
        tasks: sortColumn(g.tasks),
      }),
    ),
  );

  const railItems = $derived<RailItem[]>(
    columns.map((c) => ({
      key: c.column.key,
      label: c.column.label,
      count: c.tasks.length,
      statePhase: c.column.statePhase,
      stateColor: c.column.stateColor,
    })),
  );

  // ── Drag state (reactive snapshot pushed by the controller) ─────────────────
  let drag = $state<BoardDragSnapshot | null>(null);
  const draggingId = $derived(drag?.taskId ?? null);
  // The dragged card's display data, captured once at pickup so a mid-drag
  // tasks_changed broadcast can't disrupt the floating clone (buffered → applied
  // on drop via the mutation reconcile).
  let ghostTask = $state<Task | null>(null);
  $effect(() => {
    const id = drag?.taskId;
    if (!id) {
      ghostTask = null;
      return;
    }
    if (ghostTask?.id !== id) ghostTask = props.tasks.find((t) => t.id === id) ?? null;
  });

  // ── Optimistic settle: pin the dropped card at its slot until sortOrder lands ─
  let settle = $state<{ taskId: string; colKey: string; index: number } | null>(null);
  function tasksForColumn(col: ColModel): Task[] {
    const s = settle;
    if (!s || s.colKey !== col.column.key) return col.tasks;
    const moving = col.tasks.find((t) => t.id === s.taskId);
    if (!moving) return col.tasks;
    const without = col.tasks.filter((t) => t.id !== s.taskId);
    const idx = Math.min(Math.max(s.index, 0), without.length);
    return [...without.slice(0, idx), moving, ...without.slice(idx)];
  }

  async function commit(d: DropDecision): Promise<void> {
    if (d.noChange) return;
    settle = { taskId: d.taskId, colKey: d.target.key, index: d.index };
    const anchors = { beforeId: d.beforeId, afterId: d.afterId };
    try {
      if (d.sameColumn) {
        await boardMutations.reorder(d.taskId, anchors);
      } else {
        const target = d.target.stateId ? { stateId: d.target.stateId } : { status: d.target.status };
        if (target.stateId || target.status) {
          await boardMutations.move(d.taskId, target);
          if (!d.isTail) await boardMutations.reorder(d.taskId, anchors);
        }
      }
    } catch {
      // boardMutations already reverted workspaceState + surfaced a toast.
    } finally {
      settle = null;
    }
  }

  // ── Pager scroll element + active column tracking ───────────────────────────
  let scrollerEl = $state<HTMLDivElement | null>(null);
  let activeKey = $state<string>("");
  const GUTTER_PX = 16;

  function columnElements(): HTMLElement[] {
    if (!scrollerEl) return [];
    return Array.from(scrollerEl.querySelectorAll<HTMLElement>("[data-col-key]"));
  }
  function updateActive(): void {
    const sc = scrollerEl;
    if (!sc) return;
    const scRect = sc.getBoundingClientRect();
    const mid = scRect.left + sc.clientWidth / 2;
    let best = "";
    let bestDist = Infinity;
    for (const el of columnElements()) {
      const r = el.getBoundingClientRect();
      const d = Math.abs((r.left + r.width / 2) - mid);
      if (d < bestDist) {
        bestDist = d;
        best = el.dataset.colKey ?? "";
      }
    }
    if (best) activeKey = best;
  }
  function jumpTo(key: string): void {
    const sc = scrollerEl;
    if (!sc) return;
    const el = columnElements().find((e) => e.dataset.colKey === key);
    if (!el) return;
    const scRect = sc.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    sc.scrollTo({ left: sc.scrollLeft + (elRect.left - scRect.left) - GUTTER_PX, behavior: "smooth" });
  }
  // Seed / repair the active key whenever the column set changes.
  $effect(() => {
    if (columns.length === 0) return;
    if (!columns.some((c) => c.column.key === activeKey)) activeKey = columns[0].column.key;
  });

  // ── Drag controller wiring ──────────────────────────────────────────────────
  const host: BoardDragHost = {
    scroller: () => scrollerEl,
    columnEls: () => columnElements(),
    setSnapshot: (s) => (drag = s),
    onTap: (taskId) => openTaskDetailMobileAware(taskId),
    commit: (d) => void commit(d),
  };
  const dnd = createBoardDrag(host);
  $effect(() => () => dnd.destroy());

  // ── Card ⋯ menu: move-to-state + delete ─────────────────────────────────────
  let menuTask = $state<Task | null>(null);
  let menuOpen = $state(false);
  let statePickerOpen = $state(false);
  let deleteOpen = $state(false);
  function openMenu(task: Task): void {
    menuTask = task;
    menuOpen = true;
  }
  function chooseMove(): void {
    menuOpen = false;
    statePickerOpen = true;
  }
  function chooseDelete(): void {
    menuOpen = false;
    deleteOpen = true;
  }
  function onStatePicked(stateId: string): void {
    if (menuTask) void boardMutations.move(menuTask.id, { stateId });
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-surface" style="--board-gutter: {GUTTER_PX}px; --board-peek: 6%;">
  <BoardStateRail items={railItems} {activeKey} onjump={jumpTo} />

  <!-- Status pager: full-width snap columns + a leading gutter spacer (edge-back
       band) and a trailing peek spacer (so the last column can snap to start). -->
  <div
    bind:this={scrollerEl}
    onscroll={updateActive}
    class={cn(
      "flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden",
      drag && "overflow-x-hidden",
    )}
    style="scroll-padding-left: var(--board-gutter); --board-col-w: calc(100% - var(--board-gutter) - var(--board-peek));"
  >
    <div class="shrink-0" style="flex-basis: var(--board-gutter);" aria-hidden="true"></div>
    {#each columns as col (col.column.key)}
      <MobileBoardColumn
        column={col.column}
        tasks={tasksForColumn(col)}
        labels={props.labels}
        pools={props.pools}
        projectIdentifier={props.projectIdentifier}
        {draggingId}
        isDragTarget={drag?.overKey === col.column.key}
        dropIndex={drag?.dropIndex ?? 0}
        onpickup={dnd.pointerDown}
        ontap={(id) => openTaskDetailMobileAware(id)}
        onmenu={openMenu}
        oncreate={props.oncreate}
        onquickcreate={props.onquickcreate}
      />
    {/each}
    <div class="shrink-0" style="flex-basis: var(--board-peek);" aria-hidden="true"></div>
  </div>
</div>

<!-- Floating drag clone (follows the finger). pointer-events:none so it never
     eats the move/up events the controller listens for on window. -->
{#if drag && ghostTask}
  <div
    class="pointer-events-none fixed z-[var(--z-menu)]"
    style="left: {drag.x}px; top: {drag.y}px; width: {drag.width}px;"
  >
    <MobileBoardCard
      task={ghostTask}
      labels={props.labels}
      pools={props.pools}
      projectIdentifier={props.projectIdentifier}
      ghost
    />
  </div>
{/if}

<!-- Card ⋯ action chooser → StatePickerSheet (move) + DeleteTaskSheet (delete). -->
{#if menuTask}
  <MobileSheet bind:open={menuOpen} title={menuTask.title} ariaLabel="Work item actions" onclose={() => (menuTask = null)}>
    <div class="flex flex-col pb-2">
      <button
        type="button"
        onclick={chooseMove}
        class="flex w-full items-center gap-3 rounded-[var(--radius-md)] px-2 py-3 text-left text-[15px] text-content pressable-row focus-ring"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
        </svg>
        Change state
      </button>
      <button
        type="button"
        onclick={chooseDelete}
        class="flex w-full items-center gap-3 rounded-[var(--radius-md)] px-2 py-3 text-left text-[15px] text-error pressable-row focus-ring"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" />
        </svg>
        Delete work item
      </button>
    </div>
  </MobileSheet>

  <StatePickerSheet
    bind:open={statePickerOpen}
    value={menuTask.stateId ?? null}
    options={props.states}
    onChange={onStatePicked}
  />
  <DeleteTaskSheet bind:open={deleteOpen} workspaceId={props.workspaceId} task={menuTask} />
{/if}
