import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "./connection.js";
import * as schema from "./schema.js";
import { PgSync } from "./pg-sync.js";

const hasPg = !!process.env.DATABASE_URL;

// Saved messages (#609) — a PRIVATE per-user bookmark list. This locks the three
// invariants the feature rests on: a save SHOWS UP in the user's list; an unsave
// REMOVES it; and saves are PER-USER ISOLATED (my saves are never in your list,
// even for the same message). PG-gated like webhook-unread.test.ts — skips
// cleanly with no DATABASE_URL; the CTO runs it against dev RDS via the tunnel.
describe.skipIf(!hasPg)("PgSync saved messages (#609, requires DATABASE_URL)", () => {
  let db: ReturnType<typeof getDb>;
  let pg: PgSync;

  const me = randomUUID();
  const peer = randomUUID();
  const wsId = randomUUID();
  const otherWsId = randomUUID();
  const channelId = randomUUID();
  const t0 = new Date("2026-03-01T00:00:00Z");

  // Three messages in `wsId` + one in a DIFFERENT workspace (otherWsId), to prove
  // getSavedMessages is workspace-scoped.
  const m1 = `m1-${randomUUID()}`;
  const m2 = `m2-${randomUUID()}`;
  const m3 = `m3-${randomUUID()}`;
  const mOther = `mo-${randomUUID()}`;
  const allMsgIds = [m1, m2, m3, mOther];

  async function insertMsg(o: { id: string; minute: number; seq: number; ws: string }) {
    await db.insert(schema.messages).values({
      id: o.id,
      workspaceId: o.ws,
      channelId,
      fromId: peer,
      fromType: "human",
      fromName: "Peer",
      text: `msg ${o.id}`,
      seq: o.seq,
      createdAt: new Date(t0.getTime() + o.minute * 60_000),
    });
  }

  beforeAll(async () => {
    db = getDb();
    pg = new PgSync();
    await db.insert(schema.users).values([
      { id: me, email: `sm-me-${me}@e2e.dev`, name: "Me" },
      { id: peer, email: `sm-peer-${peer}@e2e.dev`, name: "Peer" },
    ]);
    await db.insert(schema.workspaces).values([
      { id: wsId, name: "Saved WS", ownerId: me },
      { id: otherWsId, name: "Other WS", ownerId: me },
    ]);
    await db
      .insert(schema.channels)
      .values({ id: channelId, workspaceId: wsId, name: "general", createdBy: me });
    await insertMsg({ id: m1, minute: 1, seq: 1, ws: wsId });
    await insertMsg({ id: m2, minute: 2, seq: 2, ws: wsId });
    await insertMsg({ id: m3, minute: 3, seq: 3, ws: wsId });
    await insertMsg({ id: mOther, minute: 4, seq: 4, ws: otherWsId });
  });

  // Clear the save-slate between tests so each starts clean — saves are mutable
  // per-user state, so without this a save from one test leaks into the next
  // (e.g. the per-user-isolation test must not see m3 saved by an earlier test).
  // Keeps the suite order-independent AND idempotent across repeated runs.
  afterEach(async () => {
    await db.delete(schema.savedMessages).where(inArray(schema.savedMessages.userId, [me, peer]));
  });

  afterAll(async () => {
    await db.delete(schema.savedMessages).where(inArray(schema.savedMessages.userId, [me, peer]));
    await db.delete(schema.messages).where(inArray(schema.messages.id, allMsgIds));
    await db.delete(schema.channels).where(eq(schema.channels.id, channelId));
    await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, [wsId, otherWsId]));
    await db.delete(schema.users).where(inArray(schema.users.id, [me, peer]));
  });

  it("a saved message appears in getSavedMessages; unsave removes it", async () => {
    await pg.saveMessage(me, m1);
    await pg.saveMessage(me, m2);

    let saved = await pg.getSavedMessages(me, wsId);
    expect(saved.map((s) => s.id).sort()).toEqual([m1, m2].sort());

    await pg.unsaveMessage(me, m1);
    saved = await pg.getSavedMessages(me, wsId);
    expect(saved.map((s) => s.id)).toEqual([m2]);
  });

  it("save is idempotent (re-saving the same message does not duplicate)", async () => {
    await pg.saveMessage(me, m3);
    await pg.saveMessage(me, m3);
    const saved = await pg.getSavedMessages(me, wsId);
    expect(saved.filter((s) => s.id === m3)).toHaveLength(1);
  });

  it("returns newest-saved first across channels", async () => {
    // Fresh user to control save ORDER independent of the tests above.
    const u = randomUUID();
    await db.insert(schema.users).values({ id: u, email: `sm-ord-${u}@e2e.dev`, name: "Ord" });
    try {
      await pg.saveMessage(u, m1); // saved first  → oldest
      await pg.saveMessage(u, m2); // saved second
      await pg.saveMessage(u, m3); // saved last   → newest
      const saved = await pg.getSavedMessages(u, wsId);
      expect(saved.map((s) => s.id)).toEqual([m3, m2, m1]);
    } finally {
      await db.delete(schema.savedMessages).where(eq(schema.savedMessages.userId, u));
      await db.delete(schema.users).where(eq(schema.users.id, u));
    }
  });

  it("saves are PER-USER isolated — my saves are not in your list", async () => {
    await pg.saveMessage(me, m2);
    await pg.saveMessage(peer, m3);

    const mine = await pg.getSavedMessages(me, wsId);
    const theirs = await pg.getSavedMessages(peer, wsId);

    expect(mine.map((s) => s.id)).toContain(m2);
    expect(mine.map((s) => s.id)).not.toContain(m3); // peer's save isn't mine
    expect(theirs.map((s) => s.id)).toEqual([m3]); // peer sees only their own
  });

  it("getSavedMessages is workspace-scoped — a save in another workspace is excluded", async () => {
    await pg.saveMessage(me, mOther); // mOther lives in otherWsId
    const inWs = await pg.getSavedMessages(me, wsId);
    expect(inWs.map((s) => s.id)).not.toContain(mOther);

    const inOther = await pg.getSavedMessages(me, otherWsId);
    expect(inOther.map((s) => s.id)).toEqual([mOther]);
  });

  it("a soft-deleted message drops out of the saved list", async () => {
    const u = randomUUID();
    await db.insert(schema.users).values({ id: u, email: `sm-del-${u}@e2e.dev`, name: "Del" });
    try {
      await pg.saveMessage(u, m1);
      expect((await pg.getSavedMessages(u, wsId)).map((s) => s.id)).toEqual([m1]);
      // Tombstone the message; the saved row stays but the join filters it out.
      await db
        .update(schema.messages)
        .set({ deletedAt: new Date() })
        .where(eq(schema.messages.id, m1));
      expect(await pg.getSavedMessages(u, wsId)).toEqual([]);
    } finally {
      await db.update(schema.messages).set({ deletedAt: null }).where(eq(schema.messages.id, m1));
      await db.delete(schema.savedMessages).where(eq(schema.savedMessages.userId, u));
      await db.delete(schema.users).where(eq(schema.users.id, u));
    }
  });
});
