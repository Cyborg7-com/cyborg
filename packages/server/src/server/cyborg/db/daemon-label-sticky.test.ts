import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb, closePool } from "./connection.js";
import * as schema from "./schema.js";
import { PgSync } from "./pg-sync.js";

const hasPg = !!process.env.DATABASE_URL;

// Regression #441: the hello upsert used label = COALESCE(reported, existing),
// so the reported os.hostname() always won. On macOS the hostname is dynamic —
// on networks without reverse-DNS it degrades to the raw IP, and one reconnect
// renamed the daemon to 192.168.x.x for everyone. The label must be sticky:
// keep the existing one unless it's empty, or it's IP-like and the reported
// one isn't; a user-set label (renameDaemon) is never overwritten.
describe.skipIf(!hasPg)("PgSync daemon label stickiness (#441, requires DATABASE_URL)", () => {
  let db: ReturnType<typeof getDb>;
  let pg: PgSync;

  const ownerId = randomUUID();
  const daemonIds: string[] = [];

  function newDaemonId(): string {
    const id = randomUUID();
    daemonIds.push(id);
    return id;
  }

  async function labelOf(id: string): Promise<{ label: string; labelUserSet: boolean }> {
    const [row] = await db
      .select({ label: schema.daemons.label, labelUserSet: schema.daemons.labelUserSet })
      .from(schema.daemons)
      .where(eq(schema.daemons.id, id));
    return row;
  }

  beforeAll(async () => {
    db = getDb();
    pg = new PgSync();
    // The shared dev DB may predate migration 0003 — the column is additive
    // with a default, so ensuring it here is safe and idempotent.
    await db.execute(
      sql`ALTER TABLE daemons ADD COLUMN IF NOT EXISTS label_user_set boolean NOT NULL DEFAULT false`,
    );
    await db
      .insert(schema.users)
      .values({ id: ownerId, email: `lbl-${ownerId}@e2e.dev`, name: "Owner" });
  });

  afterAll(async () => {
    for (const id of daemonIds) {
      await db.delete(schema.daemons).where(eq(schema.daemons.id, id));
    }
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
    await closePool();
  });

  it("first hello sets the reported label", async () => {
    const id = newDaemonId();
    await pg.upsertDaemon(id, ownerId, "Sebs-MacBook.local");
    expect((await labelOf(id)).label).toBe("Sebs-MacBook.local");
  });

  it("a reconnect reporting an IP does NOT overwrite an existing human label", async () => {
    const id = newDaemonId();
    await pg.upsertDaemon(id, ownerId, "Sebs-MacBook.local");
    await pg.upsertDaemon(id, ownerId, "192.168.1.22");
    expect((await labelOf(id)).label).toBe("Sebs-MacBook.local");
  });

  it("a human label recovers a daemon previously stuck on an IP label", async () => {
    const id = newDaemonId();
    await db.insert(schema.daemons).values({ id, ownerId, label: "192.168.1.22" });
    await pg.upsertDaemon(id, ownerId, "Sebs-MacBook.local");
    expect((await labelOf(id)).label).toBe("Sebs-MacBook.local");
  });

  it("an IP label does not replace another IP label (no churn), and fills an empty one", async () => {
    const ipStuck = newDaemonId();
    await db.insert(schema.daemons).values({ id: ipStuck, ownerId, label: "10.0.0.5" });
    await pg.upsertDaemon(ipStuck, ownerId, "192.168.1.22");
    expect((await labelOf(ipStuck)).label).toBe("10.0.0.5");

    const empty = newDaemonId();
    await db.insert(schema.daemons).values({ id: empty, ownerId, label: "" });
    await pg.upsertDaemon(empty, ownerId, "192.168.1.22");
    expect((await labelOf(empty)).label).toBe("192.168.1.22");
  });

  it("renameDaemon sets the sticky flag and hellos never overwrite it again", async () => {
    const id = newDaemonId();
    await pg.upsertDaemon(id, ownerId, "Sebs-MacBook.local");
    await pg.renameDaemon(id, "Seb's daemon");
    expect(await labelOf(id)).toEqual({ label: "Seb's daemon", labelUserSet: true });

    await pg.upsertDaemon(id, ownerId, "Another-Hostname.local");
    await pg.upsertDaemon(id, ownerId, "192.168.1.22");
    expect((await labelOf(id)).label).toBe("Seb's daemon");
  });

  it("meta.host still records the reported hostname even when the label is kept", async () => {
    const id = newDaemonId();
    await pg.upsertDaemon(id, ownerId, "Sebs-MacBook.local", { host: "Sebs-MacBook.local" });
    await pg.upsertDaemon(id, ownerId, "192.168.1.22", { host: "192.168.1.22" });
    const [row] = await db
      .select({ label: schema.daemons.label, meta: schema.daemons.meta })
      .from(schema.daemons)
      .where(eq(schema.daemons.id, id));
    expect(row.label).toBe("Sebs-MacBook.local");
    expect(row.meta?.host).toBe("192.168.1.22");
  });
});
