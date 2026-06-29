import { describe, expect, it } from "vitest";

import { taskActivityEvents } from "./task-activity.js";

// Humans are workspace members; cybo/agent ids are not, so isHumanRecipient is
// just "is this id in the human-member set". A self-assign uses the actor id.
const ACTOR = "user_actor";
const ALICE = "user_alice";
const CYBO = "cybo_apex";

function humansAre(...ids: string[]): (id: string) => boolean {
  const set = new Set(ids);
  return (id: string) => set.has(id);
}

describe("taskActivityEvents", () => {
  it("create with a human assignee → one task_assigned to the assignee", () => {
    const events = taskActivityEvents({
      prev: null,
      next: { id: "task_1", title: "Ship it", assigneeId: ALICE, status: "pending" },
      actorId: ACTOR,
      isHumanRecipient: humansAre(ACTOR, ALICE),
    });

    expect(events).toEqual([
      {
        recipientId: ALICE,
        eventType: "task_assigned",
        sourceType: "task",
        sourceId: "task_1",
        previewText: "Ship it",
      },
    ]);
  });

  it("create assigned to a cybo/agent → no events (agent dispatch is later)", () => {
    const events = taskActivityEvents({
      prev: null,
      next: { id: "task_2", title: "Summarize", assigneeId: CYBO, status: "pending" },
      actorId: ACTOR,
      // CYBO is not a human member.
      isHumanRecipient: humansAre(ACTOR, ALICE),
    });

    expect(events).toEqual([]);
  });

  it("create self-assigned → no event (never notify the actor)", () => {
    const events = taskActivityEvents({
      prev: null,
      next: { id: "task_3", title: "My task", assigneeId: ACTOR, status: "pending" },
      actorId: ACTOR,
      isHumanRecipient: humansAre(ACTOR, ALICE),
    });

    expect(events).toEqual([]);
  });

  it("create with no assignee → no events", () => {
    const events = taskActivityEvents({
      prev: null,
      next: { id: "task_4", title: "Unassigned", assigneeId: null, status: "pending" },
      actorId: ACTOR,
      isHumanRecipient: humansAre(ACTOR, ALICE),
    });

    expect(events).toEqual([]);
  });

  it("update status pending→done → task_status_changed to the assignee, not the actor", () => {
    const events = taskActivityEvents({
      prev: { assigneeId: ALICE, status: "pending" },
      next: { id: "task_5", title: "Review PR", assigneeId: ALICE, status: "done" },
      actorId: ACTOR,
      isHumanRecipient: humansAre(ACTOR, ALICE),
    });

    expect(events).toEqual([
      {
        recipientId: ALICE,
        eventType: "task_status_changed",
        sourceType: "task",
        sourceId: "task_5",
        previewText: "Review PR",
      },
    ]);
  });

  it("update status by the assignee themselves → no event (actor is the assignee)", () => {
    const events = taskActivityEvents({
      prev: { assigneeId: ALICE, status: "pending" },
      next: { id: "task_6", title: "Self move", assigneeId: ALICE, status: "done" },
      actorId: ALICE,
      isHumanRecipient: humansAre(ACTOR, ALICE),
    });

    expect(events).toEqual([]);
  });

  it("update changing assignee → task_assigned to the new human assignee", () => {
    const events = taskActivityEvents({
      prev: { assigneeId: null, status: "pending" },
      next: { id: "task_7", title: "Hand off", assigneeId: ALICE, status: "pending" },
      actorId: ACTOR,
      isHumanRecipient: humansAre(ACTOR, ALICE),
    });

    expect(events).toEqual([
      {
        recipientId: ALICE,
        eventType: "task_assigned",
        sourceType: "task",
        sourceId: "task_7",
        previewText: "Hand off",
      },
    ]);
  });

  it("update reassigning to a cybo → no events", () => {
    const events = taskActivityEvents({
      prev: { assigneeId: ALICE, status: "pending" },
      next: { id: "task_8", title: "To the bot", assigneeId: CYBO, status: "pending" },
      actorId: ACTOR,
      isHumanRecipient: humansAre(ACTOR, ALICE),
    });

    expect(events).toEqual([]);
  });

  it("update that both reassigns AND moves status → single task_assigned (deduped)", () => {
    const events = taskActivityEvents({
      prev: { assigneeId: null, status: "pending" },
      next: { id: "task_9", title: "Take and start", assigneeId: ALICE, status: "in_progress" },
      actorId: ACTOR,
      isHumanRecipient: humansAre(ACTOR, ALICE),
    });

    expect(events).toEqual([
      {
        recipientId: ALICE,
        eventType: "task_assigned",
        sourceType: "task",
        sourceId: "task_9",
        previewText: "Take and start",
      },
    ]);
  });

  it("update with no relevant change → no events", () => {
    const events = taskActivityEvents({
      prev: { assigneeId: ALICE, status: "pending" },
      next: { id: "task_10", title: "Just a title edit", assigneeId: ALICE, status: "pending" },
      actorId: ACTOR,
      isHumanRecipient: humansAre(ACTOR, ALICE),
    });

    expect(events).toEqual([]);
  });
});
