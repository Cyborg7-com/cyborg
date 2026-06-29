import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb, closePool } from "./db/connection.js";
import * as schema from "./db/schema.js";
import { PgSync } from "./db/pg-sync.js";
import type { StoredScheduledMessage } from "./storage.js";

const hasPg = !!process.env.DATABASE_URL;

// PG-gated end-to-end claim+fire semantics for user "send later" (#607). Proves the
// scheduled_messages mirror round-trips through PgSync AND the relay's atomic claim
// (claimDueScheduledMessages) gives the exactly-once guarantee: a due row is claimed
// once (processed_at stamped), a second claim does NOT re-hand it, a future row is
// never claimed, and a post-claim failure records error_code while staying processed
// (shown, not dropped). Mirrors db/schedule-runs-mirror.test.ts.
//
// IDEMPOTENT against a SHARED dev DB: every inserted scheduled_messages row is
// deleted by id in afterEach; the prerequisite user/workspace/membership/channel
// rows use unique UUIDs and are deleted in afterAll. Running this file TWICE in a
// row stays green. Skips cleanly when DATABASE_URL is unset.
describe.skipIf(!hasPg)(
  "PgSync scheduled_messages claim+fire (#607, requires DATABASE_URL)",
  () => {
    let db: ReturnType<typeof getDb>;
    let pg: PgSync;

    const ownerId = `user_${randomUUID()}`;
    const wsId = `ws_${randomUUID()}`;
    const channelId = `ch_${randomUUID()}`;
    // Every scheduled_messages id created in a test is tracked here and deleted
    // after that test, so the shared table is left exactly as we found it.
    const msgIds: string[] = [];

    beforeAll(async () => {
      db = getDb();
      pg = new PgSync();

      // The shared dev DB may predate migration 0009 — this CREATE is additive +
      // idempotent (matches the migration's own IF NOT EXISTS), keeping the test
      // self-contained without forcing a migrate step first.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS "scheduled_messages" (
        "id" text PRIMARY KEY NOT NULL,
        "workspace_id" text NOT NULL,
        "channel_id" text,
        "to_id" text,
        "from_id" text NOT NULL,
        "text" text NOT NULL,
        "mentions" jsonb,
        "send_at" timestamp with time zone NOT NULL,
        "processed_at" timestamp with time zone,
        "error_code" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      )`);

      // Prerequisite rows (unique UUIDs so they can't collide with prod data).
      await db
        .insert(schema.users)
        .values({ id: ownerId, email: `sm-${ownerId}@e2e.dev`, name: "O" });
      await db.insert(schema.workspaces).values({ id: wsId, name: "SM", ownerId });
      await db
        .insert(schema.memberships)
        .values({ workspaceId: wsId, userId: ownerId, role: "owner" });
      await db
        .insert(schema.channels)
        .values({ id: channelId, workspaceId: wsId, name: "later", createdBy: ownerId });
    });

    afterEach(async () => {
      // Delete every scheduled_messages row this test inserted, by id.
      if (msgIds.length > 0) {
        await db
          .delete(schema.scheduledMessages)
          .where(inArray(schema.scheduledMessages.id, msgIds));
        msgIds.length = 0;
      }
    });

    afterAll(async () => {
      // Belt-and-suspenders: clear any scheduled_messages still bound to our ws,
      // then the prerequisite rows. Order respects FKs (children → parents).
      await db
        .delete(schema.scheduledMessages)
        .where(eq(schema.scheduledMessages.workspaceId, wsId));
      await db.delete(schema.channels).where(eq(schema.channels.id, channelId));
      await db.delete(schema.memberships).where(eq(schema.memberships.workspaceId, wsId));
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, wsId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerId));
      await closePool();
    });

    // Build a StoredScheduledMessage and insert it via PgSync (the mirror write
    // path), tracking its id for cleanup. Defaults to a channel post.
    async function insert(
      over: Partial<StoredScheduledMessage> & { send_at: number },
    ): Promise<StoredScheduledMessage> {
      const id = over.id ?? `schedmsg_${randomUUID()}`;
      msgIds.push(id);
      const row: StoredScheduledMessage = {
        id,
        workspace_id: wsId,
        channel_id: channelId,
        to_id: null,
        from_id: ownerId,
        text: "scheduled",
        mentions: null,
        processed_at: null,
        error_code: null,
        created_at: Date.now(),
        ...over,
      };
      await pg.createScheduledMessage(row);
      return row;
    }

    it("createScheduledMessage then list/get round-trips the row", async () => {
      const row = await insert({
        send_at: Date.now() + 60_000,
        text: "hi later",
        mentions: JSON.stringify(["user_a"]),
      });

      const list = await pg.listScheduledMessages(wsId, ownerId);
      expect(list.find((r) => r.id === row.id)).toBeDefined();

      const got = await pg.getScheduledMessage(row.id);
      expect(got).toBeDefined();
      expect(got!.text).toBe("hi later");
      expect(got!.channel_id).toBe(channelId);
      expect(got!.from_id).toBe(ownerId);
      expect(got!.send_at).toBe(row.send_at);
      expect(got!.processed_at).toBeNull();
      // mentions round-trip as a JSON string (jsonb → string[] → JSON string).
      expect(JSON.parse(got!.mentions!)).toEqual(["user_a"]);
    });

    it("claimDueScheduledMessages claims a past-due row once and stamps processed_at", async () => {
      const NOW = Date.now();
      const row = await insert({ send_at: NOW - 60_000 });

      const claimed = await pg.claimDueScheduledMessages(NOW);
      expect(claimed.map((r) => r.id)).toContain(row.id);
      // The returned row reflects the claim …
      const justClaimed = claimed.find((r) => r.id === row.id)!;
      expect(justClaimed.processed_at).not.toBeNull();
      // … and a re-fetch confirms processed_at was persisted.
      expect((await pg.getScheduledMessage(row.id))!.processed_at).not.toBeNull();

      // A SECOND claim at the same instant must NOT re-hand this row (no double-send).
      const again = await pg.claimDueScheduledMessages(NOW);
      expect(again.map((r) => r.id)).not.toContain(row.id);
    });

    it("claimDueScheduledMessages does NOT claim a future row; it stays pending", async () => {
      const NOW = Date.now();
      const row = await insert({ send_at: NOW + 60_000 });

      const claimed = await pg.claimDueScheduledMessages(NOW);
      expect(claimed.map((r) => r.id)).not.toContain(row.id);
      expect((await pg.getScheduledMessage(row.id))!.processed_at).toBeNull();
    });

    it("a post-claim failure records error_code while the row stays processed (shown, not dropped)", async () => {
      const NOW = Date.now();
      const row = await insert({ send_at: NOW - 60_000 });

      // The relay claims the row (stamps processed_at) …
      const claimed = await pg.claimDueScheduledMessages(NOW);
      expect(claimed.map((r) => r.id)).toContain(row.id);
      // … then the send fails → it overwrites error_code on the claimed row.
      await pg.setScheduledMessageError(row.id, "channel_archived");

      const after = await pg.getScheduledMessage(row.id)!;
      expect(after!.error_code).toBe("channel_archived");
      // Still processed — a failed scheduled send is shown with its reason, never
      // resurrected into a retry loop.
      expect(after!.processed_at).not.toBeNull();
    });
  },
);
