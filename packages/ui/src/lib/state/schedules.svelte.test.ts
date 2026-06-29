import { beforeEach, describe, expect, it, vi } from "vitest";
import { rateToCron, describeCron } from "../schedule/recurrence.js";

// #619 — SchedulesState wraps the schedule RPCs. We mock the shared `client`
// module so create()/setEnabled()/delete() are verified to call the right RPC
// with the chosen agent+cron+prompt, and the local list patches without a reload.
const createSchedule = vi.fn();
const setScheduleEnabled = vi.fn();
const deleteSchedule = vi.fn();
const listSchedules = vi.fn();

vi.mock("./client.js", () => ({
  client: {
    createSchedule: (...a: unknown[]) => createSchedule(...a),
    setScheduleEnabled: (...a: unknown[]) => setScheduleEnabled(...a),
    deleteSchedule: (...a: unknown[]) => deleteSchedule(...a),
    listSchedules: (...a: unknown[]) => listSchedules(...a),
  },
}));

// Imported after the mock is registered.
const { SchedulesState } = await import("./schedules.svelte.js");

function view(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    workspaceId: "ws1",
    cyboId: "cybo-7",
    cyboName: "Digest Bot",
    channelId: null,
    cron: "0 9 * * *",
    timezone: null,
    prompt: "morning digest",
    enabled: true,
    lastRunAt: null,
    nextRunAt: 2000,
    createdBy: "u1",
    createdAt: 1000,
    ...over,
  };
}

beforeEach(() => {
  createSchedule.mockReset();
  setScheduleEnabled.mockReset();
  deleteSchedule.mockReset();
  listSchedules.mockReset();
});

describe("SchedulesState.create (#619)", () => {
  it("calls createSchedule with the chosen agent, cron and prompt", async () => {
    createSchedule.mockResolvedValue({
      ok: true,
      op: "create",
      scheduleId: "s1",
      schedule: view(),
    });
    const state = new SchedulesState();
    const res = await state.create({
      workspaceId: "ws1",
      cyboIdOrSlug: "cybo-7",
      cron: "0 9 * * *",
      prompt: "morning digest",
    });
    expect(createSchedule).toHaveBeenCalledWith({
      workspaceId: "ws1",
      cyboIdOrSlug: "cybo-7",
      cron: "0 9 * * *",
      prompt: "morning digest",
    });
    expect(res.ok).toBe(true);
    // The new row is patched into the list locally (no reload needed).
    expect(state.list.map((s) => s.id)).toEqual(["s1"]);
  });

  it("does not patch the list when the server rejects the create", async () => {
    createSchedule.mockResolvedValue({
      ok: false,
      op: "create",
      scheduleId: null,
      error: "no cybo",
    });
    const state = new SchedulesState();
    const res = await state.create({
      workspaceId: "ws1",
      cyboIdOrSlug: "ghost",
      cron: "0 9 * * *",
      prompt: "x",
    });
    expect(res.ok).toBe(false);
    expect(state.list).toEqual([]);
  });
});

describe("SchedulesState mutations + broadcast (#619)", () => {
  it("applyMutation(delete) removes the row", () => {
    const state = new SchedulesState();
    state.upsert(view());
    state.applyMutation({ ok: true, op: "delete", scheduleId: "s1" });
    expect(state.list).toEqual([]);
  });

  it("applyMutation(set_enabled) upserts the updated row", () => {
    const state = new SchedulesState();
    state.upsert(view({ enabled: true }));
    state.applyMutation({
      ok: true,
      op: "set_enabled",
      scheduleId: "s1",
      schedule: view({ enabled: false }),
    });
    expect(state.list[0]?.enabled).toBe(false);
  });

  it("setEnabled calls the RPC and applies the result", async () => {
    setScheduleEnabled.mockResolvedValue({
      ok: true,
      op: "set_enabled",
      scheduleId: "s1",
      schedule: view({ enabled: false }),
    });
    const state = new SchedulesState();
    state.upsert(view({ enabled: true }));
    await state.setEnabled("ws1", "s1", false);
    expect(setScheduleEnabled).toHaveBeenCalledWith("ws1", "s1", false);
    expect(state.list[0]?.enabled).toBe(false);
  });

  it("sorts by soonest next run, disabled rows last", () => {
    const state = new SchedulesState();
    state.upsert(view({ id: "a", nextRunAt: 5000 }));
    state.upsert(view({ id: "b", nextRunAt: 1000 }));
    state.upsert(view({ id: "c", nextRunAt: null }));
    expect(state.list.map((s) => s.id)).toEqual(["b", "a", "c"]);
  });
});

describe("rateToCron / describeCron (#619)", () => {
  it("translates rate(N unit) to cron", () => {
    expect(rateToCron(1, "hour")).toBe("0 * * * *");
    expect(rateToCron(3, "hour")).toBe("0 */3 * * *");
    expect(rateToCron(1, "day")).toBe("0 9 * * *");
    expect(rateToCron(2, "day")).toBe("0 9 */2 * *");
    expect(rateToCron(1, "week")).toBe("0 9 * * 1");
  });

  it("coerces a non-positive N to 1", () => {
    expect(rateToCron(0, "hour")).toBe("0 * * * *");
    expect(rateToCron(-5, "day")).toBe("0 9 * * *");
  });

  it("describes known cron shapes, echoes unknown ones", () => {
    expect(describeCron("0 9 * * *")).toBe("Daily at 09:00");
    expect(describeCron("0 */3 * * *")).toBe("Every 3 hours");
    expect(describeCron("15 7 3 2 *")).toBe("15 7 3 2 *");
  });
});
