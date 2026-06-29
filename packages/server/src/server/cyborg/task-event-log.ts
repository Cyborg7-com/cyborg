// Task-processing observability — the structured, human-readable events the
// Logs tab shows so a user can watch the under-the-hood agent/watcher pipeline:
// a channel watcher firing, the cybo it picked (or why it skipped), a task being
// created / moved / dispatched, a recurrence spawning.
//
// This module is PURE (no I/O, no clock): a single discriminated-union event
// type + a formatter that maps each event to the wire payload the existing Logs
// pane already renders (`{ level, source, message, category: "task" }`), plus the
// structured `channelId`/`taskId`/`cyboId` fields the requirement asks for. The
// emission seams (message-router, task-dispatch, dispatcher, relay-standalone)
// build one of these events and hand it to `taskEventBroadcast`, which wraps it
// in the `cyborg:task_event` envelope fanned out to the workspace.
//
// Keeping the mapping here (not inline at each seam) means it is unit-testable in
// isolation and the message copy stays consistent across the local-daemon path
// and the cloud-relay path.

// Level mirrors the UI's LogLevel so the Logs pane's level filter just works.
export type TaskEventLevel = "info" | "warn" | "error";

// The discriminated union of everything observable in the task/watcher pipeline.
// `kind` is the discriminant; the common envelope (workspaceId + the optional
// structured ids) lets the transport route + the UI display every variant the
// same way.
export type TaskLogEvent = {
  workspaceId: string;
  channelId?: string | null;
  taskId?: string | null;
  cyboId?: string | null;
} & (
  | {
      // A human posted; the channel watcher began evaluating whether to act.
      kind: "watcher_fired";
      channelName: string;
      author: string;
    }
  | {
      // The watcher decided NOT to act, with a precise reason a user can act on.
      kind: "watcher_skipped";
      channelName: string;
      reason:
        | "auto_tasks_off"
        | "rate_limited"
        | "no_cybo_members"
        | "nothing_actionable"
        | "no_online_cybo"
        | "lookup_failed";
    }
  | {
      // The watcher picked a cybo from the (failover) chain to run the turn.
      kind: "watcher_selected";
      channelName: string;
      cyboName: string;
      // 1-based position in the failover chain + chain length → "1/3".
      chainPosition: number;
      chainLength: number;
    }
  | {
      // A cybo's watcher run failed to spawn; the chain advances to the next.
      kind: "watcher_spawn_failed";
      channelName: string;
      cyboName: string;
      detail: string;
    }
  | {
      // A task was created (by a human or a cybo's cyborg7_create_task).
      kind: "task_created";
      title: string;
      assigneeName: string | null;
      priority: string | null;
      actor: string;
    }
  | {
      // A task's status moved on the board (To Do -> Done, etc.).
      kind: "task_status_changed";
      title: string;
      fromStatus: string;
      toStatus: string;
      actor: string;
    }
  | {
      // A task was woken on its assigned cybo (immediate, due, or reminder).
      kind: "task_dispatched";
      title: string;
      cyboName: string;
      reason: string;
    }
  | {
      // Dispatching the task to its cybo failed (spawn/run error).
      kind: "task_dispatch_failed";
      title: string;
      cyboName: string;
      detail: string;
    }
  | {
      // A recurring task completed → its next occurrence was spawned.
      kind: "recurrence_spawned";
      title: string;
      childTaskId: string;
      nextDueAt: number;
    }
);

// The wire shape consumed by the Logs pane (mirrors the UI's LogEntry inputs,
// minus the client-assigned id/timestamp). `category` is always "task" so these
// lines group under the pane's existing "Task" filter; `source` is the actor the
// pane shows in its Source column.
export interface TaskEventLogLine {
  level: TaskEventLevel;
  source: string;
  message: string;
  category: "task";
  // Structured context (also surfaced for export / future drill-down).
  workspaceId: string;
  channelId?: string | null;
  taskId?: string | null;
  cyboId?: string | null;
}

const SKIP_REASON_TEXT: Record<
  Extract<TaskLogEvent, { kind: "watcher_skipped" }>["reason"],
  string
> = {
  auto_tasks_off: "auto-tasks are off",
  rate_limited: "rate-limited (one watch per channel per 20s)",
  no_cybo_members: "no cybo is a member of this channel",
  nothing_actionable: "nothing actionable in the message",
  no_online_cybo: "no online cybo could run it",
  lookup_failed: "a lookup failed",
};

// Render a status token the way a board reads it: "to_do" -> "To Do".
function prettyStatus(status: string): string {
  return status
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function prettyDue(nextDueAt: number): string {
  // Date only — the pane already shows the event's own timestamp; the due date is
  // the schedule slot, not a precise clock.
  return new Date(nextDueAt).toISOString().split("T")[0];
}

/**
 * Map a TaskLogEvent to the Logs-pane line (level + human message + structured
 * ids). PURE: same input → same output, no clock, no I/O.
 */
export function formatTaskEvent(event: TaskLogEvent): TaskEventLogLine {
  const base = {
    category: "task" as const,
    workspaceId: event.workspaceId,
    channelId: event.channelId ?? null,
    taskId: event.taskId ?? null,
    cyboId: event.cyboId ?? null,
  };

  switch (event.kind) {
    case "watcher_fired":
      return {
        ...base,
        level: "info",
        source: "watcher",
        message: `Watcher fired in #${event.channelName} (post by ${event.author})`,
      };
    case "watcher_skipped":
      return {
        ...base,
        level: "info",
        source: "watcher",
        message: `Watcher skipped in #${event.channelName} — ${SKIP_REASON_TEXT[event.reason]}`,
      };
    case "watcher_selected":
      return {
        ...base,
        level: "info",
        source: "watcher",
        message: `Selected cybo ${event.cyboName} (failover chain ${event.chainPosition}/${event.chainLength}) for #${event.channelName}`,
      };
    case "watcher_spawn_failed":
      return {
        ...base,
        level: "warn",
        source: "watcher",
        message: `Watcher spawn failed for ${event.cyboName} in #${event.channelName} — advancing chain (${event.detail})`,
      };
    case "task_created":
      return {
        ...base,
        level: "info",
        source: event.actor,
        message:
          `${event.actor} created task "${event.title}"` +
          (event.assigneeName ? ` (assigned ${event.assigneeName}` : " (unassigned") +
          (event.priority ? `, ${event.priority} priority)` : ")"),
      };
    case "task_status_changed":
      return {
        ...base,
        level: "info",
        source: event.actor,
        message: `Task "${event.title}" moved ${prettyStatus(event.fromStatus)} → ${prettyStatus(event.toStatus)} by ${event.actor}`,
      };
    case "task_dispatched":
      return {
        ...base,
        level: "info",
        source: event.cyboName,
        message: `Dispatched task "${event.title}" to ${event.cyboName} (${event.reason})`,
      };
    case "task_dispatch_failed":
      return {
        ...base,
        level: "warn",
        source: event.cyboName,
        message: `Dispatch failed for task "${event.title}" → ${event.cyboName} (${event.detail})`,
      };
    case "recurrence_spawned":
      return {
        ...base,
        level: "info",
        source: "system",
        message: `Spawned recurrence of "${event.title}" — next due ${prettyDue(event.nextDueAt)}`,
      };
  }
}

// The `cyborg:task_event` broadcast envelope. The payload IS the formatted line,
// so the client transport can emit it straight through and app.svelte pushes it
// into logState without re-deriving copy.
export interface TaskEventBroadcast {
  type: "cyborg:task_event";
  payload: TaskEventLogLine;
}

/**
 * Wrap a TaskLogEvent in the workspace broadcast envelope. The seams call this and
 * hand the result to their workspace fan-out (`broadcast.toWorkspace` on the
 * daemon, `broadcastToGuests` on the relay).
 */
export function taskEventBroadcast(event: TaskLogEvent): TaskEventBroadcast {
  return { type: "cyborg:task_event", payload: formatTaskEvent(event) };
}
