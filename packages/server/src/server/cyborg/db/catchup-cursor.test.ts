import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, closePool } from "./connection.js";
import * as schema from "./schema.js";
import { PgSync } from "./pg-sync.js";

const hasPg = !!process.env.DATABASE_URL;

// #597 /catchup: the unread digest is bounded by the caller's last_read_at and
// fed the since-slice (oldest-first, top-level, non-deleted, capped). These two
// PG getters are what the cloud relay calls before forwarding to a PG-blind
// daemon, so they must agree with the SQLite mirror (CyborgStorage) the daemon
// uses on the solo path.
describe.skipIf(!hasPg)("PgSync catch-up cursor (#597, requires DATABASE_URL)", () => {
  let db: ReturnType<typeof getDb>;
  let pg: PgSync;

  const ownerId = randomUUID();
  const readerId = randomUUID();
  const wsId = randomUUID();
  const channelId = randomUUID();
  const t0 = new Date("2026-01-01T00:00:00Z");
  // last_read at +3min; messages at +1..+5min.
  const lastRead = new Date(t0.getTime() + 3 * 60_000);

  async function insertMsg(opts: {
    id: string;
    minute: number;
    seq: number;
    fromId?: string;
    parentId?: string | null;
    deleted?: boolean;
  }): Promise<void> {
    await db.insert(schema.messages).values({
      id: opts.id,
      workspaceId: wsId,
      channelId,
      fromId: opts.fromId ?? "u_someone",
      fromType: "human",
      fromName: "Someone",
      text: `msg ${opts.id}`,
      parentId: opts.parentId ?? null,
      seq: opts.seq,
      createdAt: new Date(t0.getTime() + opts.minute * 60_000),
      ...(opts.deleted ? { deletedAt: new Date() } : {}),
    });
  }

  beforeAll(async () => {
    db = getDb();
    pg = new PgSync();
    await db.insert(schema.users).values([
      { id: ownerId, email: `cu-owner-${ownerId}@e2e.dev`, name: "Owner" },
      { id: readerId, email: `cu-reader-${readerId}@e2e.dev`, name: "Reader" },
    ]);
    await db.insert(schema.workspaces).values({ id: wsId, name: "Catchup WS", ownerId });
    await db
      .insert(schema.channels)
      .values({ id: channelId, workspaceId: wsId, name: "general", createdBy: ownerId });
    // m1,m2 are READ (before lastRead); m3,m4,m5 are UNREAD (after).
    await insertMsg({ id: "m1", minute: 1, seq: 1 });
    await insertMsg({ id: "m2", minute: 2, seq: 2 });
    await insertMsg({ id: "m3", minute: 4, seq: 3 });
    await insertMsg({ id: "m4", minute: 5, seq: 4 });
    // A thread reply (parentId) and a deleted message after lastRead must NOT
    // appear in the digest slice.
    await insertMsg({ id: "m_reply", minute: 4, seq: 5, parentId: "m3" });
    await insertMsg({ id: "m_del", minute: 5, seq: 6, deleted: true });
    await pg.markRead(wsId, readerId, channelId, lastRead.getTime());
  });

  afterAll(async () => {
    await db.delete(schema.messages).where(eq(schema.messages.channelId, channelId));
    await db.delete(schema.messageReads).where(eq(schema.messageReads.channelId, channelId));
    await db.delete(schema.channels).where(eq(schema.channels.id, channelId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, wsId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
    await db.delete(schema.users).where(eq(schema.users.id, readerId));
    await closePool();
  });

  it("getChannelLastRead returns the cursor in epoch ms (null when never read)", async () => {
    expect(await pg.getChannelLastRead(readerId, channelId)).toBe(lastRead.getTime());
    expect(await pg.getChannelLastRead(randomUUID(), channelId)).toBeNull();
  });

  it("getChannelMessagesSince returns only top-level, non-deleted unread, oldest-first", async () => {
    const since = (await pg.getChannelLastRead(readerId, channelId)) ?? 0;
    const rows = await pg.getChannelMessagesSince(channelId, since, 500);
    // m3, m4 only — m1/m2 are read, m_reply is a thread reply, m_del is deleted.
    expect(rows.map((r) => r.id)).toEqual(["m3", "m4"]);
  });

  it("sinceMs=0 (never read) digests the whole channel from the start", async () => {
    const rows = await pg.getChannelMessagesSince(channelId, 0, 500);
    expect(rows.map((r) => r.id)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("respects the cap", async () => {
    const rows = await pg.getChannelMessagesSince(channelId, 0, 1);
    expect(rows.map((r) => r.id)).toEqual(["m1"]);
  });
});
