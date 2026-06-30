// Pure + optimistic board mutation helpers (WS0 foundation, frozen).
//
// Two mutations the mobile board (WS2) and any other surface compose:
//   • reorder(taskId, anchors)  — drag-reorder within a lane. Optimistic SPLICE
//     of workspaceState.tasks (the task is moved between its named neighbours),
//     then persisted via client.reorderTask; on success the server row is patched
//     back in (sort_order reconciled server-side), on failure the previous array
//     is restored + a toast.
//   • move(taskId, { stateId?, status? }) — cross-state move. Optimistic patch of
//     the task's stateId/status, then client.updateTask; reconcile/revert as above.
//
// Both derive the workspaceId from workspaceState.current (the board only ever
// operates on the current workspace) so every write still carries a workspaceId
// through the gated cyborg:* RPC — no visibility bypass. These functions never
// touch view.ts / the OrderBy enum.
//
// NOTE for WS2: the wire `Task` model carries no `sort_order` field
// (mapRawTask drops it), so the WITHIN-COLUMN reorder is reflected here purely as
// an array-position splice. For the reorder to render visibly, the mobile board
// must order each column by array position (stable) — or sort_order must be added
// to mapRawTask. This is the documented C1/floor risk; surfaced, not hidden.

import { workspaceState, client } from "$lib/state/app.svelte.js";
import { toast } from "svelte-sonner";
import type { Task } from "$lib/core/types.js";

export interface ReorderAnchors {
  // The task's new UPPER neighbour (it now sits AFTER this one).
  beforeId?: string;
  // The task's new LOWER neighbour (it now sits BEFORE this one).
  afterId?: string;
}

export interface MoveTarget {
  stateId?: string;
  status?: string;
}

// Pure splice: return a new array with `taskId` repositioned relative to its
// anchors. Mirrors the four computeReorderSort cases (task-ordering.ts) in array
// space:
//   both present  → between beforeId and afterId (afterId's slot)
//   afterId only  → ABOVE afterId (dropped at the top of the gap)
//   beforeId only → BELOW beforeId (dropped at the bottom of the gap)
//   neither       → appended at the tail
// Unknown/stale anchors are treated as absent. Exported for unit testing.
export function reorderTasksLocally(
  tasks: Task[],
  taskId: string,
  anchors: ReorderAnchors,
): Task[] {
  const moving = tasks.find((t) => t.id === taskId);
  if (!moving) return tasks;
  const without = tasks.filter((t) => t.id !== taskId);
  const afterIdx = anchors.afterId ? without.findIndex((t) => t.id === anchors.afterId) : -1;
  const beforeIdx = anchors.beforeId ? without.findIndex((t) => t.id === anchors.beforeId) : -1;
  let insertAt = without.length; // tail (neither anchor resolvable)
  if (afterIdx >= 0) insertAt = afterIdx;
  else if (beforeIdx >= 0) insertAt = beforeIdx + 1;
  return [...without.slice(0, insertAt), moving, ...without.slice(insertAt)];
}

// Optimistic drag-reorder: splice locally, persist, reconcile, revert+toast on
// failure. Resolves void; rethrows so a caller can sequence a follow-up.
export async function reorder(taskId: string, anchors: ReorderAnchors): Promise<void> {
  const workspaceId = workspaceState.current?.id;
  if (!workspaceId) return;
  const prev = workspaceState.tasks;
  if (!prev.some((t) => t.id === taskId)) return;
  workspaceState.tasks = reorderTasksLocally(prev, taskId, anchors);
  try {
    const updated = await client.reorderTask(workspaceId, taskId, anchors);
    workspaceState.tasks = workspaceState.tasks.map((t) => (t.id === updated.id ? updated : t));
  } catch (err) {
    workspaceState.tasks = prev;
    toast.error(err instanceof Error ? err.message : "Couldn't reorder the task");
    throw err;
  }
}

// Optimistic cross-state move: patch stateId/status locally, persist via
// updateTask, reconcile with the server row, revert+toast on failure.
export async function move(taskId: string, target: MoveTarget): Promise<void> {
  const workspaceId = workspaceState.current?.id;
  if (!workspaceId) return;
  const prev = workspaceState.tasks;
  const task = prev.find((t) => t.id === taskId);
  if (!task) return;
  const optimistic: Partial<Task> = {};
  if (target.stateId !== undefined) optimistic.stateId = target.stateId;
  if (target.status !== undefined) optimistic.status = target.status;
  workspaceState.tasks = prev.map((t) => (t.id === taskId ? { ...t, ...optimistic } : t));
  try {
    const updated = await client.updateTask(workspaceId, taskId, target);
    workspaceState.tasks = workspaceState.tasks.map((t) => (t.id === updated.id ? updated : t));
  } catch (err) {
    workspaceState.tasks = prev;
    toast.error(err instanceof Error ? err.message : "Couldn't move the task");
    throw err;
  }
}

export const boardMutations = { reorder, move, reorderTasksLocally };
