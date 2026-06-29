// Pure, DOM-free bucketing for the Tasks kanban board. Maps each task's raw
// `status` string to one of the four fixed columns the board renders. Kept pure
// + deterministic so the column layout is unit-testable without mounting the
// component, and so the board itself is just a render over the result.
//
// Status mapping rule (IMPORTANT): the board only knows four columns. The task
// store, however, carries legacy/loose statuses — the daemon's default today is
// the legacy "pending" (the old "Inbox"), and a task may arrive with an unknown
// or empty status. Anything that is NOT one of in_progress / pending_review /
// done falls into "todo" (To Do). That keeps every task visible on the board
// instead of silently dropping it, and treats "pending"/unset as the natural
// "not started yet" inbox state.
import type { Task } from "$lib/core/types.js";

export type ColumnKey = "todo" | "in_progress" | "pending_review" | "done";

export interface Column {
  key: ColumnKey;
  label: string;
}

// The four fixed board columns, in display (left-to-right) order. The `key` is
// the canonical task.status written back via client.updateTask when a card moves
// into the column; the `label` is the human-facing column title.
export const COLUMNS: Column[] = [
  { key: "todo", label: "To Do" },
  { key: "in_progress", label: "In Progress" },
  { key: "pending_review", label: "Review" },
  { key: "done", label: "Done" },
];

// The set of statuses that map to a column 1:1. Everything else (legacy
// "pending", unknown, empty) buckets into "todo".
const DIRECT: Record<string, ColumnKey> = {
  todo: "todo",
  in_progress: "in_progress",
  pending_review: "pending_review",
  done: "done",
};

// Map a single task's status to its column key. Pure: legacy "pending",
// unknown, and empty statuses all resolve to "todo".
export function columnForStatus(status: string | null | undefined): ColumnKey {
  if (!status) return "todo";
  return DIRECT[status] ?? "todo";
}

export type BoardBuckets = Record<ColumnKey, Task[]>;

// Partition `tasks` into the four columns, preserving input order within each
// column. Always returns all four keys (empty arrays when a column has no
// tasks), so the board can render every column without a presence check.
export function bucketTasks(tasks: Task[]): BoardBuckets {
  const buckets: BoardBuckets = {
    todo: [],
    in_progress: [],
    pending_review: [],
    done: [],
  };
  for (const task of tasks) {
    buckets[columnForStatus(task.status)].push(task);
  }
  return buckets;
}
