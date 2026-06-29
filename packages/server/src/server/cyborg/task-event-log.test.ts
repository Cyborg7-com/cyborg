import { describe, expect, it } from "vitest";

import { formatTaskEvent, taskEventBroadcast } from "./task-event-log.js";

describe("formatTaskEvent", () => {
  it("formats a watcher firing with the channel + author", () => {
    const line = formatTaskEvent({
      kind: "watcher_fired",
      workspaceId: "ws1",
      channelId: "ch1",
      channelName: "general",
      author: "Ada",
    });
    expect(line.level).toBe("info");
    expect(line.source).toBe("watcher");
    expect(line.category).toBe("task");
    expect(line.message).toBe("Watcher fired in #general (post by Ada)");
    expect(line.channelId).toBe("ch1");
  });

  it("formats each watcher skip reason with human copy", () => {
    const reasons = [
      ["auto_tasks_off", "auto-tasks are off"],
      ["rate_limited", "rate-limited (one watch per channel per 20s)"],
      ["no_cybo_members", "no cybo is a member of this channel"],
      ["nothing_actionable", "nothing actionable in the message"],
      ["no_online_cybo", "no online cybo could run it"],
      ["lookup_failed", "a lookup failed"],
    ] as const;
    for (const [reason, text] of reasons) {
      const line = formatTaskEvent({
        kind: "watcher_skipped",
        workspaceId: "ws1",
        channelName: "general",
        reason,
      });
      expect(line.message).toBe(`Watcher skipped in #general — ${text}`);
      expect(line.level).toBe("info");
    }
  });

  it("formats the selected cybo with chain position", () => {
    const line = formatTaskEvent({
      kind: "watcher_selected",
      workspaceId: "ws1",
      channelId: "ch1",
      cyboId: "cy1",
      channelName: "general",
      cyboName: "Apex",
      chainPosition: 1,
      chainLength: 3,
    });
    expect(line.message).toBe("Selected cybo Apex (failover chain 1/3) for #general");
    expect(line.cyboId).toBe("cy1");
  });

  it("warns when a watcher spawn fails", () => {
    const line = formatTaskEvent({
      kind: "watcher_spawn_failed",
      workspaceId: "ws1",
      channelName: "general",
      cyboName: "Apex",
      detail: "boom",
    });
    expect(line.level).toBe("warn");
    expect(line.message).toContain("Watcher spawn failed for Apex in #general");
    expect(line.message).toContain("boom");
  });

  it("formats task creation with assignee + priority", () => {
    const line = formatTaskEvent({
      kind: "task_created",
      workspaceId: "ws1",
      taskId: "t1",
      title: "Ship it",
      assigneeName: "Apex",
      priority: "high",
      actor: "Ada",
    });
    expect(line.source).toBe("Ada");
    expect(line.message).toBe('Ada created task "Ship it" (assigned Apex, high priority)');
    expect(line.taskId).toBe("t1");
  });

  it("formats task creation when unassigned and no priority", () => {
    const line = formatTaskEvent({
      kind: "task_created",
      workspaceId: "ws1",
      title: "Ship it",
      assigneeName: null,
      priority: null,
      actor: "Ada",
    });
    expect(line.message).toBe('Ada created task "Ship it" (unassigned)');
  });

  it("formats a status move with pretty status labels", () => {
    const line = formatTaskEvent({
      kind: "task_status_changed",
      workspaceId: "ws1",
      taskId: "t1",
      title: "Ship it",
      fromStatus: "to_do",
      toStatus: "done",
      actor: "Apex",
    });
    expect(line.message).toBe('Task "Ship it" moved To Do → Done by Apex');
  });

  it("formats a dispatch with the reason", () => {
    const line = formatTaskEvent({
      kind: "task_dispatched",
      workspaceId: "ws1",
      taskId: "t1",
      cyboId: "cy1",
      title: "Ship it",
      cyboName: "Apex",
      reason: "task_assigned",
    });
    expect(line.source).toBe("Apex");
    expect(line.message).toBe('Dispatched task "Ship it" to Apex (task_assigned)');
  });

  it("warns on a dispatch failure", () => {
    const line = formatTaskEvent({
      kind: "task_dispatch_failed",
      workspaceId: "ws1",
      taskId: "t1",
      title: "Ship it",
      cyboName: "Apex",
      detail: "spawn error",
    });
    expect(line.level).toBe("warn");
    expect(line.message).toBe('Dispatch failed for task "Ship it" → Apex (spawn error)');
  });

  it("formats a recurrence spawn with the next due date", () => {
    const nextDueAt = Date.UTC(2026, 5, 25, 12, 0, 0);
    const line = formatTaskEvent({
      kind: "recurrence_spawned",
      workspaceId: "ws1",
      taskId: "t1",
      title: "Daily standup",
      childTaskId: "t2",
      nextDueAt,
    });
    expect(line.source).toBe("system");
    expect(line.message).toBe('Spawned recurrence of "Daily standup" — next due 2026-06-25');
  });
});

describe("taskEventBroadcast", () => {
  it("wraps the formatted line in the cyborg:task_event envelope", () => {
    const env = taskEventBroadcast({
      kind: "watcher_fired",
      workspaceId: "ws1",
      channelName: "general",
      author: "Ada",
    });
    expect(env.type).toBe("cyborg:task_event");
    expect(env.payload.message).toBe("Watcher fired in #general (post by Ada)");
    expect(env.payload.category).toBe("task");
  });
});
