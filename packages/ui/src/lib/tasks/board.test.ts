// Unit tests for the PURE board bucketing. No DOM — it only partitions tasks by
// status, so it runs in the node-env vitest pass.
import { describe, expect, it } from "vitest";
import type { Task } from "$lib/core/types.js";
import { bucketTasks, columnForStatus, COLUMNS } from "./board.js";

// Minimal Task factory — only `status` matters for bucketing; the rest are
// filled with inert defaults so we exercise the real type.
function task(overrides: Partial<Task>): Task {
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
  };
}

describe("COLUMNS", () => {
  it("declares the four board columns in display order", () => {
    expect(COLUMNS.map((c) => c.key)).toEqual(["todo", "in_progress", "pending_review", "done"]);
    expect(COLUMNS.map((c) => c.label)).toEqual(["To Do", "In Progress", "Review", "Done"]);
  });
});

describe("columnForStatus", () => {
  it("maps each canonical status to its own column", () => {
    expect(columnForStatus("todo")).toBe("todo");
    expect(columnForStatus("in_progress")).toBe("in_progress");
    expect(columnForStatus("pending_review")).toBe("pending_review");
    expect(columnForStatus("done")).toBe("done");
  });

  it("buckets legacy 'pending' into To Do", () => {
    expect(columnForStatus("pending")).toBe("todo");
  });

  it("buckets an unknown status into To Do", () => {
    expect(columnForStatus("scheduled")).toBe("todo");
    expect(columnForStatus("garbage")).toBe("todo");
  });

  it("buckets an empty/null/undefined status into To Do", () => {
    expect(columnForStatus("")).toBe("todo");
    expect(columnForStatus(null)).toBe("todo");
    expect(columnForStatus(undefined)).toBe("todo");
  });
});

describe("bucketTasks", () => {
  it("returns four empty columns for empty input", () => {
    const b = bucketTasks([]);
    expect(Object.keys(b).sort()).toEqual(["done", "in_progress", "pending_review", "todo"]);
    expect(b.todo).toEqual([]);
    expect(b.in_progress).toEqual([]);
    expect(b.pending_review).toEqual([]);
    expect(b.done).toEqual([]);
  });

  it("maps todo / in_progress / pending_review / done to their own columns", () => {
    const todo = task({ id: "a", status: "todo" });
    const active = task({ id: "b", status: "in_progress" });
    const review = task({ id: "c", status: "pending_review" });
    const done = task({ id: "d", status: "done" });
    const b = bucketTasks([todo, active, review, done]);
    expect(b.todo).toEqual([todo]);
    expect(b.in_progress).toEqual([active]);
    expect(b.pending_review).toEqual([review]);
    expect(b.done).toEqual([done]);
  });

  it("buckets legacy 'pending' tasks into To Do", () => {
    const legacy = task({ id: "p", status: "pending" });
    const b = bucketTasks([legacy]);
    expect(b.todo).toEqual([legacy]);
    expect(b.in_progress).toEqual([]);
  });

  it("buckets unknown / empty statuses into To Do", () => {
    const unknown = task({ id: "x", status: "wat" });
    const blank = task({ id: "y", status: "" });
    const b = bucketTasks([unknown, blank]);
    expect(b.todo).toEqual([unknown, blank]);
  });

  it("preserves input order within a column", () => {
    const first = task({ id: "1", status: "todo" });
    const second = task({ id: "2", status: "todo" });
    const third = task({ id: "3", status: "todo" });
    expect(bucketTasks([first, second, third]).todo).toEqual([first, second, third]);
  });
});
