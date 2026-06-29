import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { getDb, closePool } from "./connection.js";
import * as schema from "./schema.js";
import { PgSync } from "./pg-sync.js";

const hasPg = !!process.env.DATABASE_URL;

// #604 DND/away push gating: dispatchPush drops recipients who are manually away
// or in an unexpired Do-Not-Disturb window, BEFORE both push arms. This proves
// the query that decides who gets suppressed.
describe.skipIf(!hasPg)("PgSync.getPushSuppressedUserIds (#604, requires DATABASE_URL)", () => {
  let db: ReturnType<typeof getDb>;
  let pg: PgSync;

  const now = new Date("2026-06-14T12:00:00Z");
  const dndActive = randomUUID(); // dnd_until in the future → suppressed
  const dndExpired = randomUUID(); // dnd_until in the past → NOT suppressed
  const away = randomUUID(); // is_away → suppressed
  const normal = randomUUID(); // present, no away/dnd → NOT suppressed
  const noRow = randomUUID(); // no presence row at all → NOT suppressed
  const all = [dndActive, dndExpired, away, normal, noRow];

  beforeAll(async () => {
    db = getDb();
    pg = new PgSync();
    await db
      .insert(schema.users)
      .values(all.map((id) => ({ id, email: `dnd-${id}@e2e.dev`, name: "U" })));
    await db.insert(schema.userPresence).values([
      { userId: dndActive, isAway: false, dndUntil: new Date(now.getTime() + 60 * 60_000) },
      { userId: dndExpired, isAway: false, dndUntil: new Date(now.getTime() - 60 * 60_000) },
      { userId: away, isAway: true, dndUntil: null },
      { userId: normal, isAway: false, dndUntil: null },
      // noRow: intentionally no user_presence row.
    ]);
  });

  afterAll(async () => {
    await db.delete(schema.userPresence).where(inArray(schema.userPresence.userId, all));
    await db.delete(schema.users).where(inArray(schema.users.id, all));
    await closePool();
  });

  it("suppresses only active-DND and manually-away users", async () => {
    const suppressed = await pg.getPushSuppressedUserIds(all, now);
    expect(suppressed.has(dndActive)).toBe(true);
    expect(suppressed.has(away)).toBe(true);
    // expired DND, normal, and no-presence-row users keep getting push
    expect(suppressed.has(dndExpired)).toBe(false);
    expect(suppressed.has(normal)).toBe(false);
    expect(suppressed.has(noRow)).toBe(false);
    expect(suppressed.size).toBe(2);
  });

  it("only considers the ids it was asked about", async () => {
    const suppressed = await pg.getPushSuppressedUserIds([normal, dndExpired], now);
    expect(suppressed.size).toBe(0);
  });

  it("returns an empty set for an empty input (no query)", async () => {
    expect((await pg.getPushSuppressedUserIds([], now)).size).toBe(0);
  });

  it("unions matches across IN-list chunks (>1000 ids)", async () => {
    // Bury the two suppressed ids in different 1000-id chunks (the rest are
    // random non-existent ids — they simply don't match, no inserts needed).
    const padding = Array.from({ length: 1100 }, () => randomUUID());
    padding[5] = dndActive; // chunk 0
    padding[1050] = away; // chunk 1
    const suppressed = await pg.getPushSuppressedUserIds(padding, now);
    expect(suppressed.has(dndActive)).toBe(true);
    expect(suppressed.has(away)).toBe(true);
    expect(suppressed.size).toBe(2);
  });

  it("DND expiry is evaluated against the passed `now` (boundary)", async () => {
    // At a time AFTER dndActive's window, that user is no longer suppressed.
    const later = new Date(now.getTime() + 2 * 60 * 60_000);
    const suppressed = await pg.getPushSuppressedUserIds(all, later);
    expect(suppressed.has(dndActive)).toBe(false);
    // away has no expiry → still suppressed regardless of time.
    expect(suppressed.has(away)).toBe(true);
  });
});
