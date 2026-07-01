import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CyborgStorage } from "./storage.js";

// Fix for label duplication: resolveLabels must have Django get_or_create semantics
// keyed by (project, case-insensitive name), enforced by the
// ux_task_labels_project_lower_name unique index. This proves the SQLite resolver
// (the solo/daemon write path; pg-sync mirrors it against real Postgres) is
// idempotent — resolving the same name twice, a case-variant, and a within-batch
// dup all reuse ONE row/id instead of creating "10x Engeneering".
describe("CyborgStorage.resolveLabels — get-or-create idempotency", () => {
  let storage: CyborgStorage;
  let tasksProjectId: string;

  beforeEach(() => {
    storage = new CyborgStorage(":memory:");
    const user = storage.upsertUser("labels@test.dev", "Labels User");
    const ws = storage.createWorkspace("Labels WS", user.id);
    const chatProject = storage.createProject(ws.id, "Engineering", "#4f46e5");
    const tp = storage.provisionTasksProject({
      workspaceId: ws.id,
      chatProjectId: chatProject.id,
      name: "Engineering",
    });
    tasksProjectId = tp.id;
  });

  afterEach(() => {
    storage.close();
  });

  it("reuses the same id across calls and casing, creating exactly one row", () => {
    const [first] = storage.resolveLabels(tasksProjectId, ["Engineering"]);
    const [again] = storage.resolveLabels(tasksProjectId, ["Engineering"]);
    const [variant] = storage.resolveLabels(tasksProjectId, ["ENGINEERING"]);

    expect(again).toBe(first);
    expect(variant).toBe(first);

    const labels = storage.getProjectLabels(tasksProjectId);
    expect(labels).toHaveLength(1);
    // First writer's casing is preserved (ON CONFLICT DO NOTHING never overwrites).
    expect(labels[0].name).toBe("Engineering");
  });

  it("dedups case-variants WITHIN a single batch to one id", () => {
    const ids = storage.resolveLabels(tasksProjectId, ["Bug", "bug", "BUG"]);
    expect(new Set(ids).size).toBe(1);
    expect(storage.getProjectLabels(tasksProjectId)).toHaveLength(1);
  });

  it("enforces uniqueness at the DB with the expected index", () => {
    // The unique expression index is what makes the resolver's ON CONFLICT race-safe;
    // its presence is the guarantee, not just app-level dedup. Reach into the private
    // better-sqlite3 handle for the check.
    const db = (storage as unknown as { db: { pragma(s: string): unknown } }).db;
    const idx = db.pragma("index_list(task_labels)") as Array<{ name: string }>;
    expect(idx.some((i) => i.name === "ux_task_labels_project_lower_name")).toBe(true);
  });
});
