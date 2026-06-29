import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import type { StoredCybo } from "./cybo-types.js";
import { getDb, closePool } from "./db/connection.js";
import * as schema from "./db/schema.js";
import { PgSync } from "./db/pg-sync.js";

const hasPg = !!process.env.DATABASE_URL;

// spawnCybo is imported by task-dispatch; mock the module so no real agent runs.
// Each test resets the mock to return a stable agent id.
const { spawnCyboMock } = vi.hoisted(() => ({ spawnCyboMock: vi.fn() }));
vi.mock("./cybo-manager.js", () => ({ spawnCybo: spawnCyboMock }));

import {
  computeNextRecurrence,
  dispatchTaskToAgent,
  spawnNextRecurrence,
  catchUpOwnedTasks,
  MAX_RECURRENCE_COUNT,
} from "./task-dispatch.js";

// ─── computeNextRecurrence (pure, deterministic) ────────────────────────────

describe("computeNextRecurrence", () => {
  const NOW = 1_000_000_000_000; // fixed wall clock for determinism

  it("returns null for a non-recurring / unparseable expression", () => {
    expect(computeNextRecurrence(null, NOW, NOW)).toBeNull();
    expect(computeNextRecurrence(undefined, NOW, NOW)).toBeNull();
    expect(computeNextRecurrence("", NOW, NOW)).toBeNull();
    expect(computeNextRecurrence("every monday", NOW, NOW)).toBeNull();
    expect(computeNextRecurrence("rate(0 minutes)", NOW, NOW)).toBeNull(); // N < 1
    expect(computeNextRecurrence("rate(5 fortnights)", NOW, NOW)).toBeNull(); // bad unit
    expect(computeNextRecurrence("rate(99999 weeks)", NOW, NOW)).toBeNull(); // > MAX_AMOUNT
  });

  it("parses singular and plural units (rate(1 minute) == rate(1 minutes))", () => {
    const fromPast = NOW - 10_000;
    expect(computeNextRecurrence("rate(1 minute)", fromPast, NOW)).toBe(
      computeNextRecurrence("rate(1 minutes)", fromPast, NOW),
    );
  });

  it("minute/hour cadence is O(1): a from far in the past lands one interval past now", () => {
    // A task stuck a year in the past on rate(1 minute): the result must be the
    // FIRST minute-boundary strictly after now, not a value still behind now.
    const yearAgo = NOW - 365 * 24 * 60 * 60_000;
    const next = computeNextRecurrence("rate(1 minute)", yearAgo, NOW)!;
    expect(next).toBeGreaterThan(NOW);
    expect(next - NOW).toBeLessThanOrEqual(60_000);
    // The result stays phase-aligned to the original anchor's minute grid.
    expect((next - yearAgo) % 60_000).toBe(0);
  });

  it("clamps a past due_at strictly into the future", () => {
    const past = NOW - 5 * 60_000;
    const next = computeNextRecurrence("rate(2 minutes)", past, NOW)!;
    expect(next).toBeGreaterThan(NOW);
  });

  it("a future anchor still yields now + one interval (re-anchors to now)", () => {
    // A not-yet-due parent (due_at in the future) must not advance off the future
    // anchor — the next fire is one interval from NOW, mirroring v1's baseDate clamp.
    const future = NOW + 10 * 60_000;
    const next = computeNextRecurrence("rate(5 minutes)", future, NOW)!;
    expect(next).toBeGreaterThan(NOW);
    expect(next - NOW).toBeLessThanOrEqual(5 * 60_000);
  });

  it("hour cadence advances by whole hours", () => {
    const past = NOW - 30 * 60_000; // 30 min ago
    const next = computeNextRecurrence("rate(1 hour)", past, NOW)!;
    expect(next).toBeGreaterThan(NOW);
    expect((next - past) % (60 * 60_000)).toBe(0);
  });

  it("day cadence (iterative DST-aware path) lands strictly in the future", () => {
    const past = NOW - 3 * 24 * 60 * 60_000;
    const next = computeNextRecurrence("rate(1 day)", past, NOW)!;
    expect(next).toBeGreaterThan(NOW);
  });

  it("week cadence lands strictly in the future", () => {
    const past = NOW - 3 * 7 * 24 * 60 * 60_000;
    const next = computeNextRecurrence("rate(2 weeks)", past, NOW)!;
    expect(next).toBeGreaterThan(NOW);
  });
});

// ─── shared SQLite harness ──────────────────────────────────────────────────

interface Harness {
  storage: DualStorage;
  sqlite: CyborgStorage;
  agentManager: AgentManager;
  runAgent: ReturnType<typeof vi.fn>;
  logger: Logger;
  wsId: string;
  userId: string;
  makeCybo: (over?: Partial<{ slug: string }>) => StoredCybo;
}

function makeHarness(): Harness {
  const sqlite = new CyborgStorage(":memory:");
  const storage = new DualStorage(sqlite, null);
  // Seed a real user + workspace so the cybos FK (workspace + createdBy) is
  // satisfied. createWorkspace also enrolls the owner as a member.
  const user = sqlite.upsertUser("owner@e2e.dev", "Owner");
  const ws = sqlite.createWorkspace("Tasks WS", user.id);
  const runAgent = vi.fn(() => Promise.resolve({}));
  const agentManager = { runAgent } as unknown as AgentManager;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  let n = 0;
  const makeCybo = (over: Partial<{ slug: string }> = {}): StoredCybo =>
    sqlite.createCybo({
      workspaceId: ws.id,
      slug: over.slug ?? `cybo-${++n}`,
      name: `Cybo ${n}`,
      soul: "test soul",
      provider: "claude",
      createdBy: user.id,
    });
  return {
    storage,
    sqlite,
    agentManager,
    runAgent,
    logger,
    wsId: ws.id,
    userId: user.id,
    makeCybo,
  };
}

beforeEach(() => {
  spawnCyboMock.mockReset();
  spawnCyboMock.mockResolvedValue({
    agentId: "ag_1",
    cyboId: "cybo_x",
    cyboSlug: "c",
    provider: "claude",
    model: null,
    systemPrompt: "",
  });
});

// ─── dispatchTaskToAgent ────────────────────────────────────────────────────

describe("dispatchTaskToAgent", () => {
  it("skips a task with no assignee", async () => {
    const h = makeHarness();
    // Project-agnostic seed: a project-less channel routes the task to the
    // workspace Inbox, satisfying the require-project resolver. The dispatch
    // behavior under test keys off assignee/due/recurrence, not the project.
    const task = h.sqlite.createTask({
      workspaceId: h.wsId,
      title: "no assignee",
      createdBy: h.userId,
      channelId: "no-project-channel",
    });
    const won = await dispatchTaskToAgent({
      storage: h.storage,
      agentManager: h.agentManager,
      task,
      reason: "task_assigned",
      logger: h.logger,
    });
    expect(won).toBe(false);
    expect(spawnCyboMock).not.toHaveBeenCalled();
  });

  it("skips a human-assigned task (assignee is not a cybo)", async () => {
    const h = makeHarness();
    const task = h.sqlite.createTask({
      workspaceId: h.wsId,
      title: "human task",
      createdBy: h.userId,
      assigneeId: "human_user_id",
      channelId: "no-project-channel",
    });
    const won = await dispatchTaskToAgent({
      storage: h.storage,
      agentManager: h.agentManager,
      task,
      reason: "task_assigned",
      logger: h.logger,
    });
    expect(won).toBe(false);
    expect(spawnCyboMock).not.toHaveBeenCalled();
  });

  it("dispatches an agent-assigned task exactly once (claim holds across a second call)", async () => {
    const h = makeHarness();
    const cybo = h.makeCybo();
    const task = h.sqlite.createTask({
      workspaceId: h.wsId,
      title: "deploy relay",
      createdBy: h.userId,
      assigneeId: cybo.id,
      channelId: "no-project-channel",
    });

    const first = await dispatchTaskToAgent({
      storage: h.storage,
      agentManager: h.agentManager,
      task,
      reason: "task_assigned",
      logger: h.logger,
    });
    // Second call simulates a runner tick firing right after the immediate dispatch.
    const second = await dispatchTaskToAgent({
      storage: h.storage,
      agentManager: h.agentManager,
      task,
      reason: "task_due",
      logger: h.logger,
    });

    expect(first).toBe(true);
    expect(second).toBe(false); // claim still held inside the 30s window
    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
    expect(h.runAgent).toHaveBeenCalledTimes(1);
  });

  it("does not re-fire after a spawn failure within the claim window", async () => {
    const h = makeHarness();
    const cybo = h.makeCybo();
    const task = h.sqlite.createTask({
      workspaceId: h.wsId,
      title: "flaky",
      createdBy: h.userId,
      assigneeId: cybo.id,
      channelId: "no-project-channel",
    });
    spawnCyboMock.mockRejectedValueOnce(new Error("daemon dropped"));

    const first = await dispatchTaskToAgent({
      storage: h.storage,
      agentManager: h.agentManager,
      task,
      reason: "task_assigned",
      logger: h.logger,
    });
    // The claim was taken before the throw, so an immediate retry loses the claim.
    const second = await dispatchTaskToAgent({
      storage: h.storage,
      agentManager: h.agentManager,
      task,
      reason: "task_due",
      logger: h.logger,
    });

    expect(first).toBe(false); // spawn failed
    expect(second).toBe(false); // claim still held → no re-fire storm
    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
  });
});

// ─── spawnNextRecurrence ────────────────────────────────────────────────────

describe("spawnNextRecurrence", () => {
  it("returns null for a non-recurring task", () => {
    const h = makeHarness();
    const task = h.sqlite.createTask({
      workspaceId: h.wsId,
      title: "one-off",
      createdBy: h.userId,
      channelId: "no-project-channel",
    });
    expect(spawnNextRecurrence({ storage: h.storage, task, nowMs: Date.now() })).toBeNull();
  });

  it("spawns exactly one child for a recurring task and increments recurrence_count", () => {
    const h = makeHarness();
    const created = h.sqlite.createTask({
      workspaceId: h.wsId,
      title: "standup",
      createdBy: h.userId,
      channelId: "no-project-channel",
    });
    const task = h.sqlite.updateTask(created.id, { recurrence: "rate(1 day)" })!;

    const childId = spawnNextRecurrence({ storage: h.storage, task, nowMs: Date.now() });
    expect(childId).not.toBeNull();

    const after = h.sqlite.getTasks(h.wsId).find((t) => t.id === task.id);
    expect(after?.recurrence_count).toBe(1);
    // A second spawn on the SAME parent is a no-op (recurrence_spawned_at claimed).
    const again = spawnNextRecurrence({ storage: h.storage, task, nowMs: Date.now() });
    expect(again).toBeNull();
  });

  it("does not spawn past MAX_RECURRENCE_COUNT", () => {
    const h = makeHarness();
    const created = h.sqlite.createTask({
      workspaceId: h.wsId,
      title: "capped",
      createdBy: h.userId,
      channelId: "no-project-channel",
    });
    const task = h.sqlite.updateTask(created.id, {
      recurrence: "rate(1 hour)",
      recurrence_count: MAX_RECURRENCE_COUNT,
    })!;
    expect(spawnNextRecurrence({ storage: h.storage, task, nowMs: Date.now() })).toBeNull();
  });
});

// ─── getDueTasks selection (via DualStorage) ────────────────────────────────

describe("getDueTasks selection rules", () => {
  it("includes only open, agent-assignable, due-now, claimable tasks", () => {
    const h = makeHarness();
    const cybo = h.makeCybo();
    const now = Date.now();

    const due = h.sqlite.createTask({
      workspaceId: h.wsId,
      title: "due now",
      createdBy: h.userId,
      assigneeId: cybo.id,
      dueAt: now - 1000,
      channelId: "no-project-channel",
    });
    // Future-due → excluded.
    h.sqlite.createTask({
      workspaceId: h.wsId,
      title: "future",
      createdBy: h.userId,
      assigneeId: cybo.id,
      dueAt: now + 60_000,
      channelId: "no-project-channel",
    });
    // No due_at → excluded (ad-hoc, handled by immediate dispatch not the tick).
    h.sqlite.createTask({
      workspaceId: h.wsId,
      title: "no due",
      createdBy: h.userId,
      assigneeId: cybo.id,
      channelId: "no-project-channel",
    });
    // No assignee → excluded.
    h.sqlite.createTask({
      workspaceId: h.wsId,
      title: "unassigned due",
      createdBy: h.userId,
      dueAt: now - 1000,
      channelId: "no-project-channel",
    });
    // Done → excluded.
    const done = h.sqlite.createTask({
      workspaceId: h.wsId,
      title: "done due",
      createdBy: h.userId,
      assigneeId: cybo.id,
      dueAt: now - 1000,
      channelId: "no-project-channel",
    });
    h.sqlite.updateTask(done.id, { status: "done" });

    const dueIds = h.storage.getDueTasks(now).map((t) => t.id);
    expect(dueIds).toEqual([due.id]);
  });

  it("excludes a task whose claim is still fresh (claimable filter)", () => {
    const h = makeHarness();
    const cybo = h.makeCybo();
    const now = Date.now();
    const task = h.sqlite.createTask({
      workspaceId: h.wsId,
      title: "freshly claimed",
      createdBy: h.userId,
      assigneeId: cybo.id,
      dueAt: now - 1000,
      channelId: "no-project-channel",
    });
    expect(h.storage.getDueTasks(now).map((t) => t.id)).toEqual([task.id]);
    // Claim it; now the due-scan must skip it within the 30s window.
    expect(h.storage.claimTaskDispatch(task.id)).toBe(true);
    expect(h.storage.getDueTasks(now)).toEqual([]);
  });
});

// ─── catchUpOwnedTasks ──────────────────────────────────────────────────────

describe("catchUpOwnedTasks", () => {
  it("dispatches each owned open task once and does not double-fire on a second sweep", async () => {
    const h = makeHarness();
    const cybo = h.makeCybo();
    // Two owned open tasks, undispatched.
    h.sqlite.createTask({
      workspaceId: h.wsId,
      title: "owned A",
      createdBy: h.userId,
      assigneeId: cybo.id,
      channelId: "no-project-channel",
    });
    h.sqlite.createTask({
      workspaceId: h.wsId,
      title: "owned B",
      createdBy: h.userId,
      assigneeId: cybo.id,
      channelId: "no-project-channel",
    });

    const opts = {
      storage: h.storage,
      agentManager: h.agentManager,
      workspaceId: h.wsId,
      assigneeIds: [cybo.id],
      logger: h.logger,
    };

    const firstSweep = await catchUpOwnedTasks(opts);
    // A reconnect storm: an immediate second sweep must not re-dispatch (claims held).
    const secondSweep = await catchUpOwnedTasks(opts);

    expect(firstSweep).toBe(2);
    expect(secondSweep).toBe(0);
    expect(spawnCyboMock).toHaveBeenCalledTimes(2);
  });

  it("returns 0 with no owned cybos", async () => {
    const h = makeHarness();
    const dispatched = await catchUpOwnedTasks({
      storage: h.storage,
      agentManager: h.agentManager,
      workspaceId: h.wsId,
      assigneeIds: [],
      logger: h.logger,
    });
    expect(dispatched).toBe(0);
  });
});

// ─── Recurrence exactly-once under TRUE concurrency (requires DATABASE_URL) ──
// computeNextRecurrence + the atomic pg.spawnRecurrenceChild together must yield
// exactly one child even when N callers race the same completed parent
// (internal docs §6.8; internal docs recurrence-under-concurrency).
describe.skipIf(!hasPg)("spawnNextRecurrence concurrency (PG)", () => {
  let db: ReturnType<typeof getDb>;
  let pg: PgSync;
  const owner = randomUUID();
  const wsId = randomUUID();

  beforeAll(async () => {
    db = getDb();
    pg = new PgSync();
    await db.insert(schema.users).values({ id: owner, email: `rec-${owner}@e2e.dev` });
    await db.insert(schema.workspaces).values({ id: wsId, name: "Rec WS", ownerId: owner });
  });

  afterAll(async () => {
    await db.delete(schema.tasks).where(eq(schema.tasks.workspaceId, wsId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, wsId));
    await db.delete(schema.users).where(eq(schema.users.id, owner));
    await closePool();
  });

  it("N concurrent spawns of one completed recurring parent → exactly one child", async () => {
    const parentId = randomUUID();
    const now = Date.now();
    await db.insert(schema.tasks).values({
      id: parentId,
      workspaceId: wsId,
      title: "daily report",
      status: "done",
      createdBy: owner,
      dueAt: new Date(now - 60_000),
      recurrence: "rate(1 day)",
    });

    const next = computeNextRecurrence("rate(1 day)", now - 60_000, now)!;
    expect(next).toBeGreaterThan(now);

    // 10 racing callers compute the same next due and race the atomic spawn claim.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        pg.spawnRecurrenceChild(parentId, next, MAX_RECURRENCE_COUNT),
      ),
    );
    const childIds = results.filter((id): id is string => id !== null);
    expect(childIds).toHaveLength(1);

    // The parent's recurrence_count advanced by exactly 1.
    const [parent] = await pg.getTasks(wsId, { status: "done" });
    expect(parent.recurrence_count).toBe(1);
  });
});

// ─── Tasks Phase 2 (watcher): channelId + priority round-trip (requires DATABASE_URL) ──
// PgSync.createTask is the SHARED-store write the relay's create_task / cybo_write
// paths funnel through. This proves the channel binding + board priority a watcher
// cybo sets actually land in PG (the rows the UI reads), and that omitting them
// stays NULL — the back-compat contract.
describe.skipIf(!hasPg)("PgSync.createTask channelId + priority (PG)", () => {
  let db: ReturnType<typeof getDb>;
  let pg: PgSync;
  const owner = randomUUID();
  const wsId = randomUUID();
  const channelId = randomUUID();

  beforeAll(async () => {
    db = getDb();
    pg = new PgSync();
    await db.insert(schema.users).values({ id: owner, email: `cp-${owner}@e2e.dev` });
    await db.insert(schema.workspaces).values({ id: wsId, name: "CP WS", ownerId: owner });
    await db
      .insert(schema.channels)
      .values({ id: channelId, workspaceId: wsId, name: "watched", createdBy: owner });
  });

  afterAll(async () => {
    await db.delete(schema.tasks).where(eq(schema.tasks.workspaceId, wsId));
    await db.delete(schema.channels).where(eq(schema.channels.workspaceId, wsId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, wsId));
    await db.delete(schema.users).where(eq(schema.users.id, owner));
    await closePool();
  });

  it("persists channelId + priority and reads them back", async () => {
    const id = randomUUID();
    await pg.createTask({
      id,
      workspaceId: wsId,
      title: "Watched task",
      createdBy: owner,
      channelId,
      priority: "high",
    });
    const task = (await pg.getTasks(wsId)).find((t) => t.id === id);
    expect(task).toBeDefined();
    expect(task!.channel_id).toBe(channelId);
    expect(task!.priority).toBe("high");
  });

  it("leaves channelId + priority NULL when omitted (back-compat)", async () => {
    const id = randomUUID();
    // The require-project resolver needs a routing signal; the workspace Inbox
    // project is the minimal one that leaves channel_id + priority untouched
    // (the two columns this back-compat case asserts stay NULL when omitted).
    const projectId = await pg.getOrCreateInboxProject(wsId);
    await pg.createTask({
      id,
      workspaceId: wsId,
      title: "Plain task",
      createdBy: owner,
      projectId,
    });
    const task = (await pg.getTasks(wsId)).find((t) => t.id === id);
    expect(task).toBeDefined();
    expect(task!.channel_id).toBeNull();
    expect(task!.priority).toBeNull();
  });
});
