import { describe, expect, it } from "vitest";
import { CyborgClient } from "./ws-client.js";

// #619 — verify each of the 7 schedule client wrappers issues the correct RPC
// `type` and forwards the expected params. We override the protected `request`
// (the single transport seam every wrapper funnels through) to capture the call
// without standing up a socket. This proves the wire contract: the UI client and
// the server's dual-routed RPC names/params stay in lockstep.

interface Captured {
  type: string;
  params: Record<string, unknown> | undefined;
}

class TestClient extends CyborgClient {
  calls: Captured[] = [];
  nextResult: unknown = {};
  // Narrow the protected `request` to a capturing stub (the seam every wrapper
  // funnels through), so no socket is needed to assert the wire contract.
  override async request<T>(type: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ type, params });
    return this.nextResult as T;
  }
}

describe("schedule RPC wrappers (#619)", () => {
  it("createSchedule → cyborg:create_schedule with cybo+cron+prompt", async () => {
    const c = new TestClient();
    await c.createSchedule({
      workspaceId: "ws1",
      cyboIdOrSlug: "cybo-7",
      cron: "0 9 * * *",
      prompt: "morning digest",
    });
    expect(c.calls).toEqual([
      {
        type: "cyborg:create_schedule",
        params: {
          workspaceId: "ws1",
          cyboIdOrSlug: "cybo-7",
          cron: "0 9 * * *",
          prompt: "morning digest",
        },
      },
    ]);
  });

  it("listSchedules → cyborg:list_schedules, omits cyboId when absent", async () => {
    const c = new TestClient();
    c.nextResult = { schedules: [] };
    await c.listSchedules("ws1");
    expect(c.calls[0]).toEqual({ type: "cyborg:list_schedules", params: { workspaceId: "ws1" } });
  });

  it("listSchedules forwards cyboId when given", async () => {
    const c = new TestClient();
    c.nextResult = { schedules: [] };
    await c.listSchedules("ws1", "cybo-7");
    expect(c.calls[0]?.params).toEqual({ workspaceId: "ws1", cyboId: "cybo-7" });
  });

  it("updateSchedule → cyborg:update_schedule", async () => {
    const c = new TestClient();
    await c.updateSchedule({ workspaceId: "ws1", scheduleId: "s1", cron: "0 * * * *" });
    expect(c.calls[0]).toEqual({
      type: "cyborg:update_schedule",
      params: { workspaceId: "ws1", scheduleId: "s1", cron: "0 * * * *" },
    });
  });

  it("setScheduleEnabled → cyborg:set_schedule_enabled", async () => {
    const c = new TestClient();
    await c.setScheduleEnabled("ws1", "s1", false);
    expect(c.calls[0]).toEqual({
      type: "cyborg:set_schedule_enabled",
      params: { workspaceId: "ws1", scheduleId: "s1", enabled: false },
    });
  });

  it("deleteSchedule → cyborg:delete_schedule", async () => {
    const c = new TestClient();
    await c.deleteSchedule("ws1", "s1");
    expect(c.calls[0]).toEqual({
      type: "cyborg:delete_schedule",
      params: { workspaceId: "ws1", scheduleId: "s1" },
    });
  });

  it("runScheduleOnce → cyborg:run_schedule_once", async () => {
    const c = new TestClient();
    await c.runScheduleOnce("ws1", "s1");
    expect(c.calls[0]).toEqual({
      type: "cyborg:run_schedule_once",
      params: { workspaceId: "ws1", scheduleId: "s1" },
    });
  });

  it("listScheduleRuns → cyborg:list_schedule_runs with limit", async () => {
    const c = new TestClient();
    c.nextResult = { scheduleId: "s1", runs: [] };
    await c.listScheduleRuns("ws1", "s1", 20);
    expect(c.calls[0]).toEqual({
      type: "cyborg:list_schedule_runs",
      params: { workspaceId: "ws1", scheduleId: "s1", limit: 20 },
    });
  });
});
