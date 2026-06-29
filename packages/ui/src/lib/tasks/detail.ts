// Pure, DOM-free helpers for the task DETAIL card. Two concerns live here so the
// card component stays a thin render + RPC shell and the tricky mappings are
// unit-testable without mounting Svelte:
//
//   1. status presentation (label + pill class) — the same four buckets the
//      board uses, centralized so the detail card and the board agree.
//   2. due-date <input type="date"> <-> epoch-ms round-tripping, which has two
//      sharp edges: a date input has no time-of-day (we pin it to local
//      end-of-day so a task due "today" isn't already overdue, matching
//      CreateTaskDialog) and the value must be a *local* YYYY-MM-DD, not a UTC
//      slice of toISOString() (that shifts the day across the timezone offset).
import type { StateGroupKey } from "$lib/tasks/constants.js";
import type { Task, WorkspaceMember } from "$lib/core/types.js";

export type StatusKey = "pending" | "in_progress" | "pending_review" | "done";

// Map the legacy `status` lifecycle bucket to its Plane STATE GROUP, so the
// detail header's state pill can render the matching StateGroupIcon glyph + tint
// before the per-project state catalog (fetchProjectStates) lands server-side.
// Mirrors the board's column→group mapping (view.ts): todo→unstarted,
// in_progress / pending_review→started, done→completed.
export function stateGroupForStatus(status: string): StateGroupKey {
  switch (status) {
    case "in_progress":
    case "pending_review":
      return "started";
    case "done":
      return "completed";
    default:
      return "unstarted";
  }
}

// The four task statuses the board/detail card expose, in workflow order. Used
// to drive the status dropdown so it never invents a status the board can't show.
export const STATUS_OPTIONS: { value: StatusKey; label: string }[] = [
  { value: "pending", label: "Inbox" },
  { value: "in_progress", label: "In Progress" },
  { value: "pending_review", label: "Pending Review" },
  { value: "done", label: "Done" },
];

export function statusLabel(status: string): string {
  switch (status) {
    case "in_progress":
      return "In Progress";
    case "pending_review":
      return "Pending Review";
    case "done":
      return "Done";
    default:
      return "Inbox";
  }
}

// Pill styling per status (theme tokens only), shared by the detail card's
// status pill. Mirrors the board's status palette.
export function statusPillClass(status: string): string {
  switch (status) {
    case "in_progress":
      return "bg-accent/15 text-accent";
    case "pending_review":
      return "bg-warning/15 text-warning";
    case "done":
      return "bg-online/15 text-online";
    default:
      return "bg-content-muted/15 text-content-dim";
  }
}

// epoch-ms -> the value an <input type="date"> expects (LOCAL YYYY-MM-DD).
// Returns "" for no due date. Built from local Y/M/D parts (not toISOString,
// which is UTC and can land on the wrong calendar day near midnight).
export function dueToInputValue(ts: number | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// <input type="date"> value -> epoch ms, pinned to LOCAL end-of-day so a task
// due today isn't instantly overdue (matches CreateTaskDialog). "" -> null
// (clear the due date). A malformed value also resolves to null rather than NaN.
export function dueFromInputValue(value: string): number | null {
  if (!value) return null;
  const ts = new Date(`${value}T23:59:59`).getTime();
  return Number.isNaN(ts) ? null : ts;
}

// Plane shows a short, human-scannable task KEY ("ENG-12") built from the
// project's `identifier` prefix + the task's per-project `sequenceId`. The UI
// Project type (ws-client.ts) does not carry `identifier` yet, so the caller
// supplies it; we derive a stable, uppercase ≤4-char fallback from the project
// NAME when no identifier is known (e.g. "Engineering" → "ENG"). When a task has
// no sequenceId (legacy / unsynced row) we fall back to a short id slice prefixed
// "#", so the card always shows SOMETHING scannable and never a bare UUID.
// SEAM: pass the real `tasksProjects.identifier` here the moment the client
// Project type carries it — no other change needed.
export function projectKeyPrefix(name: string | null | undefined): string {
  const cleaned = (name ?? "").replace(/[^A-Za-z0-9]/g, "");
  if (!cleaned) return "TASK";
  return cleaned.slice(0, 4).toUpperCase();
}

export function taskKey(
  sequenceId: number | null | undefined,
  fallbackId: string,
  identifier?: string | null,
): string {
  const prefix = identifier && identifier.trim() ? identifier.trim().toUpperCase() : null;
  if (sequenceId != null && prefix) return `${prefix}-${sequenceId}`;
  if (sequenceId != null) return `#${sequenceId}`;
  return `#${fallbackId.slice(0, 8)}`;
}

// Resolve a workspace user id (task.createdBy / a human assignee) to a display
// name via the members pool, falling back to a short id slice when the creator
// is not a current member (e.g. an agent-created task or a departed member) so
// the card never shows a bare full UUID.
export function resolveMemberName(
  id: string | null | undefined,
  members: WorkspaceMember[],
): string {
  if (!id) return "";
  const m = (members ?? []).find((x) => x.userId === id);
  if (m) return m.name ?? m.email;
  return id.slice(0, 8);
}
