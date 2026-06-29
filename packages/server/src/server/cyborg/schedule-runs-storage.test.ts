import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";

// Storage-level coverage for the scheduler phase-2 surface (#619) on REAL SQLite
// (DualStorage with no PG = solo mode). Proves the run-history table + lifecycle
// columns persist and round-trip, independent of the runner's decision logic.

describe("Schedule run-history + lifecycle storage (#619, real SQLite)", () => {
  let storage: DualStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-schruns-"));
    storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "test.db")), null);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function newSchedule(over: { maxRuns?: number | null; catchUp?: boolean } = {}) {
    return storage.createSchedule({
      workspaceId: "ws_1",
      cyboId: "cybo_1",
      cronExpr: "0 9 * * *",
      prompt: "summarize",
      createdBy: "user_1",
      nextRunAt: Date.now(),
      ...over,
    });
  }

  it("createSchedule defaults: recurring (max_runs null), run_count 0, catch_up on", () => {
    const s = newSchedule();
    expect(s.max_runs).toBeNull();
    expect(s.run_count).toBe(0);
    expect(s.catch_up).toBe(1);
  });

  it("createSchedule persists a one-shot (maxRuns=1) and catch_up=false", () => {
    const s = newSchedule({ maxRuns: 1, catchUp: false });
    expect(s.max_runs).toBe(1);
    expect(s.catch_up).toBe(0);
    // …and reads back the same from a fresh fetch.
    const reread = storage.getSchedule(s.id);
    expect(reread?.max_runs).toBe(1);
    expect(reread?.catch_up).toBe(0);
  });

  it("markScheduleRun bumps run_count only when asked", () => {
    const s = newSchedule();
    storage.markScheduleRun(s.id, Date.now(), Date.now() + 60_000); // no increment
    expect(storage.getSchedule(s.id)?.run_count).toBe(0);
    storage.markScheduleRun(s.id, Date.now(), Date.now() + 60_000, true); // +1
    storage.markScheduleRun(s.id, Date.now(), Date.now() + 60_000, true); // +1
    expect(storage.getSchedule(s.id)?.run_count).toBe(2);
  });

  it("start → finish records a 'running' row that closes to 'succeeded' with agentId", () => {
    const s = newSchedule();
    const scheduledFor = Date.now();
    const runId = storage.startScheduleRun({
      scheduleId: s.id,
      workspaceId: "ws_1",
      scheduledFor,
    });
    let runs = storage.listScheduleRuns(s.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("running");
    expect(runs[0].scheduled_for).toBe(scheduledFor);
    expect(runs[0].ended_at).toBeNull();

    storage.finishScheduleRun({ id: runId, status: "succeeded", agentId: "ag_1" });
    runs = storage.listScheduleRuns(s.id);
    expect(runs[0].status).toBe("succeeded");
    expect(runs[0].agent_id).toBe("ag_1");
    expect(runs[0].ended_at).not.toBeNull();
  });

  it("a failed run records the error; skipped runs carry the closed-set reason", () => {
    const s = newSchedule();
    const failId = storage.startScheduleRun({
      scheduleId: s.id,
      workspaceId: "ws_1",
      scheduledFor: Date.now(),
    });
    storage.finishScheduleRun({ id: failId, status: "failed", error: "boom" });

    storage.recordSkippedScheduleRun({
      scheduleId: s.id,
      workspaceId: "ws_1",
      scheduledFor: Date.now(),
      skipReason: "license_paused",
    });

    const runs = storage.listScheduleRuns(s.id);
    // Newest first; both are present.
    const failed = runs.find((r) => r.status === "failed");
    const skipped = runs.find((r) => r.status === "skipped");
    expect(failed?.error).toBe("boom");
    expect(skipped?.skip_reason).toBe("license_paused");
    expect(skipped?.ended_at).not.toBeNull(); // skipped rows open+close together
  });

  it("listScheduleRuns returns newest-first and honors the limit", () => {
    const s = newSchedule();
    for (let i = 0; i < 5; i++) {
      const id = storage.startScheduleRun({
        scheduleId: s.id,
        workspaceId: "ws_1",
        scheduledFor: Date.now() + i,
      });
      storage.finishScheduleRun({ id, status: "succeeded", agentId: `ag_${i}` });
    }
    const limited = storage.listScheduleRuns(s.id, 2);
    expect(limited).toHaveLength(2);
    // Most recent (highest scheduled_for) first.
    expect(limited[0].scheduled_for).toBeGreaterThanOrEqual(limited[1].scheduled_for as number);
  });
});
