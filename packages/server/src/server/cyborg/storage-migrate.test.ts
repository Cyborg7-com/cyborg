import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CyborgStorage } from "./storage.js";

// Regression for the 0.0.206 daemon crash-loop: an existing local DB whose `tasks`
// table predates the Phase-0 `sort_order` column would throw "no such column:
// sort_order" because the index on tasks(... sort_order) was created inline in the
// table-creation exec() — BEFORE addColumnIfMissing added the column — so migrate()
// threw and the worker crash-looped, never binding a port. The index must be
// created only AFTER the column is ensured.
describe("CyborgStorage migrate — upgrade from a pre-sort_order DB", () => {
  it("does not throw and ends up with tasks.sort_order + its index", () => {
    const dir = mkdtempSync(join(tmpdir(), "cyborg-mig-"));
    const dbPath = join(dir, "cyborg7.db");
    try {
      // Seed a realistic OLD tasks table: the BASE columns that predate Phase-0,
      // but WITHOUT sort_order/start_date/archived_at/is_draft (which migrate's
      // addColumnIfMissing adds) — the exact crash-looping upgrade state.
      const seed = new Database(dbPath);
      seed.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL,
          assignee_id TEXT,
          created_by TEXT,
          due_at INTEGER,
          recurrence TEXT,
          result TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      seed.close();

      // The constructor runs migrate(); on the old schema this used to throw.
      let storage: CyborgStorage | undefined;
      try {
        expect(() => {
          storage = new CyborgStorage(dbPath);
        }).not.toThrow();
      } finally {
        storage?.close(); // release the SQLite handle before re-opening read-only
      }

      const check = new Database(dbPath, { readonly: true });
      try {
        const cols = check.pragma("table_info(tasks)") as Array<{ name: string }>;
        expect(cols.some((c) => c.name === "sort_order")).toBe(true);
        const idx = check
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get("idx_tasks_workspace_sort");
        expect(idx).toBeTruthy();
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent on a fresh DB (migrate twice, no throw)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cyborg-mig2-"));
    const dbPath = join(dir, "cyborg7.db");
    let s1: CyborgStorage | undefined;
    let s2: CyborgStorage | undefined;
    try {
      expect(() => {
        s1 = new CyborgStorage(dbPath);
      }).not.toThrow();
      s1?.close();
      s1 = undefined;
      expect(() => {
        s2 = new CyborgStorage(dbPath);
      }).not.toThrow();
    } finally {
      s1?.close();
      s2?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Regression for the #960 upgrade crash-loop: an existing local DB whose `schedules`
// table predates the per-task `task_id` column (added in #960) would throw "no such
// column: task_id" because idx_schedules_task was created inline in the first
// table-creation exec() — BEFORE addColumnIfMissing added the column — so migrate()
// threw and the daemon crash-looped (Offline). The index must be created only AFTER
// the column is ensured.
describe("CyborgStorage migrate — upgrade from a pre-task_id schedules DB", () => {
  it("does not throw and ends up with schedules.task_id + its index", () => {
    const dir = mkdtempSync(join(tmpdir(), "cyborg-mig-sched-"));
    const dbPath = join(dir, "cyborg7.db");
    try {
      // Seed a genuinely OLD schedules table: the BASE columns that predate #960,
      // WITHOUT task_id (and WITHOUT max_runs/run_count/catch_up either) — the exact
      // crash-looping upgrade state.
      const seed = new Database(dbPath);
      try {
        seed.exec(`
        CREATE TABLE schedules (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          cybo_id TEXT NOT NULL,
          channel_id TEXT,
          cron_expr TEXT NOT NULL,
          timezone TEXT,
          prompt TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_run_at INTEGER,
          next_run_at INTEGER,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      } finally {
        seed.close();
      }

      // The constructor runs migrate(); on the old schema this used to throw.
      let storage: CyborgStorage | undefined;
      try {
        expect(() => {
          storage = new CyborgStorage(dbPath);
        }).not.toThrow();
      } finally {
        storage?.close(); // release the SQLite handle before re-opening read-only
      }

      const check = new Database(dbPath, { readonly: true });
      try {
        const cols = check.pragma("table_info(schedules)") as Array<{ name: string }>;
        expect(cols.some((c) => c.name === "task_id")).toBe(true);
        const idx = check
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get("idx_schedules_task");
        expect(idx).toBeTruthy();
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent on the upgraded DB (migrate twice on the old shape, no throw)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cyborg-mig-sched2-"));
    const dbPath = join(dir, "cyborg7.db");
    let s1: CyborgStorage | undefined;
    let s2: CyborgStorage | undefined;
    try {
      const seed = new Database(dbPath);
      try {
        seed.exec(`
        CREATE TABLE schedules (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          cybo_id TEXT NOT NULL,
          channel_id TEXT,
          cron_expr TEXT NOT NULL,
          timezone TEXT,
          prompt TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_run_at INTEGER,
          next_run_at INTEGER,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      } finally {
        seed.close();
      }

      // First migrate adds task_id + the index; the second must be a clean no-op.
      expect(() => {
        s1 = new CyborgStorage(dbPath);
      }).not.toThrow();
      s1?.close();
      s1 = undefined;
      expect(() => {
        s2 = new CyborgStorage(dbPath);
      }).not.toThrow();
    } finally {
      s1?.close();
      s2?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
