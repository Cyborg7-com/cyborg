import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentManager } from "../agent/agent-manager.js";
import type { Logger } from "pino";
import type { DualStorage } from "./dual-storage.js";
import type { StoredSchedule } from "./storage.js";

// Privacy #1077: an autonomous raw-prompt fire must stamp the CREATOR's real email
// on the spawn so the relay owner-scopes the session to the scheduler — never
// leaving it owner-less. The synthetic "<id>@remote.local" placeholder can't match
// a real cloud email, so it must resolve to null (mirror fallback handles those).

// Mock spawnCybo so no real agent runs; we assert the args it received.
const { spawnCyboMock } = vi.hoisted(() => ({ spawnCyboMock: vi.fn() }));
vi.mock("./cybo-manager.js", () => ({ spawnCybo: spawnCyboMock }));

import { ScheduleRunner } from "./schedule-runner.js";

function makeSchedule(over: Partial<StoredSchedule> = {}): StoredSchedule {
  return {
    id: "sch_1",
    workspace_id: "ws_1",
    cybo_id: "cybo_1",
    cron_expr: "0 9 * * *",
    prompt: "summarize the channel",
    created_by: "creator_local",
    channel_id: null,
    timezone: null,
    next_run_at: 0,
    enabled: 1,
    max_runs: null,
    run_count: 0,
    catch_up: 1,
    task_id: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  } as StoredSchedule;
}

function makeRunner(email: string | undefined): {
  runner: ScheduleRunner;
  getUserById: ReturnType<typeof vi.fn>;
} {
  const schedule = makeSchedule();
  const getUserById = vi.fn((id: string) =>
    email !== undefined && id === schedule.created_by ? { id, email } : undefined,
  );
  const storage = {
    getDueSchedules: vi.fn(() => [schedule]),
    getSchedule: vi.fn(() => schedule),
    getChannel: vi.fn(() => undefined),
    getMembership: vi.fn(() => ({
      workspace_id: schedule.workspace_id,
      user_id: schedule.created_by,
    })),
    setScheduleEnabled: vi.fn(),
    markScheduleRun: vi.fn(),
    startScheduleRun: vi.fn(() => "schrun_1"),
    finishScheduleRun: vi.fn(),
    recordSkippedScheduleRun: vi.fn(),
    getDueTasks: vi.fn(() => [] as unknown[]),
    getCybo: vi.fn(() => undefined),
    claimTaskDispatch: vi.fn(() => true),
    getTaskById: vi.fn(() => undefined),
    claimScheduleDispatch: vi.fn(async () => true),
    getLiveCyboBinding: vi.fn(() => undefined as unknown),
    getUserById,
    pg: null,
  };
  const agentManager = {
    runAgent: vi.fn(() => Promise.resolve({})),
    getAgent: vi.fn(() => null),
  };
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const runner = new ScheduleRunner({
    storage: storage as unknown as DualStorage,
    agentManager: agentManager as unknown as AgentManager,
    logger: logger as unknown as Logger,
    serverId: "daemon_1",
  });
  return { runner, getUserById };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ScheduleRunner owner-stamp (initiatedByEmail) — privacy #1077", () => {
  beforeEach(() => {
    spawnCyboMock.mockReset();
    spawnCyboMock.mockResolvedValue({ agentId: "ag_1", cyboId: "cybo_1", cyboSlug: "c" });
  });

  it("stamps the creator's real email on the raw-prompt spawn", async () => {
    const { runner } = makeRunner("creator@x.com");
    await runner.tick();
    await flush();
    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
    expect(spawnCyboMock.mock.calls[0][0]).toMatchObject({ initiatedByEmail: "creator@x.com" });
  });

  it("resolves a '<id>@remote.local' placeholder to null (no false owner)", async () => {
    const { runner } = makeRunner("creator_local@remote.local");
    await runner.tick();
    await flush();
    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
    expect(spawnCyboMock.mock.calls[0][0]).toMatchObject({ initiatedByEmail: null });
  });

  it("yields null when the local id resolves to no user (unknown creator)", async () => {
    const { runner } = makeRunner(undefined);
    await runner.tick();
    await flush();
    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
    expect(spawnCyboMock.mock.calls[0][0]).toMatchObject({ initiatedByEmail: null });
  });
});
