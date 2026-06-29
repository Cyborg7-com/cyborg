import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { CyborgStorage } from "../storage.js";
import { getDb, closePool } from "./connection.js";
import * as schema from "./schema.js";
import { PgSync } from "./pg-sync.js";

// Tasks Phase 3 keystone contract: the atomic dispatch claim must let EXACTLY ONE
// of N concurrent claimers win, so a multi-replica / immediate+tick double-fire
// dispatches a task at most once (internal docs §6.7). Proven on the SQLite
// mirror (always available, synchronous) plus PG when DATABASE_URL is set.
//
// Also proves the watcher failover-chain order: getChannelCyboMembers must return
// channel cybos in join order (joined_at ASC, cybo_id ASC) so the chain is stable
// across calls/replicas (internal docs Decision 2 / C2). That lives in PG (cybo
// channel membership is PG-only), so it skips cleanly without DATABASE_URL.

const hasPg = !!process.env.DATABASE_URL;

describe("CyborgStorage.claimTaskDispatch (SQLite mirror)", () => {
  let storage: CyborgStorage;

  beforeAll(() => {
    storage = new CyborgStorage(":memory:");
    // createTask now also inserts a tasks_projects row whose workspace_id
    // REFERENCES workspaces(id), so the workspace must exist first or the create
    // fails with SQLITE_CONSTRAINT_FOREIGNKEY. Seed the ws_1 row every test below
    // targets (same id used as the createTask workspaceId / getTasks scope).
    storage.createWorkspaceWithId("ws_1", "Claim WS", "user_1");
  });

  it("lets exactly one of many concurrent claimers win", () => {
    // Project-agnostic seed: a project-less channel routes the task to the
    // workspace Inbox, satisfying the require-project resolver.
    const task = storage.createTask({
      workspaceId: "ws_1",
      title: "Deploy the relay",
      createdBy: "user_1",
      assigneeId: "cybo_1",
      channelId: "no-project-channel",
    });

    // 50 racing claimers against a freshly-created (unclaimed) task. better-sqlite3
    // is synchronous, so this is a real, ordered race over the same row.
    const results = Array.from({ length: 50 }, () => storage.claimTaskDispatch(task.id));
    const winners = results.filter((won) => won === true);

    expect(winners).toHaveLength(1);
  });

  it("re-claims only after the stale window elapses", () => {
    const task = storage.createTask({
      workspaceId: "ws_1",
      title: "Rotate secrets",
      createdBy: "user_1",
      assigneeId: "cybo_1",
      channelId: "no-project-channel",
    });

    // First claim wins; an immediate second claim (within the window) loses.
    expect(storage.claimTaskDispatch(task.id, 30_000)).toBe(true);
    expect(storage.claimTaskDispatch(task.id, 30_000)).toBe(false);

    // With a zero-length stale window, the claim is immediately re-claimable
    // (last_dispatched_at <= now passes), so the next caller wins again.
    expect(storage.claimTaskDispatch(task.id, 0)).toBe(true);
  });

  it("spawnRecurrenceChild creates at most one child under concurrent spawns", () => {
    const parent = storage.createTask({
      workspaceId: "ws_1",
      title: "Daily standup",
      createdBy: "user_1",
      assigneeId: "cybo_1",
      channelId: "no-project-channel",
    });

    const due = Date.now() + 86_400_000;
    const results = Array.from({ length: 20 }, () =>
      storage.spawnRecurrenceChild(parent.id, due, 100),
    );
    const children = results.filter((c) => c !== undefined);

    expect(children).toHaveLength(1);
    // The cap is honored: the parent's recurrence_count advanced by exactly 1.
    const after = storage.getTasks("ws_1").find((t) => t.id === parent.id);
    expect(after?.recurrence_count).toBe(1);
  });

  it("spawnRecurrenceChild refuses to spawn past the cap", () => {
    const parent = storage.createTask({
      workspaceId: "ws_1",
      title: "Capped task",
      createdBy: "user_1",
      channelId: "no-project-channel",
    });
    // Cap of 0 => never spawns.
    expect(storage.spawnRecurrenceChild(parent.id, null, 0)).toBeUndefined();
  });
});

describe.skipIf(!hasPg)("PgSync task dispatch + chain order (requires DATABASE_URL)", () => {
  let db: ReturnType<typeof getDb>;
  let pg: PgSync;

  const owner = randomUUID();
  const wsId = randomUUID();
  const channelId = randomUUID();
  // Three cybos joined in a deliberate order; ids chosen so join-order != id-order
  // would be visible if the ORDER BY were wrong.
  const cyboB = `cybo_b_${randomUUID()}`;
  const cyboA = `cybo_a_${randomUUID()}`;
  const cyboC = `cybo_c_${randomUUID()}`;
  const taskId = randomUUID();

  beforeAll(async () => {
    db = getDb();
    pg = new PgSync();
    await db.insert(schema.users).values({ id: owner, email: `claim-${owner}@e2e.dev` });
    await db.insert(schema.workspaces).values({ id: wsId, name: "Claim WS", ownerId: owner });
    for (const id of [cyboB, cyboA, cyboC]) {
      await db.insert(schema.cybos).values({
        id,
        workspaceId: wsId,
        slug: id,
        name: id,
        soul: "test soul",
        provider: "claude",
        createdBy: owner,
      });
    }
    await db.insert(schema.channels).values({
      id: channelId,
      workspaceId: wsId,
      name: "watched",
      createdBy: owner,
    });
    // Insert cybo memberships in B, A, C order with strictly increasing joinedAt so
    // join order is deterministic and distinct from cybo_id sort order.
    let t = Date.now();
    for (const id of [cyboB, cyboA, cyboC]) {
      await db.insert(schema.channelMembers).values({
        channelId,
        cyboId: id,
        memberType: "cybo",
        joinedAt: new Date(t),
      });
      t += 1000;
    }
  });

  afterAll(async () => {
    await db.delete(schema.tasks).where(eq(schema.tasks.workspaceId, wsId));
    await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, channelId));
    await db.delete(schema.channels).where(eq(schema.channels.id, channelId));
    await db.delete(schema.cybos).where(eq(schema.cybos.workspaceId, wsId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, wsId));
    await db.delete(schema.users).where(eq(schema.users.id, owner));
    await closePool();
  });

  it("getChannelCyboMembers returns join order (joined_at ASC, cybo_id ASC)", async () => {
    const chain = await pg.getChannelCyboMembers(channelId);
    expect(chain).toEqual([cyboB, cyboA, cyboC]);
  });

  it("claimTaskDispatch: exactly one of two concurrent claims wins", async () => {
    await pg.createTask({
      id: taskId,
      workspaceId: wsId,
      title: "Concurrent claim",
      createdBy: owner,
      assigneeId: cyboA,
      channelId,
      priority: "high",
    });

    // Two concurrent claims on the same fresh task — exactly one must win.
    const [a, b] = await Promise.all([pg.claimTaskDispatch(taskId), pg.claimTaskDispatch(taskId)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("threads channelId + priority through createTask", async () => {
    const [row] = await pg.getTasks(wsId, { assigneeId: cyboA });
    expect(row.channel_id).toBe(channelId);
    expect(row.priority).toBe("high");
  });
});
