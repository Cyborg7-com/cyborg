import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";

// Regression net for the Phase-0 task storage methods (flagged by review as
// untested): getTasks limit/cursor pagination + nextCursor, reorderTask,
// bulkUpdateTasks, deleteTask, archiveTask. Exercised through DualStorage in
// SOLO mode (pg = null) so every call delegates to the authoritative SQLite —
// real DB, no mocks. Mirrors dual-storage.test.ts's setup/teardown exactly
// (mkdtempSync temp dir, `await storage.close()` only — no rmSync, which on
// Windows would EBUSY against the just-closed handle and add flakiness). A
// single flat describe (no nested describe) keeps callbacks within oxlint's
// max-nested-callbacks limit, matching dual-storage.test.ts.

describe("DualStorage — Phase-0 task mutations (solo, real SQLite)", () => {
  let storage: DualStorage;
  let tmpDir: string;
  let workspaceId: string;
  let userId: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "task-mut-"));
    const sqlite = new CyborgStorage(path.join(tmpDir, "test.db"));
    storage = new DualStorage(sqlite, null);
    const user = storage.upsertUser("tasks@test.dev", "Tasks User");
    userId = user.id;
    const ws = storage.createWorkspace("Tasks WS", user.id);
    workspaceId = ws.id;
  });

  afterEach(async () => {
    await storage.close();
  });

  // Seed N tasks in deterministic order. Each new task appends at the tail of
  // the (workspace, status="pending") lane, so it gets a distinct incrementing
  // integer sort_order (0,1,2,…) — the order key the page query sorts by.
  function seedTasks(n: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      // Project-agnostic seed: a project-less channel routes the task to the
      // workspace Inbox, satisfying the require-project resolver.
      const task = storage.createTask({
        workspaceId,
        title: `Task ${i}`,
        createdBy: userId,
        channelId: "no-project-channel",
      });
      ids.push(task.id);
    }
    return ids;
  }

  function orderedIds(): string[] {
    return storage.getTasks(workspaceId).map((t) => t.id);
  }

  // ─── Pagination (getTasks limit/cursor + getTasksPage nextCursor) ──────────

  it("pagination: getTasks honors limit and walks the cursor with no overlap and no gaps", () => {
    const seeded = seedTasks(10); // sort_order 0..9, the stable order

    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    // Page through in fixed steps of 3 until the page query reports the tail.
    // 10 items / limit 3 → pages of 3,3,3,1.
    for (;;) {
      const page = storage.getTasksPage(workspaceId, { limit: 3, cursor });
      expect(page.tasks.length).toBeLessThanOrEqual(3);
      for (const t of page.tasks) collected.push(t.id);
      pages++;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(pages).toBe(4);
    // Every seeded task came back exactly once (no overlap, no gaps)…
    expect(collected).toHaveLength(seeded.length);
    expect(new Set(collected).size).toBe(seeded.length);
    // …and in the stable sort_order order (the seed order).
    expect(collected).toEqual(seeded);
  });

  it("pagination: a full first page yields a nextCursor; the last (short) page has none", () => {
    const seeded = seedTasks(5);

    const first = storage.getTasksPage(workspaceId, { limit: 2 });
    expect(first.tasks.map((t) => t.id)).toEqual(seeded.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();

    const second = storage.getTasksPage(workspaceId, { limit: 2, cursor: first.nextCursor! });
    expect(second.tasks.map((t) => t.id)).toEqual(seeded.slice(2, 4));
    expect(second.nextCursor).not.toBeNull();

    // 5th item alone — a short page is the tail, so no further cursor.
    const third = storage.getTasksPage(workspaceId, { limit: 2, cursor: second.nextCursor! });
    expect(third.tasks.map((t) => t.id)).toEqual(seeded.slice(4, 5));
    expect(third.nextCursor).toBeNull();
  });

  it("pagination: a page exactly filled by the remaining rows resolves to no nextCursor", () => {
    const seeded = seedTasks(4); // 4 items, limit 2 → 2 full pages

    const first = storage.getTasksPage(workspaceId, { limit: 2 });
    expect(first.tasks.map((t) => t.id)).toEqual(seeded.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();

    const second = storage.getTasksPage(workspaceId, { limit: 2, cursor: first.nextCursor! });
    expect(second.tasks.map((t) => t.id)).toEqual(seeded.slice(2, 4));
    // Exactly the tail: the +1 look-ahead found no extra row, so no cursor.
    expect(second.nextCursor).toBeNull();
  });

  it("pagination: no limit returns the whole list in the stable order (sort_order, created_at, id)", () => {
    const seeded = seedTasks(6);
    const all = storage.getTasks(workspaceId);
    expect(all.map((t) => t.id)).toEqual(seeded);
    // sort_order is the dominant, strictly-increasing key for these tail-appended rows.
    const sortOrders = all.map((t) => t.sort_order ?? null);
    expect(sortOrders).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("pagination: rows with a NULL sort_order sort LAST, after the ordered ones", () => {
    const seeded = seedTasks(3); // sort_order 0,1,2
    // Force the middle task's sort_order to NULL — it must fall to the tail.
    storage.updateTask(seeded[1], { sortOrder: null });

    expect(orderedIds()).toEqual([seeded[0], seeded[2], seeded[1]]);
  });

  // ─── reorderTask ──────────────────────────────────────────────────────────

  it("reorderTask: moving a task between two neighbours lands its sortOrder strictly between them", () => {
    const seeded = seedTasks(3); // sort_order 0,1,2

    // Drop seeded[2] between seeded[0] (sort 0) and seeded[1] (sort 1):
    // beforeId is the upper neighbour, afterId the lower one. Midpoint → 0.5.
    const moved = storage.reorderTask(seeded[2], { beforeId: seeded[0], afterId: seeded[1] });
    expect(moved).toBeDefined();
    expect(moved!.sort_order).toBe(0.5);
    expect(moved!.sort_order!).toBeGreaterThan(0);
    expect(moved!.sort_order!).toBeLessThan(1);

    // The board order reflects the move: 0, 0.5, 1 → seeded[0], seeded[2], seeded[1].
    expect(orderedIds()).toEqual([seeded[0], seeded[2], seeded[1]]);
  });

  it("reorderTask: reorder to first (only a lower neighbour) places it above that neighbour", () => {
    const seeded = seedTasks(3); // sort_order 0,1,2

    // Drop seeded[2] at the TOP, above seeded[0] (sort 0): afterSort - 1 = -1.
    const moved = storage.reorderTask(seeded[2], { afterId: seeded[0] });
    expect(moved!.sort_order).toBe(-1);

    expect(orderedIds()).toEqual([seeded[2], seeded[0], seeded[1]]);
  });

  it("reorderTask: reorder to last (only an upper neighbour) places it below that neighbour", () => {
    const seeded = seedTasks(3); // sort_order 0,1,2

    // Drop seeded[0] at the BOTTOM, below seeded[2] (sort 2): beforeSort + 1 = 3.
    const moved = storage.reorderTask(seeded[0], { beforeId: seeded[2] });
    expect(moved!.sort_order).toBe(3);

    expect(orderedIds()).toEqual([seeded[1], seeded[2], seeded[0]]);
  });

  it("reorderTask: reordering a missing task is a no-op returning undefined", () => {
    seedTasks(2);
    expect(storage.reorderTask("task_does_not_exist", {})).toBeUndefined();
  });

  // ─── bulkUpdateTasks ────────────────────────────────────────────────────────

  it("bulkUpdateTasks: applies the given fields to all listed ids in one pass and leaves others untouched", () => {
    const seeded = seedTasks(4); // all status "pending", priority null
    const targets = [seeded[0], seeded[2]];

    const updated = storage.bulkUpdateTasks(targets, { status: "done", priority: "high" });

    // Only the listed ids are returned, both reflecting the new fields.
    expect(updated.map((t) => t.id).sort()).toEqual([...targets].sort());
    for (const t of updated) {
      expect(t.status).toBe("done");
      expect(t.priority).toBe("high");
    }

    // The change is persisted, and ONLY the listed rows changed.
    const byId = new Map(storage.getTasks(workspaceId).map((t) => [t.id, t]));
    expect(byId.get(seeded[0])!.status).toBe("done");
    expect(byId.get(seeded[2])!.status).toBe("done");
    // The unlisted rows keep their original status/priority.
    expect(byId.get(seeded[1])!.status).toBe("pending");
    expect(byId.get(seeded[1])!.priority ?? null).toBeNull();
    expect(byId.get(seeded[3])!.status).toBe("pending");
    expect(byId.get(seeded[3])!.priority ?? null).toBeNull();
  });

  it("bulkUpdateTasks: skips ids that do not exist and returns only the rows it actually updated", () => {
    const seeded = seedTasks(2);

    const updated = storage.bulkUpdateTasks([seeded[0], "task_missing", seeded[1]], {
      status: "in_progress",
    });

    expect(updated.map((t) => t.id).sort()).toEqual([seeded[0], seeded[1]].sort());
    for (const t of updated) expect(t.status).toBe("in_progress");
  });

  // ─── deleteTask ───────────────────────────────────────────────────────────

  it("deleteTask: removes the row and excludes it from subsequent reads", () => {
    const seeded = seedTasks(3);

    expect(storage.deleteTask(seeded[1])).toBe(true);

    const remaining = orderedIds();
    expect(remaining).toEqual([seeded[0], seeded[2]]);
    expect(remaining).not.toContain(seeded[1]);
  });

  it("deleteTask: deleting a missing id is a safe no-op returning false", () => {
    seedTasks(1);
    expect(storage.deleteTask("task_never_existed")).toBe(false);
    // The surviving row is untouched.
    expect(storage.getTasks(workspaceId)).toHaveLength(1);
  });

  // ─── archiveTask ────────────────────────────────────────────────────────────

  it("archiveTask: sets archived_at on archive and clears it on un-archive", () => {
    const [taskId] = seedTasks(1);

    const before = Date.now();
    const archived = storage.archiveTask(taskId, true);
    const after = Date.now();
    expect(archived).toBeDefined();
    expect(typeof archived!.archived_at).toBe("number");
    // The timestamp is "now" — within the call window.
    expect(archived!.archived_at!).toBeGreaterThanOrEqual(before);
    expect(archived!.archived_at!).toBeLessThanOrEqual(after);

    // The persisted row reflects the archive.
    const fetchedArchived = storage.getTasks(workspaceId).find((t) => t.id === taskId)!;
    expect(fetchedArchived.archived_at).toBe(archived!.archived_at);

    // Un-archiving clears archived_at back to null.
    const restored = storage.archiveTask(taskId, false);
    expect(restored!.archived_at).toBeNull();
    const fetchedRestored = storage.getTasks(workspaceId).find((t) => t.id === taskId)!;
    expect(fetchedRestored.archived_at).toBeNull();
  });

  it("archiveTask: archiving a missing task is a no-op returning undefined", () => {
    seedTasks(1);
    expect(storage.archiveTask("task_absent", true)).toBeUndefined();
  });
});
