import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb } from "./connection.js";
import * as schema from "./schema.js";
import { PgSync } from "./pg-sync.js";

const hasPg = !!process.env.DATABASE_URL;

// PG-gated (#705): exercises the scope-aware daemon_access layer against a real
// Postgres. SKIPS cleanly with no DATABASE_URL (run via the dev RDS tunnel in
// review). Mirrors webhook-unread.test.ts's describe.skipIf + setup/teardown.
//
// Locks: the migration default ['admin'] for pre-existing rows; getUserDaemonScopes
// / setDaemonAccess round-trip; owner ⇒ all scopes; empty set revokes; the
// null-column back-compat fail-safe (treated as admin).
describe.skipIf(!hasPg)("PgSync daemon access scopes (requires DATABASE_URL)", () => {
  let db: ReturnType<typeof getDb>;
  let pg: PgSync;

  const owner = randomUUID();
  const peer = randomUUID();
  const wsId = randomUUID();
  const daemonId = randomUUID();

  beforeAll(async () => {
    db = getDb();
    pg = new PgSync();
    // The shared dev DB may predate migration 0005 — the column is additive with
    // a default, so ensuring it here is safe + idempotent (mirrors the migration
    // and daemon-label-sticky.test.ts's defensive column-ensure).
    await db.execute(
      sql`ALTER TABLE daemon_access ADD COLUMN IF NOT EXISTS scopes text[] NOT NULL DEFAULT '{"admin"}'`,
    );
    await db.insert(schema.users).values([
      { id: owner, email: `das-owner-${owner}@e2e.dev`, name: "Owner" },
      { id: peer, email: `das-peer-${peer}@e2e.dev`, name: "Peer" },
    ]);
    await db
      .insert(schema.workspaces)
      .values({ id: wsId, name: "Daemon Scopes WS", ownerId: owner });
    await db.insert(schema.daemons).values({
      id: daemonId,
      ownerId: owner,
      label: "scopes-daemon",
      status: "offline",
    });
  });

  beforeEach(async () => {
    // Each test starts from a clean access table for this daemon.
    await db.delete(schema.daemonAccess).where(eq(schema.daemonAccess.daemonId, daemonId));
  });

  afterAll(async () => {
    await db.delete(schema.daemonAccess).where(eq(schema.daemonAccess.daemonId, daemonId));
    await db.delete(schema.daemons).where(eq(schema.daemons.id, daemonId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, wsId));
    await db.delete(schema.users).where(eq(schema.users.id, owner));
    await db.delete(schema.users).where(eq(schema.users.id, peer));
  });

  it("migration: a row inserted WITHOUT scopes defaults to ['admin']", async () => {
    // Simulate a pre-existing / legacy grant: insert leaving `scopes` to the DB
    // DEFAULT. This is exactly how every row that existed before the migration is
    // backfilled — it must read back as ['admin'] (total access preserved).
    await db
      .insert(schema.daemonAccess)
      .values({ workspaceId: wsId, daemonId, userId: peer, grantedBy: owner });
    const [row] = await db
      .select({ scopes: schema.daemonAccess.scopes })
      .from(schema.daemonAccess)
      .where(eq(schema.daemonAccess.userId, peer));
    expect(row?.scopes).toEqual(["admin"]);

    const scopes = await pg.getUserDaemonScopes(wsId, daemonId, peer);
    expect([...scopes]).toEqual(["admin"]);
    expect(await pg.canUserAccessDaemon(wsId, daemonId, peer)).toBe(true);
  });

  it("owner ⇒ ALL scopes (implicit admin), even with no row", async () => {
    const scopes = await pg.getUserDaemonScopes(wsId, daemonId, owner);
    expect([...scopes].sort()).toEqual(["admin", "chat", "spawn", "terminal"]);
    expect(await pg.canUserAccessDaemon(wsId, daemonId, owner)).toBe(true);
  });

  it("no row + not owner ⇒ empty scope set (no access)", async () => {
    const scopes = await pg.getUserDaemonScopes(wsId, daemonId, peer);
    expect(scopes.size).toBe(0);
    expect(await pg.canUserAccessDaemon(wsId, daemonId, peer)).toBe(false);
  });

  it("setDaemonAccess round-trip: set chat+spawn, read it back exactly", async () => {
    await pg.setDaemonAccess(wsId, daemonId, peer, ["chat", "spawn"], owner);
    const scopes = await pg.getUserDaemonScopes(wsId, daemonId, peer);
    expect([...scopes].sort()).toEqual(["chat", "spawn"]);

    // The gate semantics this enables: can spawn, canNOT open a terminal.
    const access = await pg.getDaemonAccessForWorkspace(wsId);
    const entry = access.find((a) => a.userId === peer);
    expect(entry?.scopes.sort()).toEqual(["chat", "spawn"]);
  });

  it("setDaemonAccess is idempotent + overwrites (not merge)", async () => {
    await pg.setDaemonAccess(wsId, daemonId, peer, ["chat", "spawn", "terminal"], owner);
    await pg.setDaemonAccess(wsId, daemonId, peer, ["chat"], owner);
    const scopes = await pg.getUserDaemonScopes(wsId, daemonId, peer);
    expect([...scopes]).toEqual(["chat"]); // replaced, not unioned
  });

  it("setDaemonAccess drops unknown scope strings", async () => {
    await pg.setDaemonAccess(wsId, daemonId, peer, ["chat", "bogus", "terminal"], owner);
    const scopes = await pg.getUserDaemonScopes(wsId, daemonId, peer);
    expect([...scopes].sort()).toEqual(["chat", "terminal"]);
  });

  it("setDaemonAccess with empty array REVOKES (deletes the row)", async () => {
    await pg.setDaemonAccess(wsId, daemonId, peer, ["admin"], owner);
    expect(await pg.canUserAccessDaemon(wsId, daemonId, peer)).toBe(true);
    await pg.setDaemonAccess(wsId, daemonId, peer, [], owner);
    const [row] = await db
      .select({ userId: schema.daemonAccess.userId })
      .from(schema.daemonAccess)
      .where(eq(schema.daemonAccess.userId, peer));
    expect(row).toBeUndefined();
    expect(await pg.canUserAccessDaemon(wsId, daemonId, peer)).toBe(false);
  });

  it("legacy grant shim maps to ['admin']", async () => {
    await pg.grantDaemonAccess(wsId, daemonId, peer, owner);
    const scopes = await pg.getUserDaemonScopes(wsId, daemonId, peer);
    expect([...scopes]).toEqual(["admin"]);
  });

  it("the scopes column is NOT NULL — a row can never go NULL", async () => {
    // The column is `text[] NOT NULL DEFAULT '{admin}'`, so NULL is impossible at
    // the DB level: existing rows were backfilled to {admin} by the default, and
    // an old relay that INSERTs without scopes also gets the {admin} default.
    // Proving the constraint rejects NULL documents that guarantee (and is why the
    // normalizeScopes(null) branch is a defensive fail-safe for non-DB inputs, not
    // a reachable DB state).
    await db
      .insert(schema.daemonAccess)
      .values({ workspaceId: wsId, daemonId, userId: peer, grantedBy: owner });
    await expect(
      db.execute(
        sql`UPDATE daemon_access SET scopes = NULL WHERE daemon_id = ${daemonId} AND user_id = ${peer}`,
      ),
    ).rejects.toThrow();
  });

  it("back-compat: an empty scopes set fail-safes to admin (not no-access)", async () => {
    // An empty array IS a permitted DB state (unlike NULL). The read path coerces
    // it to admin — a grant row that somehow lost its scopes must not silently
    // become a lockout. (No-access is represented by the ROW NOT EXISTING.)
    await db
      .insert(schema.daemonAccess)
      .values({ workspaceId: wsId, daemonId, userId: peer, grantedBy: owner });
    await db.execute(
      sql`UPDATE daemon_access SET scopes = '{}'::text[] WHERE daemon_id = ${daemonId} AND user_id = ${peer}`,
    );
    const scopes = await pg.getUserDaemonScopes(wsId, daemonId, peer);
    expect([...scopes]).toEqual(["admin"]);
  });
});
