// Pure, DOM-free priority helper for the Tasks board card. The Task model does
// NOT carry a priority field today (see core/types.ts), so this reads it
// FORWARD-COMPATIBLY off an optional `priority` property if a future task ever
// has one — and otherwise resolves to "none", which the card renders as nothing.
// This keeps the card's priority affordance ready without inventing task data or
// touching any RPC: a task with no priority simply shows no dot.
//
// Kept pure + standalone so the board is a render over the result and so the
// mapping is trivially unit-testable.
import type { Task } from "$lib/core/types.js";

export type Priority = "urgent" | "high" | "medium" | "low" | "none";

// Display order high→low; "none" is intentionally excluded (it renders nothing).
export const PRIORITY_ORDER: Exclude<Priority, "none">[] = ["urgent", "high", "medium", "low"];

// Per-priority presentation: a dot color class (theme tokens / fixed semantic
// scale) + a human label for the tooltip/aria. "none" maps to nulls so callers
// skip rendering entirely.
export interface PriorityStyle {
  // Tailwind background-color class for the dot.
  dot: string;
  // Human label (tooltip + screen-reader text).
  label: string;
}

const STYLES: Record<Exclude<Priority, "none">, PriorityStyle> = {
  urgent: { dot: "bg-error", label: "Urgent" },
  high: { dot: "bg-warning", label: "High" },
  medium: { dot: "bg-pin", label: "Medium" },
  low: { dot: "bg-content-muted", label: "Low" },
};

// A `Task` shape MAY (in the future) carry a `priority`. Narrow without widening
// the canonical Task type or asserting `any`.
interface MaybePrioritized {
  priority?: string | null;
}

// Map a task to its priority bucket. Unknown / absent / "none" → "none".
export function priorityForTask(task: Task): Priority {
  const raw = (task as MaybePrioritized).priority;
  if (raw === "urgent" || raw === "high" || raw === "medium" || raw === "low") return raw;
  return "none";
}

// Look up the dot style for a priority, or null when there's nothing to show.
export function priorityStyle(priority: Priority): PriorityStyle | null {
  if (priority === "none") return null;
  return STYLES[priority];
}
