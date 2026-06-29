import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "./connection.js";
import * as schema from "./schema.js";
import { PgSync } from "./pg-sync.js";

const hasPg = !!process.env.DATABASE_URL;

// A webhook/CI card is injected under its creator's user id (webhook.createdBy),
// but it is NOT the creator's own typing. The unread queries excluded own-id
// messages (`fromId <> userId`), so a deploy card you created never counted as
// unread for you — the badge/divider never showed (and #672's authoritative
// reconcile cleared any live flag). The fix adds `OR source = 'webhook'` to the
// own-send exclusion. This test locks: webhook-from-self counts as unread; a
// genuine own (non-webhook) send still does not.
describe.skipIf(!hasPg)(
  "PgSync unread counts webhook cards from self (requires DATABASE_URL)",
  () => {
    let db: ReturnType<typeof getDb>;
    let pg: PgSync;

    const me = randomUUID();
    const peer = randomUUID();
    const wsId = randomUUID();
    const channelId = randomUUID();
    const t0 = new Date("2026-02-01T00:00:00Z");
    const lastRead = new Date(t0.getTime() + 1 * 60_000); // read cursor before the cards (at +2..+4)

    async function insertMsg(o: {
      id: string;
      minute: number;
      seq: number;
      fromId: string;
      source?: string;
    }) {
      await db.insert(schema.messages).values({
        id: o.id,
        workspaceId: wsId,
        channelId,
        fromId: o.fromId,
        fromType: "human",
        fromName: "X",
        text: `msg ${o.id}`,
        seq: o.seq,
        source: o.source ?? null,
        createdAt: new Date(t0.getTime() + o.minute * 60_000),
      });
    }

    beforeAll(async () => {
      db = getDb();
      pg = new PgSync();
      await db.insert(schema.users).values([
        { id: me, email: `wu-me-${me}@e2e.dev`, name: "Me" },
        { id: peer, email: `wu-peer-${peer}@e2e.dev`, name: "Peer" },
      ]);
      await db
        .insert(schema.workspaces)
        .values({ id: wsId, name: "Webhook Unread WS", ownerId: me });
      await db
        .insert(schema.channels)
        .values({ id: channelId, workspaceId: wsId, name: "deployments", createdBy: me });
      await db.insert(schema.channelMembers).values({ channelId, userId: me, memberType: "human" });
      // me created the webhook → the card is injected as fromId=me, source=webhook
      await insertMsg({
        id: `wh-${randomUUID()}`,
        minute: 2,
        seq: 1,
        fromId: me,
        source: "webhook",
      });
      // a genuine own (non-webhook) send by me — must NOT count as unread for me
      await insertMsg({ id: `own-${randomUUID()}`, minute: 3, seq: 2, fromId: me, source: null });
      // a peer message — the normal unread, sanity control
      await insertMsg({
        id: `peer-${randomUUID()}`,
        minute: 4,
        seq: 3,
        fromId: peer,
        source: null,
      });
      await db
        .insert(schema.messageReads)
        .values({ workspaceId: wsId, userId: me, channelId, lastReadAt: lastRead });
    });

    afterAll(async () => {
      await db.delete(schema.messages).where(eq(schema.messages.channelId, channelId));
      await db.delete(schema.messageReads).where(eq(schema.messageReads.channelId, channelId));
      await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, channelId));
      await db.delete(schema.channels).where(eq(schema.channels.id, channelId));
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, wsId));
      await db.delete(schema.users).where(eq(schema.users.id, me));
      await db.delete(schema.users).where(eq(schema.users.id, peer));
    });

    it("counts a webhook card from self + the peer message, but NOT a genuine own send", async () => {
      const counts = await pg.getUnreadCounts(wsId, me);
      // webhook-from-self (1) + peer (1) = 2; the genuine own send is excluded.
      expect(counts[channelId]).toBe(2);
    });
  },
);
