import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { DualStorage } from "./dual-storage.js";
import { CyborgStorage } from "./storage.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { Logger } from "pino";
import type { StoredSchedule } from "./storage.js";

// spawnCybo is imported by schedule-runner; mock the module so no real agent runs.
const { spawnCyboMock } = vi.hoisted(() => ({ spawnCyboMock: vi.fn() }));
vi.mock("./cybo-manager.js", () => ({ spawnCybo: spawnCyboMock }));

// dispatchTaskToAgent is the per-task fire path. We wrap (not replace) the real
// module so the due-task dispatch tests keep exercising the real implementation,
// while the per-task fire() routing test can assert the runner reached it.
const { dispatchTaskSpy } = vi.hoisted(() => ({ dispatchTaskSpy: vi.fn() }));
vi.mock("./task-dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./task-dispatch.js")>();
  return {
    ...actual,
    dispatchTaskToAgent: (...args: Parameters<typeof actual.dispatchTaskToAgent>) => {
      dispatchTaskSpy(...args);
      return actual.dispatchTaskToAgent(...args);
    },
  };
});

import { ScheduleRunner } from "./schedule-runner.js";

function makeSchedule(over: Partial<StoredSchedule> = {}): StoredSchedule {
  return {
    id: "sch_1",
    workspace_id: "ws_1",
    cybo_id: "cybo_1",
    cron_expr: "0 9 * * *", // valid → computeNextRunAt won't throw
    prompt: "summarize the channel",
    created_by: "user_1",
    channel_id: null,
    timezone: null,
    next_run_at: 0,
    enabled: 1,
    // Phase 2 (#619) lifecycle defaults: recurring, never run, catch-up on.
    max_runs: null,
    run_count: 0,
    catch_up: 1,
    created_at: 0,
    updated_at: 0,
    ...over,
  } as StoredSchedule;
}

interface Harness {
  runner: ScheduleRunner;
  storage: {
    getDueSchedules: ReturnType<typeof vi.fn>;
    getSchedule: ReturnType<typeof vi.fn>;
    getChannel: ReturnType<typeof vi.fn>;
    getMembership: ReturnType<typeof vi.fn>;
    getUserById: ReturnType<typeof vi.fn>;
    setScheduleEnabled: ReturnType<typeof vi.fn>;
    markScheduleRun: ReturnType<typeof vi.fn>;
    startScheduleRun: ReturnType<typeof vi.fn>;
    finishScheduleRun: ReturnType<typeof vi.fn>;
    recordSkippedScheduleRun: ReturnType<typeof vi.fn>;
    getLiveCyboBinding: ReturnType<typeof vi.fn>;
    claimScheduleDispatch: ReturnType<typeof vi.fn>;
    pg: unknown;
  };
  runAgent: ReturnType<typeof vi.fn>;
  getAgent: ReturnType<typeof vi.fn>;
}

let runRowSeq = 0;

function makeRunner(
  opts: {
    schedule?: StoredSchedule;
    member?: boolean;
    pg?: unknown;
    runAgent?: ReturnType<typeof vi.fn>;
    // Item 3: override agentManager.getAgent (reuse probe) + the storage live-binding
    // lookup to exercise the session-singleton reuse path.
    getAgent?: ReturnType<typeof vi.fn>;
    liveBinding?: { agent_id: string } | undefined;
  } = {},
): Harness {
  const schedule = opts.schedule ?? makeSchedule();
  const member = opts.member ?? true;
  const storage = {
    getDueSchedules: vi.fn(() => [schedule]),
    getSchedule: vi.fn(() => schedule),
    getChannel: vi.fn(() => undefined),
    getMembership: vi.fn(() =>
      member ? { workspace_id: schedule.workspace_id, user_id: schedule.created_by } : undefined,
    ),
    setScheduleEnabled: vi.fn(),
    markScheduleRun: vi.fn(),
    // Run-history writes (#619). startScheduleRun returns a fresh row id the
    // runner threads back into finishScheduleRun.
    startScheduleRun: vi.fn(() => `schrun_${++runRowSeq}`),
    finishScheduleRun: vi.fn(),
    recordSkippedScheduleRun: vi.fn(),
    // Tasks Phase 3: the tick's due-task pass reads these. Default to no due tasks
    // so the existing schedule-only tests are unaffected.
    getDueTasks: vi.fn(() => [] as unknown[]),
    getCybo: vi.fn(() => undefined),
    claimTaskDispatch: vi.fn(() => true),
    // Per-task fire path: fireTask resolves the bound task before dispatching.
    getTaskById: vi.fn(() => undefined),
    // Cross-daemon exactly-once claim for the raw-prompt path (#cron-dup). Default
    // to WON so the existing single-daemon tests fire exactly as before.
    claimScheduleDispatch: vi.fn(async () => true),
    // Item 3 (session singleton): default to NO live binding so existing tests keep
    // taking the spawn path (undefined ⇒ runner spawns fresh, unchanged behavior).
    getLiveCyboBinding: vi.fn(() => opts.liveBinding ?? (undefined as unknown)),
    // Id-space bridge: created_by is a daemon-LOCAL id; the runner resolves its
    // email to look up the CLOUD account id (connected mode). Default: unknown
    // local id (no email) so solo/aligned tests don't bridge.
    getUserById: vi.fn(() => undefined as { id: string; email: string } | undefined),
    pg: opts.pg ?? null,
  };
  const runAgent = opts.runAgent ?? vi.fn(() => Promise.resolve({}));
  // Item 3: getAgent default returns null (agent not loaded) ⇒ reuse never triggers,
  // so existing tests keep spawning fresh. The reuse test overrides both.
  const getAgent = opts.getAgent ?? vi.fn(() => null);
  const agentManager = { runAgent, getAgent };
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const runner = new ScheduleRunner({
    storage: storage as unknown as DualStorage,
    agentManager: agentManager as unknown as AgentManager,
    logger: logger as unknown as Logger,
    serverId: "daemon_1",
  });
  return { runner, storage, runAgent, getAgent };
}

// Drain microtasks so the fire-and-forget fire() promise (spawn + runAgent +
// finishScheduleRun) settles before we assert on the run-history writes.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ScheduleRunner authorization + overlap guard (#209)", () => {
  beforeEach(() => {
    spawnCyboMock.mockReset();
    spawnCyboMock.mockResolvedValue({ agentId: "ag_1", cyboId: "cybo_1", cyboSlug: "c" });
  });

  it("fires a due schedule when the creator is still a member (no PG / solo)", async () => {
    const h = makeRunner();
    await h.runner.tick();
    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
    expect(h.storage.markScheduleRun).toHaveBeenCalledTimes(1);
    expect(h.storage.setScheduleEnabled).not.toHaveBeenCalled();
  });

  it("disables the schedule and does NOT spawn when the creator is no longer a member", async () => {
    const h = makeRunner({ member: false });
    await h.runner.tick();
    expect(spawnCyboMock).not.toHaveBeenCalled();
    expect(h.storage.setScheduleEnabled).toHaveBeenCalledWith("sch_1", false);
  });

  it("disables the schedule when PG says daemon access was revoked", async () => {
    const pg = {
      canUserAccessDaemon: vi.fn(() => Promise.resolve(false)),
      getLicenseStatus: vi.fn(() => Promise.resolve({ state: "active" })),
    };
    const h = makeRunner({ pg });
    await h.runner.tick();
    expect(pg.canUserAccessDaemon).toHaveBeenCalledWith("ws_1", "daemon_1", "user_1");
    expect(spawnCyboMock).not.toHaveBeenCalled();
    expect(h.storage.setScheduleEnabled).toHaveBeenCalledWith("sch_1", false);
  });

  it("connected mode: a shared-cybo schedule whose created_by is a LOCAL id (distinct from the cloud id) still FIRES, not disabled", async () => {
    // Reproduces the cloud regression: a shared cybo owned by Y, asked by member X
    // to schedule, stamps created_by = X's daemon-LOCAL SQLite id ("user_local_x").
    // In connected mode membership AND daemon_access are keyed by X's CLOUD account
    // id ("user_cloud_x") — a DIFFERENT value for the same person. Without the
    // email bridge, getMembership(local)/canUserAccessDaemon(local) both miss and
    // the schedule is silently disabled on first fire. With the bridge it fires.
    const localId = "user_local_x";
    const cloudId = "user_cloud_x";
    const schedule = makeSchedule({ created_by: localId });
    const pg = {
      // PG keys daemon_access by the cloud id ONLY — the local id is unknown to it.
      canUserAccessDaemon: vi.fn((_ws: string, _daemon: string, userId: string) =>
        Promise.resolve(userId === cloudId),
      ),
      // The email bridge: local id → email → cloud account id.
      getUserByEmail: vi.fn((email: string) =>
        Promise.resolve(email === "x@example.com" ? { id: cloudId, email } : null),
      ),
      getLicenseStatus: vi.fn(() => Promise.resolve({ state: "active" })),
    };
    const h = makeRunner({ schedule, pg });
    // SQLite membership is keyed by the CLOUD id (dual-storage.addMember(pgId)) —
    // the LOCAL id is NOT a member row.
    h.storage.getMembership.mockImplementation((_ws: string, userId: string) =>
      userId === cloudId ? { workspace_id: "ws_1", user_id: cloudId } : undefined,
    );
    // The local user row resolves to X's email so the runner can bridge.
    h.storage.getUserById.mockImplementation((id: string) =>
      id === localId ? { id: localId, email: "x@example.com" } : undefined,
    );

    await h.runner.tick();

    // Bridged to the cloud id for the PG access check…
    expect(pg.getUserByEmail).toHaveBeenCalledWith("x@example.com");
    expect(pg.canUserAccessDaemon).toHaveBeenCalledWith("ws_1", "daemon_1", cloudId);
    // …so the schedule is authorized: it FIRES and is NOT disabled.
    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
    expect(h.storage.setScheduleEnabled).not.toHaveBeenCalled();
    expect(h.storage.recordSkippedScheduleRun).not.toHaveBeenCalledWith(
      expect.objectContaining({ skipReason: "unauthorized" }),
    );
  });

  it("skips the run (no spawn) but advances when the workspace license is paused", async () => {
    const pg = {
      canUserAccessDaemon: vi.fn(() => Promise.resolve(true)),
      getLicenseStatus: vi.fn(() => Promise.resolve({ state: "paused" })),
    };
    const h = makeRunner({ pg });
    await h.runner.tick();
    expect(spawnCyboMock).not.toHaveBeenCalled();
    // advanced past the paused tick, but NOT disabled (billing may resume)
    expect(h.storage.markScheduleRun).toHaveBeenCalledTimes(1);
    expect(h.storage.setScheduleEnabled).not.toHaveBeenCalled();
  });

  it("overlap guard: a second tick is skipped while the previous run is still in flight", async () => {
    // runAgent never resolves → the run stays in flight across ticks.
    const hangingRun = vi.fn(() => new Promise<object>(() => {}));
    const h = makeRunner({ runAgent: hangingRun });
    await h.runner.tick(); // starts the (hanging) run
    await h.runner.tick(); // must be skipped by the in-flight guard
    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
  });
});

describe("ScheduleRunner.runOnce (Run now)", () => {
  beforeEach(() => {
    spawnCyboMock.mockReset();
    spawnCyboMock.mockResolvedValue({ agentId: "ag_1", cyboId: "cybo_1", cyboSlug: "c" });
  });

  it("fires immediately WITHOUT advancing the cadence (markScheduleRun untouched)", async () => {
    const h = makeRunner();
    const reason = await h.runner.runOnce("sch_1");
    expect(reason).toBeNull();
    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
    // Run-now must not touch next_run_at — the regular cron run still happens.
    expect(h.storage.markScheduleRun).not.toHaveBeenCalled();
  });

  it("returns a reason and does not fire when the schedule is missing", async () => {
    const h = makeRunner();
    h.storage.getSchedule.mockReturnValueOnce(undefined);
    const reason = await h.runner.runOnce("nope");
    expect(reason).toBe("Schedule not found");
    expect(spawnCyboMock).not.toHaveBeenCalled();
  });

  it("refuses to fire when the creator lost membership", async () => {
    const h = makeRunner({ member: false });
    const reason = await h.runner.runOnce("sch_1");
    expect(reason).toMatch(/no longer has access/i);
    expect(spawnCyboMock).not.toHaveBeenCalled();
  });

  it("refuses to fire when the workspace license is paused", async () => {
    const pg = {
      canUserAccessDaemon: vi.fn(() => Promise.resolve(true)),
      getLicenseStatus: vi.fn(() => Promise.resolve({ state: "paused" })),
    };
    const h = makeRunner({ pg });
    const reason = await h.runner.runOnce("sch_1");
    expect(reason).toMatch(/paused/i);
    expect(spawnCyboMock).not.toHaveBeenCalled();
  });

  it("won't double-fire a schedule already running (overlap guard)", async () => {
    const hangingRun = vi.fn(() => new Promise<object>(() => {}));
    const h = makeRunner({ runAgent: hangingRun });
    const first = await h.runner.runOnce("sch_1"); // starts a hanging run
    expect(first).toBeNull();
    const second = await h.runner.runOnce("sch_1"); // in flight → refused
    expect(second).toMatch(/already running/i);
    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
  });
});

// ─── Phase 2 (#619): schedule_runs recorded on fire/skip ─────────────
describe("ScheduleRunner run history (#619)", () => {
  beforeEach(() => {
    spawnCyboMock.mockReset();
    spawnCyboMock.mockResolvedValue({ agentId: "ag_1", cyboId: "cybo_1", cyboSlug: "c" });
  });

  it("a successful fire records a 'succeeded' run with the spawned agent id", async () => {
    const h = makeRunner();
    await h.runner.tick();
    await flush();
    expect(h.storage.startScheduleRun).toHaveBeenCalledTimes(1);
    expect(h.storage.startScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: "sch_1", workspaceId: "ws_1" }),
    );
    expect(h.storage.finishScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded", agentId: "ag_1" }),
    );
  });

  it("a failed run (spawn throws) records 'failed' with the error, never dropped", async () => {
    const h = makeRunner();
    spawnCyboMock.mockRejectedValueOnce(new Error("provider exploded"));
    await h.runner.tick();
    await flush();
    expect(h.storage.finishScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", error: "provider exploded" }),
    );
  });

  it("the overlap skip records a 'skipped'/overlap run (no spawn)", async () => {
    const hangingRun = vi.fn(() => new Promise<object>(() => {}));
    const h = makeRunner({ runAgent: hangingRun });
    await h.runner.tick(); // starts the (hanging) run
    await h.runner.tick(); // overlap → skipped
    expect(h.storage.recordSkippedScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: "sch_1", skipReason: "overlap" }),
    );
  });

  it("the unauthorized skip records a 'skipped'/unauthorized run, then disables", async () => {
    const h = makeRunner({ member: false });
    await h.runner.tick();
    expect(h.storage.recordSkippedScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: "sch_1", skipReason: "unauthorized" }),
    );
    expect(h.storage.setScheduleEnabled).toHaveBeenCalledWith("sch_1", false);
    expect(spawnCyboMock).not.toHaveBeenCalled();
  });

  it("the license-paused skip records a 'skipped'/license_paused run (no run_count bump)", async () => {
    const pg = {
      canUserAccessDaemon: vi.fn(() => Promise.resolve(true)),
      getLicenseStatus: vi.fn(() => Promise.resolve({ state: "paused" })),
    };
    const h = makeRunner({ pg });
    await h.runner.tick();
    expect(h.storage.recordSkippedScheduleRun).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: "sch_1", skipReason: "license_paused" }),
    );
    // advanced past the slot, but run_count NOT incremented (4th arg falsy/absent)
    const args = h.storage.markScheduleRun.mock.calls[0];
    expect(args[3]).toBeFalsy();
    expect(spawnCyboMock).not.toHaveBeenCalled();
  });
});

// ─── Phase 2 (#619): one-shots (maxRuns=1) ──────────────────────────
describe("ScheduleRunner one-shots (#619)", () => {
  beforeEach(() => {
    spawnCyboMock.mockReset();
    spawnCyboMock.mockResolvedValue({ agentId: "ag_1", cyboId: "cybo_1", cyboSlug: "c" });
  });

  it("a one-shot fires once and DEACTIVATES (next_run_at cleared, enabled=false)", async () => {
    const h = makeRunner({ schedule: makeSchedule({ max_runs: 1, run_count: 0 }) });
    await h.runner.tick();
    await flush();
    // It fired…
    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
    // …bumped run_count (4th arg truthy)…
    expect(h.storage.markScheduleRun).toHaveBeenCalledWith("sch_1", expect.any(Number), null, true);
    // …and disabled itself with next_run_at = null so a later tick won't re-fire.
    expect(h.storage.setScheduleEnabled).toHaveBeenCalledWith("sch_1", false, null);
  });

  it("a recurring schedule (maxRuns=null) advances next_run_at and stays enabled", async () => {
    const h = makeRunner(); // max_runs null by default
    await h.runner.tick();
    await flush();
    // Advances to a real future slot (not null) and never disables.
    const [, , next, inc] = h.storage.markScheduleRun.mock.calls[0];
    expect(next).toBeGreaterThan(0);
    expect(inc).toBe(true);
    expect(h.storage.setScheduleEnabled).not.toHaveBeenCalled();
  });

  it("a multi-run cap (maxRuns=3) only completes on the final run", async () => {
    // run_count already 1 → this is the 2nd of 3, so it must NOT deactivate yet.
    const h = makeRunner({ schedule: makeSchedule({ max_runs: 3, run_count: 1 }) });
    await h.runner.tick();
    await flush();
    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
    expect(h.storage.setScheduleEnabled).not.toHaveBeenCalled();
    const [, , next, inc] = h.storage.markScheduleRun.mock.calls[0];
    expect(next).toBeGreaterThan(0); // advances normally
    expect(inc).toBe(true);
  });
});

// ─── Phase 2 (#619): catch_up policy ────────────────────────────────
describe("ScheduleRunner catch_up policy (#619)", () => {
  beforeEach(() => {
    spawnCyboMock.mockReset();
    spawnCyboMock.mockResolvedValue({ agentId: "ag_1", cyboId: "cybo_1", cyboSlug: "c" });
  });

  // A schedule overdue by many cadence periods (next_run_at far in the past).
  const longStale = () =>
    makeSchedule({
      cron_expr: "*/5 * * * *", // every 5 min
      next_run_at: Date.now() - 60 * 60_000, // ~1h late = 12 missed periods
    });

  it("catch_up=false + >1 period late skips to the next future slot WITHOUT firing", async () => {
    const sched = { ...longStale(), catch_up: 0 };
    const h = makeRunner({ schedule: sched });
    h.storage.getDueSchedules.mockReturnValue([sched]);
    await h.runner.tick();
    await flush();
    expect(spawnCyboMock).not.toHaveBeenCalled();
    // It advanced to a FUTURE slot (no run row opened) and did not record a skip.
    const [, , next] = h.storage.markScheduleRun.mock.calls[0];
    expect(next).toBeGreaterThan(Date.now());
    expect(h.storage.startScheduleRun).not.toHaveBeenCalled();
  });

  it("catch_up=true + >1 period late still fires the single catch-up run", async () => {
    const sched = { ...longStale(), catch_up: 1 };
    const h = makeRunner({ schedule: sched });
    h.storage.getDueSchedules.mockReturnValue([sched]);
    await h.runner.tick();
    await flush();
    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
    expect(h.storage.startScheduleRun).toHaveBeenCalledTimes(1);
  });
});

// ─── Tasks Phase 3: due-task dispatch on the same tick (internal docs) ──
describe("ScheduleRunner due-task dispatch", () => {
  beforeEach(() => {
    spawnCyboMock.mockReset();
    spawnCyboMock.mockResolvedValue({ agentId: "ag_task", cyboId: "cybo_1", cyboSlug: "c" });
  });

  function dueTask() {
    return {
      id: "task_due_1",
      workspace_id: "ws_1",
      title: "due task",
      description: null,
      status: "pending",
      assignee_id: "cybo_1",
      created_by: "user_1",
      due_at: Date.now() - 1000,
      recurrence: null,
      result: null,
      channel_id: null,
      priority: null,
      last_dispatched_at: null,
      recurrence_spawned_at: null,
      recurrence_count: 0,
      created_at: 0,
      updated_at: 0,
    };
  }

  it("dispatches a due agent-assigned task after the cron pass (one spawn)", async () => {
    const h = makeRunner();
    // No cron schedules; one due task assigned to a cybo.
    h.storage.getDueSchedules.mockReturnValue([]);
    h.storage.getDueTasks.mockReturnValue([dueTask()]);
    h.storage.getCybo.mockReturnValue({ id: "cybo_1", slug: "c", name: "C" });

    await h.runner.tick();
    await flush();

    expect(h.storage.claimTaskDispatch).toHaveBeenCalledWith("task_due_1", 30_000);
    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
    expect(h.runAgent).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when the claim is lost (another path already fired it)", async () => {
    const h = makeRunner();
    h.storage.getDueSchedules.mockReturnValue([]);
    h.storage.getDueTasks.mockReturnValue([dueTask()]);
    h.storage.getCybo.mockReturnValue({ id: "cybo_1", slug: "c", name: "C" });
    h.storage.claimTaskDispatch.mockReturnValue(false); // claim held by the immediate path

    await h.runner.tick();
    await flush();

    expect(spawnCyboMock).not.toHaveBeenCalled();
  });

  it("skips a due task assigned to a non-cybo (human assignee)", async () => {
    const h = makeRunner();
    h.storage.getDueSchedules.mockReturnValue([]);
    h.storage.getDueTasks.mockReturnValue([{ ...dueTask(), assignee_id: "human_1" }]);
    h.storage.getCybo.mockReturnValue(undefined); // not a cybo

    await h.runner.tick();
    await flush();

    expect(spawnCyboMock).not.toHaveBeenCalled();
    expect(h.storage.claimTaskDispatch).not.toHaveBeenCalled();
  });
});

// ─── Per-task scheduling: fire() routes on task_id (the DEFECT-1 guard) ──────
// A schedule WITH a bound task_id must take the fireTask → dispatchTaskToAgent
// path; a raw-prompt schedule (task_id null OR undefined) must take the original
// spawnCybo path. The guard is `task_id != null` so an undefined fixture value
// (no bound task) is NOT mis-routed to fireTask.
describe("ScheduleRunner fire() per-task routing", () => {
  beforeEach(() => {
    spawnCyboMock.mockReset();
    spawnCyboMock.mockResolvedValue({ agentId: "ag_1", cyboId: "cybo_1", cyboSlug: "c" });
    dispatchTaskSpy.mockReset();
  });

  function boundTask() {
    return {
      id: "task_bound_1",
      workspace_id: "ws_1",
      title: "bound task",
      description: null,
      status: "pending",
      assignee_id: "cybo_1",
      created_by: "user_1",
      due_at: null,
      recurrence: null,
      result: null,
      channel_id: null,
      priority: null,
      last_dispatched_at: null,
      recurrence_spawned_at: null,
      recurrence_count: 0,
      created_at: 0,
      updated_at: 0,
    };
  }

  it("a schedule WITH task_id routes fire() → fireTask → dispatchTaskToAgent (no raw spawn)", async () => {
    // Bound to a real task whose assignee is a cybo on this daemon.
    const sched = makeSchedule({ task_id: "task_bound_1", prompt: "bound" });
    const h = makeRunner({ schedule: sched });
    h.storage.getTaskById.mockReturnValue(boundTask());
    h.storage.getCybo.mockReturnValue({ id: "cybo_1", slug: "c", name: "C" });

    await h.runner.tick();
    await flush();

    // Routed to the per-task path: dispatchTaskToAgent was reached with the task.
    expect(dispatchTaskSpy).toHaveBeenCalledTimes(1);
    expect(dispatchTaskSpy).toHaveBeenCalledWith(
      expect.objectContaining({ task: expect.objectContaining({ id: "task_bound_1" }) }),
    );
    // The raw-prompt branch's direct spawnCybo("schedule.cybo_id" + schedule.prompt)
    // must NOT fire for a per-task schedule — the per-task path runs the task's
    // assignee via dispatch, not the schedule's raw prompt.
    expect(h.storage.getTaskById).toHaveBeenCalledWith("task_bound_1");
  });

  it("a raw-prompt schedule (task_id undefined) still routes fire() → spawnCybo", async () => {
    // The unit fixture leaves task_id undefined; the loose guard must treat it as
    // "no bound task" and take the spawnCybo path, NOT fireTask.
    const h = makeRunner(); // makeSchedule() leaves task_id undefined
    await h.runner.tick();
    await flush();

    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
    expect(dispatchTaskSpy).not.toHaveBeenCalled();
    expect(h.storage.getTaskById).not.toHaveBeenCalled();
  });

  it("a raw-prompt schedule (task_id null) still routes fire() → spawnCybo", async () => {
    const h = makeRunner({ schedule: makeSchedule({ task_id: null }) });
    await h.runner.tick();
    await flush();

    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
    expect(dispatchTaskSpy).not.toHaveBeenCalled();
    expect(h.storage.getTaskById).not.toHaveBeenCalled();
  });
});

// Item 3 (session singleton): a per-(cybo, channel) cron fire must reuse ONE live
// session instead of spawning a fresh visible "Rick" on every tick.
describe("ScheduleRunner session singleton (#cron pile-up)", () => {
  beforeEach(() => {
    spawnCyboMock.mockReset();
    spawnCyboMock.mockResolvedValue({ agentId: "ag_new", cyboId: "cybo_1", cyboSlug: "c" });
  });

  it("reuses a LIVE (cybo, channel) binding — no new spawn, routes to the same agent", async () => {
    // A live channel-bound session already exists for this cybo, and its agent is
    // loaded in this process — the reuse probe must pick it up.
    const liveAgentId = "ag_live";
    const getAgent = vi.fn((id: string) => (id === liveAgentId ? ({ id } as unknown) : null));
    const h = makeRunner({
      schedule: makeSchedule({ channel_id: "chan_1" }),
      liveBinding: { agent_id: liveAgentId },
      getAgent,
    });

    await h.runner.tick();
    await flush();

    // No fresh spawn — the existing session was reused.
    expect(spawnCyboMock).not.toHaveBeenCalled();
    // The reuse probe queried the (cybo, channel) scope and ran the SAME agent.
    expect(h.storage.getLiveCyboBinding).toHaveBeenCalledWith("ws_1", "cybo_1", "chan_1");
    expect(h.runAgent).toHaveBeenCalledTimes(1);
    expect(h.runAgent.mock.calls[0][0]).toBe(liveAgentId);
  });

  it("two consecutive fires for the same (cybo, channel) reuse ONE binding", async () => {
    const liveAgentId = "ag_live";
    const getAgent = vi.fn((id: string) => (id === liveAgentId ? ({ id } as unknown) : null));
    const h = makeRunner({
      schedule: makeSchedule({ channel_id: "chan_1" }),
      liveBinding: { agent_id: liveAgentId },
      getAgent,
    });

    await h.runner.tick();
    await flush();
    await h.runner.tick();
    await flush();

    // Both fires reused the live session — zero spawns, two runs on the same agent.
    expect(spawnCyboMock).not.toHaveBeenCalled();
    expect(h.runAgent).toHaveBeenCalledTimes(2);
    expect(h.runAgent.mock.calls[0][0]).toBe(liveAgentId);
    expect(h.runAgent.mock.calls[1][0]).toBe(liveAgentId);
  });

  it("spawns fresh when the live binding's agent is NOT loaded (torn down / first run)", async () => {
    // A binding row exists but its agent is gone (getAgent → null): prefer a clean
    // fresh spawn over reviving a cold session.
    const h = makeRunner({
      schedule: makeSchedule({ channel_id: "chan_1" }),
      liveBinding: { agent_id: "ag_stale" },
      getAgent: vi.fn(() => null),
    });

    await h.runner.tick();
    await flush();

    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
    expect(h.runAgent).toHaveBeenCalledTimes(1);
    expect(h.runAgent.mock.calls[0][0]).toBe("ag_new");
  });

  it("getLiveCyboBinding(channelId=null) selects the DM-scoped binding", () => {
    // The reuse keying must distinguish a DM-scoped binding (channel_id IS NULL) from
    // a channel-bound one — proven at the storage layer so a DM never reuses a
    // channel-bound session (whose prompt carries "Current channel" → leak risk).
    const tmp = mkdtempSync(path.join(tmpdir(), "sched-singleton-"));
    const sqlite = new CyborgStorage(path.join(tmp, "t.db"));
    const storage = new DualStorage(sqlite, null);
    try {
      const user = storage.upsertUser("z@test.dev", "Z");
      const ws = storage.createWorkspace("WS", user.id).id;
      const chan = storage.getChannels(ws).find((c) => c.name === "general")!.id;
      // Two NON-ephemeral bindings for the SAME cybo: one channel-bound, one DM-scoped.
      storage.createAgentBinding({
        agentId: "ag_chan",
        workspaceId: ws,
        channelId: chan,
        provider: "pi",
        cyboId: "cybo_z",
      });
      storage.createAgentBinding({
        agentId: "ag_dm",
        workspaceId: ws,
        channelId: null,
        provider: "pi",
        cyboId: "cybo_z",
      });

      expect(storage.getLiveCyboBinding(ws, "cybo_z", chan)?.agent_id).toBe("ag_chan");
      expect(storage.getLiveCyboBinding(ws, "cybo_z", null)?.agent_id).toBe("ag_dm");
    } finally {
      storage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── Cross-daemon exactly-once for the RAW-PROMPT path (#cron-dup) ───────────
// The bug: the raw-prompt cron path (schedule.task_id == null) had NO cross-daemon
// guard — only the in-PROCESS inFlight Set + a LOCAL next_run_at advance. So the
// SAME due schedule present on two daemons fired on BOTH → duplicate channel posts +
// duplicate visible cybo sessions ("varios Ricks"). The fix is an atomic per-(schedule,
// fired-slot) claim mirroring claimTaskDispatch. This test models two replicas as two
// ScheduleRunner instances sharing ONE real store (no mocks for the claim) and proves
// a single due schedule is spawned/prompted EXACTLY ONCE across both ticks.
describe("ScheduleRunner raw-prompt cross-daemon exactly-once (#cron-dup)", () => {
  beforeEach(() => {
    spawnCyboMock.mockReset();
    spawnCyboMock.mockResolvedValue({ agentId: "ag_once", cyboId: "cybo_1", cyboSlug: "c" });
  });

  it("two replicas sharing ONE store fire a due raw-prompt schedule EXACTLY once", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "sched-exactly-once-"));
    const sqlite = new CyborgStorage(path.join(tmp, "t.db"));
    // Solo mode (pg = null): one shared SQLite IS the shared store, so the SQLite
    // claim is the cross-replica serializer — exactly what two daemons sharing PG get.
    const storage = new DualStorage(sqlite, null);
    try {
      const user = storage.upsertUser("rick@test.dev", "Rick");
      const ws = storage.createWorkspace("WS", user.id).id; // owner auto-membered
      // A due raw-prompt schedule (task_id null): next_run_at in the past, enabled.
      const schedule = sqlite.createSchedule({
        workspaceId: ws,
        cyboId: "cybo_1",
        cronExpr: "0 9 * * *", // valid → computeNextRunAt won't throw
        prompt: "DM Seb the morning market brief",
        createdBy: user.id,
        nextRunAt: Date.now() - 60_000,
      });

      // ONE agentManager shared by both runners, so runAgent is counted across both
      // replicas regardless of which one wins the claim.
      const runAgent = vi.fn(() => Promise.resolve({}));
      const agentManager = {
        runAgent,
        getAgent: vi.fn(() => null), // no live binding → spawn path
      } as unknown as AgentManager;
      const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;

      const runnerA = new ScheduleRunner({ storage, agentManager, logger, serverId: "daemon_A" });
      const runnerB = new ScheduleRunner({ storage, agentManager, logger, serverId: "daemon_B" });

      // Tick BOTH concurrently: each reads the due schedule (same slot) before either
      // advances next_run_at, so both reach the claim for the SAME (schedule, slot) —
      // exactly the cross-daemon race. The atomic claim must let only ONE through.
      await Promise.all([runnerA.tick(), runnerB.tick()]);
      await flush();

      // The cybo was spawned + prompted EXACTLY ONCE, not once per replica.
      expect(spawnCyboMock).toHaveBeenCalledTimes(1);
      expect(runAgent).toHaveBeenCalledTimes(1);

      // The loser recorded a clean 'duplicate' skip — visible, never a second post.
      const runs = storage.listScheduleRuns(schedule.id);
      const duplicates = runs.filter((r) => r.skip_reason === "duplicate");
      expect(duplicates).toHaveLength(1);
      // Exactly one non-skip (the winner's) run row was opened.
      const fired = runs.filter((r) => r.skip_reason === null);
      expect(fired).toHaveLength(1);
    } finally {
      storage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a second slot (later tick) can be claimed again — the claim is per-slot, not per-schedule", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "sched-exactly-once-2-"));
    const sqlite = new CyborgStorage(path.join(tmp, "t.db"));
    const storage = new DualStorage(sqlite, null);
    try {
      const user = storage.upsertUser("rick2@test.dev", "Rick");
      const ws = storage.createWorkspace("WS", user.id).id;
      const schedule = sqlite.createSchedule({
        workspaceId: ws,
        cyboId: "cybo_1",
        cronExpr: "* * * * *", // every minute → next slot is also soon due
        prompt: "heartbeat",
        createdBy: user.id,
        nextRunAt: Date.now() - 60_000,
      });

      const runAgent = vi.fn(() => Promise.resolve({}));
      const agentManager = {
        runAgent,
        getAgent: vi.fn(() => null),
      } as unknown as AgentManager;
      const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;
      const runner = new ScheduleRunner({ storage, agentManager, logger, serverId: "daemon_A" });

      // First slot fires once.
      await runner.tick();
      await flush();
      expect(spawnCyboMock).toHaveBeenCalledTimes(1);

      // Force the schedule due again on a NEW slot, then tick: the per-slot claim must
      // NOT block this distinct slot (a per-schedule claim would have wedged it).
      sqlite.markScheduleRun(schedule.id, Date.now(), Date.now() - 30_000);
      await runner.tick();
      await flush();
      expect(spawnCyboMock).toHaveBeenCalledTimes(2);
    } finally {
      storage.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
