import { describe, it, expect } from "vitest";
import { detectStaleSchedules } from "./pg-sync.js";
import type { StoredSchedule } from "../storage.js";

// Pure staleness check for the schedule mirror (#619 §3.3): a schedule is "stale"
// (its owning daemon is gone) when NO daemon serving the workspace is alive AND
// the schedule is enabled with a next_run_at well in the past. Read-only — drives
// a UI "stale — daemon offline" badge, never execution. No DB needed (pure fn).

const NOW = 1_000_000_000_000; // fixed clock
const GRACE = 5 * 60_000;

function sched(over: Partial<StoredSchedule> = {}): StoredSchedule {
  return {
    id: "sch_1",
    workspace_id: "ws_1",
    cybo_id: "cybo_1",
    channel_id: null,
    cron_expr: "0 9 * * *",
    timezone: null,
    prompt: "p",
    enabled: 1,
    last_run_at: null,
    next_run_at: NOW - 60 * 60_000, // 1h overdue
    max_runs: null,
    run_count: 0,
    catch_up: 1,
    created_by: "user_1",
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

const onlineDaemon = { status: "online", lastSeenAt: NOW - 1_000 };
const staleHeartbeatDaemon = { status: "online", lastSeenAt: NOW - 5 * 60_000 }; // >90s
const offlineDaemon = { status: "offline", lastSeenAt: NOW - 10 * 60_000 };

describe("detectStaleSchedules (#619)", () => {
  it("flags an overdue schedule when every workspace daemon is offline", () => {
    const stale = detectStaleSchedules([sched()], [offlineDaemon], NOW, GRACE);
    expect(stale.has("sch_1")).toBe(true);
  });

  it("does NOT flag when a daemon is alive (it will run the schedule)", () => {
    const stale = detectStaleSchedules([sched()], [offlineDaemon, onlineDaemon], NOW, GRACE);
    expect(stale.has("sch_1")).toBe(false);
  });

  it("treats an 'online' daemon with a stale heartbeat as dead (hard-crash case)", () => {
    const stale = detectStaleSchedules([sched()], [staleHeartbeatDaemon], NOW, GRACE);
    expect(stale.has("sch_1")).toBe(true);
  });

  it("does NOT flag a schedule that is merely due-soon (within the grace)", () => {
    const recent = sched({ next_run_at: NOW - 60_000 }); // 1 min late < 5 min grace
    const stale = detectStaleSchedules([recent], [offlineDaemon], NOW, GRACE);
    expect(stale.has("sch_1")).toBe(false);
  });

  it("does NOT flag a disabled or never-scheduled schedule", () => {
    const disabled = sched({ id: "off", enabled: 0 });
    const noNext = sched({ id: "nonext", next_run_at: null });
    const stale = detectStaleSchedules([disabled, noNext], [offlineDaemon], NOW, GRACE);
    expect(stale.size).toBe(0);
  });

  it("returns an empty set when the workspace has no daemons but nothing overdue", () => {
    const future = sched({ next_run_at: NOW + 60_000 });
    const stale = detectStaleSchedules([future], [], NOW, GRACE);
    expect(stale.size).toBe(0);
  });
});
