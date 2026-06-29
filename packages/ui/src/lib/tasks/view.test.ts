// Unit tests for the PURE Tasks view model (group + filter). No DOM — pure data
// transforms, so it runs in the node-env vitest pass.
import { describe, expect, it } from "vitest";
import type { Task, WorkspaceMember } from "$lib/core/types.js";
import type { Agent, Cybo } from "$lib/plugins/agents/types.js";
import type { AssigneePools } from "./assignee.js";
import {
  activeFilterCount,
  assigneeOptions,
  DEFAULT_DISPLAY,
  DEFAULT_ORDER_BY,
  DEFAULT_ORDER_DIR,
  emptyFilters,
  filterTasks,
  groupByAssignee,
  groupByPriority,
  groupByStatus,
  groupTasks,
  isDisplayed,
  isOverall,
  matchesFilters,
  sortTasks,
  type TaskFilters,
} from "./view.js";

function task(overrides: Partial<Task> & { priority?: string | null }): Task {
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

function member(overrides: Partial<WorkspaceMember>): WorkspaceMember {
  return {
    userId: "u1",
    email: "ada@example.com",
    name: "Ada",
    role: "member",
    membershipType: "active",
    joinedAt: 0,
    ...overrides,
  };
}

function cybo(overrides: Partial<Cybo>): Cybo {
  return {
    id: "cybo-1",
    slug: "apex",
    name: "Apex",
    provider: "claude",
    isDefault: false,
    createdAt: 0,
    ...overrides,
  };
}

function agent(overrides: Partial<Agent>): Agent {
  return { agentId: "agent-1", provider: "claude", lifecycle: "running", ...overrides };
}

const pools: AssigneePools = {
  members: [member({ userId: "u1", name: "Ada" }), member({ userId: "u2", name: "Bob" })],
  cybos: [cybo({ id: "cybo-1", name: "Apex" })],
  agents: [agent({ agentId: "agent-1" })],
};

describe("isOverall / emptyFilters", () => {
  it("empty filters is the Overall default", () => {
    expect(isOverall(emptyFilters())).toBe(true);
  });
  it("any selection leaves Overall", () => {
    expect(isOverall({ ...emptyFilters(), kinds: ["user"] })).toBe(false);
  });
});

describe("activeFilterCount", () => {
  it("sums every facet's selections", () => {
    const f: TaskFilters = {
      assigneeIds: ["u1"],
      kinds: ["agent"],
      priorities: ["high"],
      statuses: ["done", "todo"],
    };
    expect(activeFilterCount(f)).toBe(5);
  });
});

describe("groupByStatus", () => {
  it("always returns the four columns in order, empty included", () => {
    const groups = groupByStatus([task({ id: "a", status: "in_progress" })]);
    expect(groups.map((g) => g.key)).toEqual(["todo", "in_progress", "pending_review", "done"]);
    expect(groups[1].tasks.map((t) => t.id)).toEqual(["a"]);
    expect(groups[0].tasks).toEqual([]);
  });
  it("buckets legacy/unknown status into todo", () => {
    const groups = groupByStatus([task({ id: "p", status: "pending" })]);
    expect(groups[0].tasks.map((t) => t.id)).toEqual(["p"]);
  });
});

describe("groupByPriority", () => {
  it("orders urgent→low then No priority, dropping empty buckets", () => {
    const groups = groupByPriority([
      task({ id: "lo", priority: "low" }),
      task({ id: "ur", priority: "urgent" }),
      task({ id: "no" }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["urgent", "low", "none"]);
    expect(groups.at(-1)?.label).toBe("No priority");
  });
});

describe("groupByAssignee (per user / per agent)", () => {
  it("makes one group per identity, Unassigned LAST", () => {
    const groups = groupByAssignee(
      [
        task({ id: "a", assigneeId: "u1" }),
        task({ id: "b", assigneeId: "agent-1" }),
        task({ id: "c", assigneeId: null }),
        task({ id: "d", assigneeId: "u1" }),
      ],
      pools,
    );
    expect(groups.map((g) => g.key)).toEqual(["u1", "agent-1", "__unassigned__"]);
    expect(groups[0].kind).toBe("user");
    expect(groups[0].tasks.map((t) => t.id)).toEqual(["a", "d"]);
    expect(groups[1].kind).toBe("agent");
    expect(groups.at(-1)?.assigneeId).toBe(null);
  });
  it("omits the Unassigned group when everything is assigned", () => {
    const groups = groupByAssignee([task({ id: "a", assigneeId: "u1" })], pools);
    expect(groups.map((g) => g.key)).toEqual(["u1"]);
  });
  it("groupTasks dispatches by groupBy", () => {
    expect(groupTasks([], "status", pools).length).toBe(4);
    expect(groupTasks([task({ assigneeId: "u1" })], "assignee", pools)[0].key).toBe("u1");
  });
});

describe("matchesFilters / filterTasks", () => {
  it("Overall passes everything", () => {
    const t = task({ assigneeId: null });
    expect(matchesFilters(t, emptyFilters(), pools)).toBe(true);
  });

  it("filter by KIND People keeps humans, drops agents and unassigned (per user)", () => {
    const ts = [
      task({ id: "human", assigneeId: "u1" }),
      task({ id: "bot", assigneeId: "agent-1" }),
      task({ id: "none", assigneeId: null }),
    ];
    const out = filterTasks(ts, { ...emptyFilters(), kinds: ["user"] }, pools);
    expect(out.map((t) => t.id)).toEqual(["human"]);
  });

  it("filter by KIND Agents keeps only agents (per agent)", () => {
    const ts = [
      task({ id: "human", assigneeId: "u1" }),
      task({ id: "bot", assigneeId: "agent-1" }),
    ];
    const out = filterTasks(ts, { ...emptyFilters(), kinds: ["agent"] }, pools);
    expect(out.map((t) => t.id)).toEqual(["bot"]);
  });

  it("filter by specific assignee id", () => {
    const ts = [task({ id: "a", assigneeId: "u1" }), task({ id: "b", assigneeId: "u2" })];
    const out = filterTasks(ts, { ...emptyFilters(), assigneeIds: ["u2"] }, pools);
    expect(out.map((t) => t.id)).toEqual(["b"]);
  });

  it("filter by status (column) and priority, ANDed", () => {
    const ts = [
      task({ id: "a", status: "done", priority: "high" }),
      task({ id: "b", status: "done", priority: "low" }),
      task({ id: "c", status: "todo", priority: "high" }),
    ];
    const out = filterTasks(
      ts,
      { ...emptyFilters(), statuses: ["done"], priorities: ["high"] },
      pools,
    );
    expect(out.map((t) => t.id)).toEqual(["a"]);
  });
});

describe("sortTasks", () => {
  it("does not mutate the input", () => {
    const input = [task({ id: "b", title: "Bravo" }), task({ id: "a", title: "Alpha" })];
    const snapshot = input.map((t) => t.id);
    sortTasks(input, "title", "asc");
    expect(input.map((t) => t.id)).toEqual(snapshot);
  });

  it("sorts by title asc and desc", () => {
    const ts = [
      task({ id: "c", title: "Charlie" }),
      task({ id: "a", title: "Alpha" }),
      task({ id: "b", title: "Bravo" }),
    ];
    expect(sortTasks(ts, "title", "asc").map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(sortTasks(ts, "title", "desc").map((t) => t.id)).toEqual(["c", "b", "a"]);
  });

  it("sorts by createdAt (default desc = newest first)", () => {
    const ts = [
      task({ id: "old", createdAt: 100 }),
      task({ id: "new", createdAt: 300 }),
      task({ id: "mid", createdAt: 200 }),
    ];
    expect(sortTasks(ts, "createdAt", "desc").map((t) => t.id)).toEqual(["new", "mid", "old"]);
    expect(sortTasks(ts, "createdAt", "asc").map((t) => t.id)).toEqual(["old", "mid", "new"]);
  });

  it("sorts by priority — desc puts urgent first, none last", () => {
    const ts = [
      task({ id: "lo", priority: "low" }),
      task({ id: "ur", priority: "urgent" }),
      task({ id: "no" }),
      task({ id: "hi", priority: "high" }),
    ];
    expect(sortTasks(ts, "priority", "desc").map((t) => t.id)).toEqual(["ur", "hi", "lo", "no"]);
  });

  it("sorts by dueAt and keeps null-due tasks LAST in both directions", () => {
    const ts = [
      task({ id: "late", dueAt: 300 }),
      task({ id: "none", dueAt: null }),
      task({ id: "soon", dueAt: 100 }),
    ];
    expect(sortTasks(ts, "dueAt", "asc").map((t) => t.id)).toEqual(["soon", "late", "none"]);
    expect(sortTasks(ts, "dueAt", "desc").map((t) => t.id)).toEqual(["late", "soon", "none"]);
  });

  it("tie-breaks deterministically by createdAt then id", () => {
    const ts = [
      task({ id: "b", title: "Same", createdAt: 5 }),
      task({ id: "a", title: "Same", createdAt: 5 }),
    ];
    expect(sortTasks(ts, "title", "asc").map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("exposes sensible defaults", () => {
    expect(DEFAULT_ORDER_BY).toBe("createdAt");
    expect(DEFAULT_ORDER_DIR).toBe("desc");
  });
});

describe("isDisplayed / DEFAULT_DISPLAY", () => {
  it("every property defaults ON", () => {
    expect(Object.values(DEFAULT_DISPLAY).every(Boolean)).toBe(true);
  });
  it("reads an explicit false", () => {
    expect(isDisplayed({ priority: false }, "priority")).toBe(false);
  });
  it("falls back to the default for an absent key", () => {
    expect(isDisplayed({}, "assignee")).toBe(true);
  });
});

describe("assigneeOptions", () => {
  it("lists identities People → Cybos → Agents, deduped", () => {
    const opts = assigneeOptions(pools);
    expect(opts.map((o) => o.id)).toEqual(["u1", "u2", "cybo-1", "agent-1"]);
    expect(opts.map((o) => o.kind)).toEqual(["user", "user", "cybo", "agent"]);
  });
});
