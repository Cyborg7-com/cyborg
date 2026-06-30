/**
 * Touch board drag-and-drop controller (WS2).
 *
 * The mobile Tasks board (`MobileTasksBoard`) is a full-width scroll-snap STATUS
 * pager — one column per screen. This module owns the pointer-driven pickup +
 * drag lifecycle for a card:
 *
 *   pickup   — 250ms long-press + a 10px movement slop (a scroll cancels it),
 *              a `medium` haptic on arm, and `setBoardDragging(true)` so the
 *              edge-swipe-back gesture (swipeBack.ts) suppresses itself for the
 *              whole drag (a long-press that begins near the left edge must NEVER
 *              be read as a back swipe — the anti-bug guardrail this seam exists
 *              for).
 *   drag     — a fixed-position floating clone follows the finger; the board is
 *              told which column it is over and which insertion index it would
 *              drop at (a thin insertion line), and the source slot collapses.
 *   auto-page— while held near the horizontal edge, the pager advances one
 *              column so a card can be carried across states (cross-state move).
 *   drop     — the controller resolves a DropDecision (same-column reorder vs
 *              cross-state move, tail vs positioned, with the real neighbour ids
 *              in the DROPPED column) and hands it to the host to persist via
 *              boardMutations. `pointercancel` reverts (no mutation).
 *
 * The frozen `isBoardDragging()` / `setBoardDragging()` seam (consumed by
 * swipeBack.ts) keeps its exact signature. It stays a plain `.ts` ESM singleton
 * — a true module singleton survives Svelte re-init, iOS WKWebView re-init, and
 * HMR, where a `let` inside a component `<script>` would be re-created and the
 * flag lost. The reactive drag SNAPSHOT lives in the component (`$state`); this
 * controller pushes it through the host's `setSnapshot` so no runes live here.
 */

import { haptic } from "./haptics";

let dragging = false;

/** WS2 calls this on pickup start (`true`) and on drop / pointercancel (`false`). */
export function setBoardDragging(active: boolean): void {
  dragging = active;
}

/** True while a board card is being dragged — honored by swipeBack to suppress edge-back. */
export function isBoardDragging(): boolean {
  return dragging;
}

// ── Drag controller ─────────────────────────────────────────────────────────

// A board column's drop target. `stateId` for a data-driven workflow-state
// column (the board's normal mode); `status` for the legacy four-column
// fallback (no project states). Exactly one is set.
export interface DragColumn {
  key: string;
  stateId?: string;
  status?: string;
}

// Live drag snapshot the board renders from (floating clone position + the
// active target column + the insertion index). Null when idle.
export interface BoardDragSnapshot {
  taskId: string;
  fromKey: string;
  overKey: string;
  dropIndex: number;
  // Floating clone top-left, viewport px (pointer minus the grab offset).
  x: number;
  y: number;
  width: number;
  height: number;
}

// The resolved drop, handed to the host to persist. The host owns the RPCs
// (boardMutations) + the post-drop settle bridge so this file stays DOM/pointer
// only and never imports app state.
export interface DropDecision {
  taskId: string;
  target: DragColumn;
  sameColumn: boolean;
  // Dropped at the column tail (no lower neighbour) — a single-RPC move.
  isTail: boolean;
  // The card landed back exactly where it started (same column, same slot): a
  // no-op the host skips entirely.
  noChange: boolean;
  // Real neighbour ids in the DROPPED column at the drop index (the card now
  // sits AFTER beforeId and BEFORE afterId). Either may be absent at a lane end.
  beforeId?: string;
  afterId?: string;
  // Insertion index among the target column's non-dragged cards — the host uses
  // it for the optimistic settle render.
  index: number;
}

export interface BoardDragHost {
  // The pager scroll container (edge auto-paging + bounds).
  scroller(): HTMLElement | null;
  // The column root elements in render order; each carries `data-col-key` and,
  // for the matching DragColumn, its `data-state-id` / `data-status`. Cards
  // inside carry `data-task-id`.
  columnEls(): HTMLElement[];
  // Push the live snapshot (or null at end) into the board's reactive state.
  setSnapshot(snapshot: BoardDragSnapshot | null): void;
  // A plain tap (release before the long-press armed, within slop) → open detail.
  onTap(taskId: string): void;
  // A resolved drop → persist.
  commit(decision: DropDecision): void;
}

const LONG_PRESS_MS = 250;
const SLOP_PX = 10;
// Horizontal band at each scroller edge that triggers auto-paging while held.
const EDGE_PAGE_PX = 44;
// Min gap between two auto-page advances so a held finger steps one column at a
// time instead of racing across the whole board.
const PAGE_COOLDOWN_MS = 480;

export function createBoardDrag(host: BoardDragHost): {
  pointerDown: (e: PointerEvent, taskId: string, columnKey: string) => void;
  destroy: () => void;
} {
  let taskId: string | null = null;
  let fromKey = "";
  let startX = 0;
  let startY = 0;
  let grabDX = 0;
  let grabDY = 0;
  let cardW = 0;
  let cardH = 0;
  let armed = false;
  let longTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPageAt = 0;
  let overKey = "";
  let dropIndex = 0;

  function clearTimer(): void {
    if (longTimer != null) {
      clearTimeout(longTimer);
      longTimer = null;
    }
  }

  // The column under an x coordinate (the pager keeps one mostly-visible
  // column, so the finger sits over the active one); nearest column otherwise.
  function columnUnder(x: number): HTMLElement | null {
    const cols = host.columnEls();
    let nearest: HTMLElement | null = null;
    let nearestDist = Infinity;
    for (const el of cols) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right) return el;
      const cx = (r.left + r.right) / 2;
      const d = Math.abs(x - cx);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = el;
      }
    }
    return nearest;
  }

  // Ordered non-dragged task ids in a column (DOM order == the board's local
  // sortOrder sort, so the neighbour ids are the real sorted neighbours).
  function orderedIds(colEl: HTMLElement): string[] {
    const ids: string[] = [];
    for (const el of colEl.querySelectorAll<HTMLElement>("[data-task-id]")) {
      const id = el.dataset.taskId;
      if (id && id !== taskId) ids.push(id);
    }
    return ids;
  }

  // The insertion index in `colEl` for pointer y: the first non-dragged card
  // whose vertical midpoint is below the finger; the tail otherwise.
  function indexFor(colEl: HTMLElement, y: number): number {
    const cards = colEl.querySelectorAll<HTMLElement>("[data-task-id]");
    let idx = 0;
    for (const el of cards) {
      if (el.dataset.taskId === taskId) continue;
      const r = el.getBoundingClientRect();
      if (y < r.top + r.height / 2) return idx;
      idx++;
    }
    return idx;
  }

  function colDescriptor(colEl: HTMLElement): DragColumn {
    const key = colEl.dataset.colKey ?? "";
    const stateId = colEl.dataset.stateId;
    const status = colEl.dataset.status;
    return { key, stateId: stateId || undefined, status: status || undefined };
  }

  function maybeAutoPage(x: number): void {
    const scroller = host.scroller();
    if (!scroller) return;
    const now = Date.now();
    if (now - lastPageAt < PAGE_COOLDOWN_MS) return;
    const r = scroller.getBoundingClientRect();
    const colW = host.columnEls()[0]?.getBoundingClientRect().width ?? r.width;
    if (x > r.right - EDGE_PAGE_PX) {
      lastPageAt = now;
      scroller.scrollBy({ left: colW, behavior: "smooth" });
    } else if (x < r.left + EDGE_PAGE_PX) {
      lastPageAt = now;
      scroller.scrollBy({ left: -colW, behavior: "smooth" });
    }
  }

  function pushSnapshot(x: number, y: number): void {
    if (!taskId) return;
    const colEl = columnUnder(x);
    overKey = colEl ? (colEl.dataset.colKey ?? fromKey) : fromKey;
    dropIndex = colEl ? indexFor(colEl, y) : dropIndex;
    host.setSnapshot({
      taskId,
      fromKey,
      overKey,
      dropIndex,
      x: x - grabDX,
      y: y - grabDY,
      width: cardW,
      height: cardH,
    });
  }

  function arm(x: number, y: number): void {
    armed = true;
    setBoardDragging(true);
    haptic("medium");
    pushSnapshot(x, y);
  }

  function onMove(e: PointerEvent): void {
    if (!taskId) return;
    const moved = Math.hypot(e.clientX - startX, e.clientY - startY);
    if (!armed) {
      // Movement past the slop before the long-press fires = a scroll / pan, not
      // a pickup: abort and let the page own the gesture.
      if (moved > SLOP_PX) {
        cancel(false);
      }
      return;
    }
    // Armed: drive the floating clone + target resolution. Native scroll is
    // suppressed by the non-passive touchmove preventer (onTouchMove) — pointer
    // events alone can't reliably cancel an in-flight scroll.
    maybeAutoPage(e.clientX);
    pushSnapshot(e.clientX, e.clientY);
  }

  // Non-passive: once the long-press has armed, swallow touchmove so neither the
  // pager nor the column scrolls under the drag.
  function onTouchMove(e: TouchEvent): void {
    if (armed) e.preventDefault();
  }

  function onUp(e: PointerEvent): void {
    if (!taskId) return;
    if (!armed) {
      const moved = Math.hypot(e.clientX - startX, e.clientY - startY);
      const id = taskId;
      cleanup();
      if (moved <= SLOP_PX) host.onTap(id);
      return;
    }
    commitDrop(e.clientX, e.clientY);
  }

  function commitDrop(x: number, y: number): void {
    const id = taskId;
    if (!id) {
      cleanup();
      return;
    }
    const colEl = columnUnder(x);
    if (!colEl) {
      cancel(true);
      return;
    }
    const target = colDescriptor(colEl);
    const ids = orderedIds(colEl);
    const index = Math.min(indexFor(colEl, y), ids.length);
    const sameColumn = target.key === fromKey;
    const isTail = index >= ids.length;
    const beforeId = index > 0 ? ids[index - 1] : undefined;
    const afterId = index < ids.length ? ids[index] : undefined;
    // No-op: dropped back into its own column at its own slot. The card's own
    // ordered position (in `fromKey`) is the index it would re-insert at.
    let noChange = false;
    if (sameColumn) {
      const originIndex = originalIndex(colEl, id, ids);
      noChange = index === originIndex;
    }
    cleanup();
    host.commit({ taskId: id, target, sameColumn, isTail, noChange, beforeId, afterId, index });
  }

  // The index `id` currently occupies among its sorted siblings (`ids` already
  // excludes it): the count of siblings rendered above it in the DOM.
  function originalIndex(colEl: HTMLElement, id: string, ids: string[]): number {
    const order: string[] = [];
    for (const el of colEl.querySelectorAll<HTMLElement>("[data-task-id]")) {
      const tid = el.dataset.taskId;
      if (tid) order.push(tid);
    }
    const pos = order.indexOf(id);
    if (pos < 0) return ids.length;
    // Count non-dragged siblings before `pos`.
    let above = 0;
    for (let i = 0; i < pos; i++) if (order[i] !== id) above++;
    return above;
  }

  function cancel(revertSnapshot: boolean): void {
    // pointercancel / aborted pickup: drop the drag with no mutation.
    if (revertSnapshot) host.setSnapshot(null);
    cleanup();
  }

  function cleanup(): void {
    clearTimer();
    armed = false;
    taskId = null;
    overKey = "";
    setBoardDragging(false);
    host.setSnapshot(null);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("touchmove", onTouchMove);
  }

  function onCancel(): void {
    if (!taskId) return;
    cancel(true);
  }

  function pointerDown(e: PointerEvent, id: string, columnKey: string): void {
    // Left mouse button only; touch / pen always.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // A drag already in flight — ignore a second pointer.
    if (taskId) return;
    const card = (e.currentTarget as HTMLElement) ?? null;
    const rect = card?.getBoundingClientRect();
    taskId = id;
    fromKey = columnKey;
    overKey = columnKey;
    startX = e.clientX;
    startY = e.clientY;
    grabDX = rect ? e.clientX - rect.left : 0;
    grabDY = rect ? e.clientY - rect.top : 0;
    cardW = rect ? rect.width : 0;
    cardH = rect ? rect.height : 0;
    armed = false;
    dropIndex = 0;
    lastPageAt = 0;
    clearTimer();
    longTimer = setTimeout(() => {
      longTimer = null;
      if (taskId) arm(startX, startY);
    }, LONG_PRESS_MS);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
  }

  function destroy(): void {
    cleanup();
  }

  return { pointerDown, destroy };
}
