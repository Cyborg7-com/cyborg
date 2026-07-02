import { describe, it, expect } from "vitest";
import {
  mapClickUpPriority,
  mapClickUpStatusType,
  mapClickUpTaskToEvent,
  mapClickUpTaskToItem,
  mapClickUpWebhookToEvents,
} from "./clickup-task-mapper.js";

// A representative ClickUp API v2 task object (trimmed to the fields the mapper reads).
function fixtureTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "86xy1",
    name: "Ship the ClickUp adapter",
    description: "**markdown** body",
    text_content: "plain body",
    status: { id: "st-2", status: "in progress", type: "custom", orderindex: 1 },
    priority: { id: "2", priority: "high" },
    assignees: [
      { id: 11, username: "dana", email: "dana@example.com" },
      { id: 12, username: "eli", email: "eli@example.com" },
    ],
    tags: [{ name: "backend" }, { name: "backend" }, { name: "sync" }],
    due_date: "1508369194377",
    start_date: "1508369100000",
    url: "https://app.clickup.com/t/86xy1",
    list: { id: "list-900" },
    creator: { username: "fabricio", email: "fab@example.com" },
    ...overrides,
  };
}

describe("mapClickUpStatusType", () => {
  it("maps ClickUp status types onto normalized categories (incl. closed→completed)", () => {
    expect(mapClickUpStatusType("open", "To Do")).toBe("unstarted");
    expect(mapClickUpStatusType("custom", "In Progress")).toBe("started");
    expect(mapClickUpStatusType("done", "Done")).toBe("completed");
    expect(mapClickUpStatusType("closed", "Closed")).toBe("completed");
  });

  it("maps a status NAMED cancelled/won't-do to cancelled regardless of type", () => {
    expect(mapClickUpStatusType("done", "Cancelled")).toBe("cancelled");
    expect(mapClickUpStatusType("closed", "canceled")).toBe("cancelled");
    expect(mapClickUpStatusType("custom", "Won't Do")).toBe("cancelled");
    expect(mapClickUpStatusType("open", "wont do")).toBe("cancelled");
  });

  it("defaults an unknown/empty type to unstarted", () => {
    expect(mapClickUpStatusType("", "Whatever")).toBe("unstarted");
    expect(mapClickUpStatusType("weird", "Whatever")).toBe("unstarted");
  });
});

describe("mapClickUpPriority", () => {
  it("maps the numeric scale (normal→medium)", () => {
    expect(mapClickUpPriority(1)).toBe("urgent");
    expect(mapClickUpPriority(2)).toBe("high");
    expect(mapClickUpPriority(3)).toBe("medium");
    expect(mapClickUpPriority(4)).toBe("low");
  });

  it("maps null/undefined to none", () => {
    expect(mapClickUpPriority(null)).toBe("none");
    expect(mapClickUpPriority(undefined)).toBe("none");
  });

  it("maps the task OBJECT form (prefers id, falls back to name)", () => {
    expect(mapClickUpPriority({ id: "1", priority: "urgent" })).toBe("urgent");
    expect(mapClickUpPriority({ priority: "normal" })).toBe("medium");
    expect(mapClickUpPriority({ id: "4", priority: "low" })).toBe("low");
  });

  it("maps string ids and names, and unrecognized → none", () => {
    expect(mapClickUpPriority("3")).toBe("medium");
    expect(mapClickUpPriority("urgent")).toBe("urgent");
    expect(mapClickUpPriority("bogus")).toBe("none");
    expect(mapClickUpPriority({})).toBe("none");
  });
});

describe("mapClickUpTaskToEvent", () => {
  it("maps every locked field from a full task", () => {
    const event = mapClickUpTaskToEvent(fixtureTask());
    expect(event.itemType).toBe("task");
    expect(event.externalProjectId).toBe("list-900");
    expect(event.itemNumber).toBe("86xy1");
    expect(event.providerItemId).toBe("86xy1");
    expect(event.itemUrl).toBe("https://app.clickup.com/t/86xy1");
    expect(event.title).toBe("Ship the ClickUp adapter");
    // description wins over text_content, passed through verbatim (markdown).
    expect(event.description).toBe("**markdown** body");
    expect(event.sourceStatusName).toBe("in progress");
    expect(event.sourceStatusId).toBe("st-2");
    expect(event.statusCategory).toBe("started");
    expect(event.priority).toBe("high");
    // primary assignee = first assignee's email.
    expect(event.assigneeEmail).toBe("dana@example.com");
    // tags→labels, de-duped.
    expect(event.labels).toEqual(["backend", "sync"]);
    expect(event.dueAt).toBe(1508369194377);
    expect(event.startAt).toBe(1508369100000);
    expect(event.actor).toBe("fabricio");
  });

  it("falls back to text_content when description is empty, and null when both empty", () => {
    expect(mapClickUpTaskToEvent(fixtureTask({ description: "" })).description).toBe("plain body");
    expect(
      mapClickUpTaskToEvent(fixtureTask({ description: "", text_content: "" })).description,
    ).toBeNull();
  });

  it("clears priority/dates/assignee when absent", () => {
    const event = mapClickUpTaskToEvent(
      fixtureTask({ priority: null, due_date: null, start_date: null, assignees: [], tags: [] }),
    );
    expect(event.priority).toBe("none");
    expect(event.dueAt).toBeNull();
    expect(event.startAt).toBeNull();
    expect(event.assigneeEmail).toBeNull();
    expect(event.labels).toEqual([]);
  });
});

describe("mapClickUpTaskToItem", () => {
  it("maps a task into the import item shape", () => {
    const item = mapClickUpTaskToItem(fixtureTask());
    expect(item).not.toBeNull();
    expect(item?.itemType).toBe("task");
    expect(item?.itemNumber).toBe("86xy1");
    expect(item?.title).toBe("Ship the ClickUp adapter");
    expect(item?.statusCategory).toBe("started");
    expect(item?.priority).toBe("high");
    expect(item?.labels).toEqual(["backend", "sync"]);
  });

  it("returns null when the payload has no id or is not an object", () => {
    expect(mapClickUpTaskToItem(fixtureTask({ id: "" }))).toBeNull();
    expect(mapClickUpTaskToItem(null)).toBeNull();
    expect(mapClickUpTaskToItem("nope")).toBeNull();
  });
});

describe("mapClickUpWebhookToEvents", () => {
  it("derives a status change from a native taskStatusUpdated (history_items)", () => {
    const events = mapClickUpWebhookToEvents({
      event: "taskStatusUpdated",
      task_id: "86xy1",
      list_id: "list-900",
      history_items: [
        {
          field: "status",
          user: { username: "dana", email: "dana@example.com" },
          before: { status: "to do", type: "open" },
          after: { id: "st-3", status: "done", type: "done" },
        },
      ],
    });
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e.itemType).toBe("task");
    expect(e.externalProjectId).toBe("list-900");
    expect(e.itemNumber).toBe("86xy1");
    expect(e.providerItemId).toBe("86xy1");
    expect(e.sourceStatusName).toBe("done");
    expect(e.sourceStatusId).toBe("st-3");
    expect(e.statusCategory).toBe("completed");
    expect(e.actor).toBe("dana");
  });

  it("maps the full field bag when the webhook embeds a task object", () => {
    const events = mapClickUpWebhookToEvents({
      event: "taskCreated",
      task_id: "86xy1",
      task: fixtureTask(),
      history_items: [{ field: "status", user: { username: "dana" } }],
    });
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e.itemType).toBe("task");
    expect(e.title).toBe("Ship the ClickUp adapter");
    expect(e.externalProjectId).toBe("list-900");
    expect(e.priority).toBe("high");
    expect(e.assigneeEmail).toBe("dana@example.com");
    // actor comes from the history user, overriding the task creator.
    expect(e.actor).toBe("dana");
  });

  it("maps taskCommentPosted to a comment event (parent id as itemNumber)", () => {
    const events = mapClickUpWebhookToEvents({
      event: "taskCommentPosted",
      task_id: "86xy1",
      list_id: "list-900",
      history_items: [
        {
          field: "comment",
          user: { username: "eli" },
          comment: { id: "cmt-77", comment_text: "looks good to me" },
        },
      ],
    });
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e.itemType).toBe("comment");
    expect(e.itemNumber).toBe("86xy1");
    expect(e.providerItemId).toBe("cmt-77");
    expect(e.commentBody).toBe("looks good to me");
    expect(e.actor).toBe("eli");
  });

  it("maps taskDeleted to a deleted event", () => {
    const events = mapClickUpWebhookToEvents({
      event: "taskDeleted",
      task_id: "86xy1",
      list_id: "list-900",
      history_items: [{ user: { email: "dana@example.com" } }],
    });
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e.itemType).toBe("deleted");
    expect(e.itemNumber).toBe("86xy1");
    expect(e.providerItemId).toBe("86xy1");
    expect(e.actor).toBe("dana@example.com");
  });

  it("returns [] for an unrecognized event or a non-object body", () => {
    expect(mapClickUpWebhookToEvents({ event: "listCreated", task_id: "1" })).toEqual([]);
    expect(mapClickUpWebhookToEvents({ task_id: "1" })).toEqual([]);
    expect(mapClickUpWebhookToEvents(null)).toEqual([]);
    expect(mapClickUpWebhookToEvents("nope")).toEqual([]);
  });
});
