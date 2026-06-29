// Pure derivation of task activity-feed events for the in-app notification feed.
//
// Given the BEFORE/AFTER snapshot of a task plus who acted, decide which human
// recipients get an activity row and what kind. This module is deliberately
// dependency-free and deterministic: NO Date.now / randomUUID. The caller stamps
// id + createdAt and writes each event via the SAME activity-insert path used by
// message mentions (relay `emitActivityEvent`, daemon `MessageRouter.emitActivity`)
// so PG/SQLite handling and broadcast stay consistent.
//
// Assignment to a cybo/agent (isHumanRecipient === false) produces NO event here —
// agent dispatch on assignment is a later increment.

export type TaskActivityEventType = "task_assigned" | "task_status_changed";

export interface TaskActivityEvent {
  recipientId: string;
  eventType: TaskActivityEventType;
  sourceType: "task";
  sourceId: string;
  previewText: string;
}

export interface TaskActivityInput {
  // Null on create; the prior assignee + status on update.
  prev: { assigneeId: string | null; status: string } | null;
  next: {
    id: string;
    title: string;
    assigneeId: string | null;
    status: string;
  };
  // Who created/updated the task — never notified about their own action.
  actorId: string;
  // True iff the id is a human workspace member (a cybo/agent id is not a member).
  isHumanRecipient: (id: string) => boolean;
}

export function taskActivityEvents(input: TaskActivityInput): TaskActivityEvent[] {
  const { prev, next, actorId, isHumanRecipient } = input;
  const events: TaskActivityEvent[] = [];
  // Recipients already queued, so a single update never produces two rows for
  // the same person (e.g. status changed AND reassigned to the same human).
  const seen = new Set<string>();

  function push(recipientId: string | null, eventType: TaskActivityEventType): void {
    if (!recipientId) return;
    if (recipientId === actorId) return; // never notify the actor about their own action
    if (!isHumanRecipient(recipientId)) return; // cybo/agent assignee → no feed row (yet)
    if (seen.has(recipientId)) return;
    seen.add(recipientId);
    events.push({
      recipientId,
      eventType,
      sourceType: "task",
      sourceId: next.id,
      previewText: next.title,
    });
  }

  const assigneeChanged = prev === null || prev.assigneeId !== next.assigneeId;
  const statusChanged = prev !== null && prev.status !== next.status;

  // New (or newly-changed) human assignee learns the task is theirs. On create
  // prev is null so any human assignee counts as "newly assigned".
  if (assigneeChanged) {
    push(next.assigneeId, "task_assigned");
  }

  // A status transition notifies the current assignee (if human and not the
  // actor). Deduped against the assignment row above so a reassign-and-move in
  // one update yields a single "task_assigned" rather than a redundant pair.
  if (statusChanged) {
    push(next.assigneeId, "task_status_changed");
  }

  return events;
}
