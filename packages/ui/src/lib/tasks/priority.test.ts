// Unit tests for the PURE priority helper. No DOM — pure mapping over a Task.
import { describe, expect, it } from "vitest";
import type { Task } from "$lib/core/types.js";
import { priorityForTask, priorityStyle } from "./priority.js";

function task(overrides: Partial<Task> & Record<string, unknown>): Task {
  return {
    id: "t1",
    workspaceId: "w1",
    title: "Task",
    description: null,
    status: "todo",
    assigneeId: null,
    createdBy: "u1",
    dueAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Task;
}

describe("priorityForTask", () => {
  it("resolves to 'none' when the task has no priority field (current Task shape)", () => {
    expect(priorityForTask(task({}))).toBe("none");
  });

  it("reads a forward-compatible priority value when present", () => {
    expect(priorityForTask(task({ priority: "urgent" }))).toBe("urgent");
    expect(priorityForTask(task({ priority: "high" }))).toBe("high");
    expect(priorityForTask(task({ priority: "medium" }))).toBe("medium");
    expect(priorityForTask(task({ priority: "low" }))).toBe("low");
  });

  it("maps an unknown / null / empty priority to 'none'", () => {
    // "bogus" / "" are DELIBERATELY-INVALID: they exercise the runtime fallback,
    // so they must bypass the strict Task["priority"] union to typecheck.
    expect(priorityForTask(task({ priority: "bogus" as unknown as Task["priority"] }))).toBe("none");
    expect(priorityForTask(task({ priority: null }))).toBe("none");
    expect(priorityForTask(task({ priority: "" as unknown as Task["priority"] }))).toBe("none");
  });
});

describe("priorityStyle", () => {
  it("returns null for 'none' (nothing to render)", () => {
    expect(priorityStyle("none")).toBeNull();
  });

  it("returns a dot class + label for each real priority", () => {
    expect(priorityStyle("urgent")).toEqual({ dot: "bg-error", label: "Urgent" });
    expect(priorityStyle("high")).toEqual({ dot: "bg-warning", label: "High" });
    expect(priorityStyle("medium")).toEqual({ dot: "bg-pin", label: "Medium" });
    expect(priorityStyle("low")).toEqual({ dot: "bg-content-muted", label: "Low" });
  });
});
