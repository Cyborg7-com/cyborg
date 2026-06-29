import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { CyborgAuth } from "./auth.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MessageRouter, type BroadcastFn } from "./message-router.js";
import { CyborgDispatcher } from "./dispatcher.js";
import type { CyborgAuthContext } from "./auth.js";

// Human CRUD over cybo schedules through the dispatcher (local daemon mode).
// Covers create → list → update → set_enabled (pause/resume) → delete and the
// run_once delegation to the ScheduleRunner. The runner's fire path itself is
// covered in schedule-runner.test.ts; here we mock it to assert the wiring.

interface Emitted {
  type: string;
  payload: Record<string, unknown>;
}

describe("Schedule RPCs (dispatcher, local mode)", () => {
  let storage: DualStorage;
  let auth: CyborgAuth;
  let workspaceManager: WorkspaceManager;
  let dispatcher: CyborgDispatcher;
  let tmpDir: string;
  let owner: CyborgAuthContext;
  let workspaceId: string;
  let cyboId: string;
  const runOnceCalls: string[] = [];

  async function dispatch(msg: Record<string, unknown>, who = owner): Promise<Emitted[]> {
    const out: Emitted[] = [];
    await dispatcher.dispatch(msg as never, who, (m) => out.push(m as Emitted));
    return out;
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-sched-"));
    storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "test.db")), null);
    auth = new CyborgAuth(storage);
    workspaceManager = new WorkspaceManager(storage);
    const broadcast: BroadcastFn = { toWorkspace() {}, toUser() {} };
    const messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
    dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);

    runOnceCalls.length = 0;
    // Minimal ScheduleRunner stand-in: record the id, report success (null).
    dispatcher.setScheduleRunner({
      runOnce: async (id: string) => {
        runOnceCalls.push(id);
        return null;
      },
    } as unknown as Parameters<typeof dispatcher.setScheduleRunner>[0]);

    owner = auth.validateToken(auth.createToken("owner@test.com", "Owner"))!;
    const ws = await dispatch({
      type: "cyborg:create_workspace",
      name: "Sched WS",
      requestId: "w1",
    });
    workspaceId = (ws[0].payload.workspace as { id: string }).id;
    cyboId = storage.createCybo({
      workspaceId,
      slug: "apex",
      name: "Apex",
      soul: "Be sharp.",
      provider: "pi",
      model: "anthropic/claude",
      createdBy: owner.user.id,
    }).id;
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createSchedule(over: Record<string, unknown> = {}): Promise<Emitted> {
    const out = await dispatch({
      type: "cyborg:create_schedule",
      requestId: "c1",
      workspaceId,
      cyboIdOrSlug: cyboId,
      cron: "0 9 * * 1-5",
      prompt: "Summarize #general",
      ...over,
    });
    return out[0];
  }

  it("create → persists with a computed next_run_at and echoes the view", async () => {
    const res = await createSchedule();
    expect(res.type).toBe("cyborg:schedule_mutated");
    expect(res.payload.ok).toBe(true);
    expect(res.payload.op).toBe("create");
    const view = res.payload.schedule as Record<string, unknown>;
    expect(view.cron).toBe("0 9 * * 1-5");
    expect(view.cyboName).toBe("Apex");
    expect(view.enabled).toBe(true);
    expect(typeof view.nextRunAt).toBe("number");
    // Persisted in SQLite (execution truth).
    expect(storage.listSchedules(workspaceId)).toHaveLength(1);
  });

  it("create resolves the cybo by SLUG too (workspace-scoped)", async () => {
    const res = await createSchedule({ cyboIdOrSlug: "apex" });
    expect(res.payload.ok).toBe(true);
    expect((res.payload.schedule as { cyboId: string }).cyboId).toBe(cyboId);
  });

  it("create rejects an invalid cron without persisting", async () => {
    const res = await createSchedule({ cron: "not a cron" });
    expect(res.payload.ok).toBe(false);
    expect(res.payload.error).toMatch(/invalid cron/i);
    expect(storage.listSchedules(workspaceId)).toHaveLength(0);
  });

  it("create rejects an unknown cybo", async () => {
    const res = await createSchedule({ cyboIdOrSlug: "ghost" });
    expect(res.payload.ok).toBe(false);
    expect(res.payload.error).toMatch(/no cybo/i);
  });

  it("list returns the workspace's schedules, filterable by cybo", async () => {
    await createSchedule();
    const listed = await dispatch({
      type: "cyborg:list_schedules",
      requestId: "l1",
      workspaceId,
    });
    expect(listed[0].type).toBe("cyborg:schedule_list_response");
    expect((listed[0].payload.schedules as unknown[]).length).toBe(1);

    const filtered = await dispatch({
      type: "cyborg:list_schedules",
      requestId: "l2",
      workspaceId,
      cyboId: "other",
    });
    expect((filtered[0].payload.schedules as unknown[]).length).toBe(0);
  });

  it("update edits the prompt and recomputes next_run_at on a cron change", async () => {
    const created = await createSchedule();
    const id = (created.payload.schedule as { id: string }).id;
    const before = storage.getSchedule(id)?.next_run_at ?? 0;

    const res = await dispatch({
      type: "cyborg:update_schedule",
      requestId: "u1",
      workspaceId,
      scheduleId: id,
      prompt: "New prompt",
      cron: "30 8 * * *",
    });
    expect(res[0].payload.ok).toBe(true);
    const row = storage.getSchedule(id);
    expect(row?.prompt).toBe("New prompt");
    expect(row?.cron_expr).toBe("30 8 * * *");
    // A cron change recomputes next_run_at (different slot → different value).
    expect(row?.next_run_at).not.toBe(before);
  });

  it("update rejects an invalid cron and leaves the row unchanged", async () => {
    const created = await createSchedule();
    const id = (created.payload.schedule as { id: string }).id;
    const res = await dispatch({
      type: "cyborg:update_schedule",
      requestId: "u2",
      workspaceId,
      scheduleId: id,
      cron: "bogus",
    });
    expect(res[0].payload.ok).toBe(false);
    expect(storage.getSchedule(id)?.cron_expr).toBe("0 9 * * 1-5");
  });

  it("set_enabled pauses (false) and resumes (true), recomputing next on resume", async () => {
    const created = await createSchedule();
    const id = (created.payload.schedule as { id: string }).id;

    const paused = await dispatch({
      type: "cyborg:set_schedule_enabled",
      requestId: "p1",
      workspaceId,
      scheduleId: id,
      enabled: false,
    });
    expect((paused[0].payload.schedule as { enabled: boolean }).enabled).toBe(false);
    expect(storage.getSchedule(id)?.enabled).toBe(0);

    const resumed = await dispatch({
      type: "cyborg:set_schedule_enabled",
      requestId: "p2",
      workspaceId,
      scheduleId: id,
      enabled: true,
    });
    expect((resumed[0].payload.schedule as { enabled: boolean }).enabled).toBe(true);
    expect(storage.getSchedule(id)?.enabled).toBe(1);
  });

  it("delete removes the schedule", async () => {
    const created = await createSchedule();
    const id = (created.payload.schedule as { id: string }).id;
    const res = await dispatch({
      type: "cyborg:delete_schedule",
      requestId: "d1",
      workspaceId,
      scheduleId: id,
    });
    expect(res[0].payload.ok).toBe(true);
    expect(storage.getSchedule(id)).toBeUndefined();
  });

  it("run_once delegates to the runner and acks", async () => {
    const created = await createSchedule();
    const id = (created.payload.schedule as { id: string }).id;
    const res = await dispatch({
      type: "cyborg:run_schedule_once",
      requestId: "r1",
      workspaceId,
      scheduleId: id,
    });
    expect(res[0].payload.ok).toBe(true);
    expect(res[0].payload.op).toBe("run_once");
    expect(runOnceCalls).toEqual([id]);
  });

  it("mutating another workspace's schedule is rejected (not found)", async () => {
    const created = await createSchedule();
    const id = (created.payload.schedule as { id: string }).id;
    const stranger = auth.validateToken(auth.createToken("stranger@test.com", "Stranger"))!;
    const otherWs = await dispatch(
      { type: "cyborg:create_workspace", name: "Other", requestId: "w2" },
      stranger,
    );
    const otherWsId = (otherWs[0].payload.workspace as { id: string }).id;
    const res = await dispatch(
      {
        type: "cyborg:delete_schedule",
        requestId: "d2",
        workspaceId: otherWsId,
        scheduleId: id,
      },
      stranger,
    );
    expect(res[0].payload.ok).toBe(false);
    expect(res[0].payload.error).toMatch(/not found/i);
    // Still present in the real owner's workspace.
    expect(storage.getSchedule(id)).toBeDefined();
  });
});
