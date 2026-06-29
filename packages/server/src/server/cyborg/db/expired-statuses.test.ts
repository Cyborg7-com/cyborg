import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./connection.js";
import * as schema from "./schema.js";
import { PgSync } from "./pg-sync.js";

const hasPg = !!process.env.DATABASE_URL;

// #671: the periodic status sweep deletes expired user_statuses AND must tell
// live clients (the relay broadcasts a `user_status_changed` clear per cleared
// row). For that broadcast to be possible, clearExpiredStatuses() must RETURN
// the (workspaceId, userId) of every row it deleted — previously it returned
// void, so the sweep had nothing to broadcast and live chips lingered until the
// next full resync. This proves the deletion + the returned identities.
describe.skipIf(!hasPg)("PgSync.clearExpiredStatuses (#671, requires DATABASE_URL)", () => {
  // Lazy — getDb() throws without DATABASE_URL, so don't touch it at collect time.
  let db: ReturnType<typeof getDb>;
  let pg: PgSync;

  const ownerId = randomUUID();
  const wsA = randomUUID();
  const wsB = randomUUID();
  // Same user, two workspaces — proves the returned rows are scoped per
  // (workspace,user), so the relay broadcasts to the right workspace's guests.
  const expiredUserA = randomUUID(); // expired in wsA → swept
  const expiredUserB = randomUUID(); // expired in wsB → swept
  const liveUser = randomUUID(); // future expiry in wsA → kept
  const noExpiryUser = randomUUID(); // null expiry in wsA → kept (never expires)
  const allUsers = [ownerId, expiredUserA, expiredUserB, liveUser, noExpiryUser];
  const allWs = [wsA, wsB];

  const past = new Date(Date.now() - 60 * 60_000); // 1h ago
  const future = new Date(Date.now() + 60 * 60_000); // 1h ahead

  beforeAll(async () => {
    db = getDb();
    pg = new PgSync();
    await db
      .insert(schema.users)
      .values(allUsers.map((id) => ({ id, email: `exp-${id}@e2e.dev`, name: "U" })));
    await db.insert(schema.workspaces).values([
      { id: wsA, name: "WS A", ownerId },
      { id: wsB, name: "WS B", ownerId },
    ]);
    await db.insert(schema.userStatuses).values([
      {
        id: randomUUID(),
        workspaceId: wsA,
        userId: expiredUserA,
        emoji: "🍔",
        text: "lunch",
        expiresAt: past,
      },
      {
        id: randomUUID(),
        workspaceId: wsB,
        userId: expiredUserB,
        emoji: "🌴",
        text: "vacation",
        expiresAt: past,
      },
      {
        id: randomUUID(),
        workspaceId: wsA,
        userId: liveUser,
        emoji: "💻",
        text: "heads down",
        expiresAt: future,
      },
      {
        id: randomUUID(),
        workspaceId: wsA,
        userId: noExpiryUser,
        emoji: "🎧",
        text: null,
        expiresAt: null,
      },
    ]);
  });

  afterAll(async () => {
    // Only clean up THIS test's rows. Do NOT closePool() here: getPool() is a
    // process-wide lazy singleton shared by every PG-gated test, and with
    // vitest's forks pool a worker can run several test files in one process —
    // tearing the pool down would yank the connection out from under whatever
    // file runs next. The pool is reclaimed when the worker process exits.
    await db.delete(schema.userStatuses).where(inArray(schema.userStatuses.workspaceId, allWs));
    await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, allWs));
    await db.delete(schema.users).where(inArray(schema.users.id, allUsers));
  });

  it("returns exactly the cleared (workspaceId, userId) rows and deletes only them", async () => {
    const cleared = await pg.clearExpiredStatuses();
    // Only the two past-expiry rows come back — scoped to the correct workspace.
    const got = cleared
      .filter((r) => allWs.includes(r.workspaceId)) // ignore unrelated rows from concurrent suites
      .map((r) => `${r.workspaceId}:${r.userId}`)
      .sort();
    expect(got).toEqual([`${wsA}:${expiredUserA}`, `${wsB}:${expiredUserB}`].sort());

    // The non-expired and never-expiring rows survive.
    const survivors = await db
      .select({ userId: schema.userStatuses.userId })
      .from(schema.userStatuses)
      .where(eq(schema.userStatuses.workspaceId, wsA));
    const survivorIds = survivors.map((r) => r.userId).sort();
    expect(survivorIds).toEqual([liveUser, noExpiryUser].sort());

    // The expired rows are actually gone.
    const expiredGone = await db
      .select({ userId: schema.userStatuses.userId })
      .from(schema.userStatuses)
      .where(
        and(
          inArray(schema.userStatuses.workspaceId, allWs),
          inArray(schema.userStatuses.userId, [expiredUserA, expiredUserB]),
        ),
      );
    expect(expiredGone).toEqual([]);
  });

  it("returns an empty array when nothing is expired (no spurious broadcasts)", async () => {
    // After the first sweep, only live/never-expiring rows remain in our ws set.
    const cleared = await pg.clearExpiredStatuses();
    const oursCleared = cleared.filter((r) => allWs.includes(r.workspaceId));
    expect(oursCleared).toEqual([]);
  });
});
