// Module-level selection store for BULK task editing in the Tasks LIST view.
// Mirrors the tiny `$state` rune-store pattern of detailStore.svelte.ts: one
// shared singleton that the list rows (checkboxes), the group-header select-all,
// and the sticky bulk-action toolbar all read/write, so the selection lives in
// ONE place instead of being threaded through props.
//
// SVELTE 5 SET REACTIVITY: a `$state` that holds a `Set` only re-runs derivations
// when the binding is REASSIGNED — mutating the Set in place (`.add`/`.delete`)
// is invisible to the reactivity graph. So every mutator below builds a NEW Set
// and reassigns `taskSelection.ids` (matching TasksList's `collapsed`/`pendingIds`
// pattern). The `anchorId` powers shift-click range selection: the last single
// toggle / range target becomes the anchor for the next shift-range.
//
// PURE helper `rangeBetween` is intentionally split out (no $state access) so the
// range math is unit-testable without mounting a component.

// The live selection: the set of selected task ids + the shift-range anchor.
export const taskSelection = $state<{ ids: Set<string>; anchorId: string | null }>({
  ids: new Set<string>(),
  anchorId: null,
});

// Is this task id currently selected?
export function isSelected(id: string): boolean {
  return taskSelection.ids.has(id);
}

// How many tasks are selected (drives the toolbar's "{n} selected" + its render gate).
export function selectedCount(): number {
  return taskSelection.ids.size;
}

// The selected ids as a plain array (e.g. to feed client.bulkUpdateTasks).
export function selectedIds(): string[] {
  return [...taskSelection.ids];
}

// Toggle a single id on/off; the toggled id becomes the shift-range anchor.
export function toggleSelected(id: string): void {
  const next = new Set(taskSelection.ids);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  taskSelection.ids = next;
  taskSelection.anchorId = id;
}

// Add every id in `ids` to the selection (group select-all). Anchor is left as-is.
export function selectMany(ids: string[]): void {
  const next = new Set(taskSelection.ids);
  for (const id of ids) next.add(id);
  taskSelection.ids = next;
}

// Remove every id in `ids` from the selection (group deselect-all). Anchor unchanged.
export function deselectMany(ids: string[]): void {
  const next = new Set(taskSelection.ids);
  for (const id of ids) next.delete(id);
  taskSelection.ids = next;
}

// Explicitly set one id's membership (add when `on`, remove otherwise).
export function setSelected(id: string, on: boolean): void {
  const next = new Set(taskSelection.ids);
  if (on) next.add(id);
  else next.delete(id);
  taskSelection.ids = next;
}

// Empty the selection and drop the anchor (the toolbar disappears).
export function clearSelection(): void {
  taskSelection.ids = new Set<string>();
  taskSelection.anchorId = null;
}

// PURE range helper (no $state): the inclusive slice of `orderedIds` between `a`
// and `b`, regardless of which comes first. Used for shift-click range selection.
//   - `a` null or not in `orderedIds` → just `[b]` (no anchor to range from).
//   - `b` not in `orderedIds`         → `[]` (target is gone/hidden).
//   - otherwise                       → the inclusive span a..b (order-agnostic).
export function rangeBetween(orderedIds: string[], a: string | null, b: string): string[] {
  const bIdx = orderedIds.indexOf(b);
  if (bIdx === -1) return [];
  if (a === null) return [b];
  const aIdx = orderedIds.indexOf(a);
  if (aIdx === -1) return [b];
  const lo = Math.min(aIdx, bIdx);
  const hi = Math.max(aIdx, bIdx);
  return orderedIds.slice(lo, hi + 1);
}

// Shift-range select: select the inclusive span between the current anchor and
// `targetId` within `orderedIds` (the flat, render-order id list). With no anchor
// (or an anchor that's no longer visible) it falls back to selecting just the
// target. The target always becomes the new anchor, so a subsequent shift-click
// extends from here.
export function selectRange(orderedIds: string[], targetId: string): void {
  const span = rangeBetween(orderedIds, taskSelection.anchorId, targetId);
  const next = new Set(taskSelection.ids);
  for (const id of span) next.add(id);
  taskSelection.ids = next;
  taskSelection.anchorId = targetId;
}
