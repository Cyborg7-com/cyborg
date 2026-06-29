// Resolves how a TASK binds to the per-task schedule editor: only a cybo can run
// a task on a cadence (humans don't execute), so this maps a task's assignee to
// the cybo that would run it — and, when it can't, to a human-readable reason the
// editor surfaces as a hint. Kept pure + DOM-free so the board card and detail
// card share one binding rule and it stays unit-testable.
import { resolveAssignee, type AssigneePools } from "$lib/tasks/assignee.js";
import type { Task } from "$lib/core/types.js";

export interface TaskScheduleBinding {
  // The cybo that runs the task on its cadence — null when scheduling isn't
  // possible (unassigned, or assigned to a human / unknown identity).
  cyboId: string | null;
  // The task's channel (forwarded so a scheduled run posts where the task lives).
  channelId: string | null;
  // Why scheduling is unavailable, when it is — null when a cybo is bound.
  disabledReason: string | null;
}

// Resolve a task's scheduling binding. A cybo assignee binds directly (its id IS
// the cybo id); an AGENT assignee binds via the agent's backing cyboId; a human
// or unassigned task can't be scheduled (only cybos execute).
export function resolveTaskScheduleBinding(task: Task, pools: AssigneePools): TaskScheduleBinding {
  const channelId = (task as { channelId?: string | null }).channelId ?? null;
  const a = resolveAssignee(task.assigneeId, pools);
  if (!a) {
    return {
      cyboId: null,
      channelId,
      disabledReason: "Assign this task to an agent to schedule it.",
    };
  }
  if (a.kind === "cybo") {
    return { cyboId: a.id, channelId, disabledReason: null };
  }
  if (a.kind === "agent") {
    const agent = (pools.agents ?? []).find((ag) => ag.agentId === a.id);
    const cyboId = agent?.cyboId ?? null;
    return cyboId
      ? { cyboId, channelId, disabledReason: null }
      : { cyboId: null, channelId, disabledReason: "This agent has no cybo to run on a schedule." };
  }
  // Human (user) or unknown identity — only cybos run on a cadence.
  return {
    cyboId: null,
    channelId,
    disabledReason: "Only agents run on a schedule — assign this task to an agent.",
  };
}
