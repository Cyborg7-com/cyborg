import { describe, expect, it, vi } from "vitest";
import type { Task } from "$lib/core/types.js";

// boardMutations.ts imports the reactive app store + client (for its optimistic
// reorder/move wrappers), which transitively pull `$app/navigation` — unresolved
// in this standalone vitest config (it only aliases `$lib`). The pure
// reorderTasksLocally helper under test needs none of it, so we stub those modules
// to keep the import graph clean.
vi.mock("$lib/state/app.svelte.js", () => ({
  workspaceState: { tasks: [], current: null },
  client: {},
}));
vi.mock("svelte-sonner", () => ({ toast: { error: () => {} } }));

const { reorderTasksLocally } = await import("./boardMutations.js");

// The pure array splice maps the SAME four anchor cases as the server's
// computeReorderSort (task-ordering.ts:58-69) into array space. Testing the pure
// helper (rather than the optimistic wrapper) keeps this deterministic — no
// reactive state / network mocks.
function t(id: string): Task {
  return {
    id,
    workspaceId: "ws",
    title: id,
    description: null,
    status: "todo",
    assigneeId: null,
    createdBy: "u",
    dueAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}
const ids = (list: Task[]): string[] => list.map((x) => x.id);

describe("reorderTasksLocally — 4 anchor cases (computeReorderSort parity)", () => {
  const base = [t("a"), t("b"), t("c"), t("d")];

  it("both anchors → between beforeId (upper) and afterId (lower)", () => {
    expect(ids(reorderTasksLocally(base, "d", { beforeId: "a", afterId: "b" }))).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  it("afterId only → ABOVE afterId (top-of-gap drop)", () => {
    expect(ids(reorderTasksLocally(base, "d", { afterId: "b" }))).toEqual(["a", "d", "b", "c"]);
  });

  it("beforeId only → BELOW beforeId (bottom-of-gap drop)", () => {
    expect(ids(reorderTasksLocally(base, "a", { beforeId: "c" }))).toEqual(["b", "c", "a", "d"]);
  });

  it("neither anchor → appended at the tail", () => {
    expect(ids(reorderTasksLocally(base, "a", {}))).toEqual(["b", "c", "d", "a"]);
  });

  it("unknown/stale anchor is treated as absent → tail", () => {
    expect(ids(reorderTasksLocally(base, "a", { afterId: "zzz" }))).toEqual(["b", "c", "d", "a"]);
  });

  it("unknown taskId → array unchanged", () => {
    expect(ids(reorderTasksLocally(base, "zzz", { afterId: "b" }))).toEqual(["a", "b", "c", "d"]);
  });
});
