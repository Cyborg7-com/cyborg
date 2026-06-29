import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb, closePool } from "./connection.js";
import * as schema from "./schema.js";
import { PgSync } from "./pg-sync.js";

const hasPg = !!process.env.DATABASE_URL;

// Authorization for cyborg:set_daemon_workspace (relay-standalone): the caller
// must own the daemon AND be a member of the target workspace. The membership
// requirement is the security boundary — without it, a daemon owner could
// subscribe their daemon to ANY workspace's traffic (cross-tenant leak).
describe.skipIf(!hasPg)("PgSync.canManageDaemonWorkspace (requires DATABASE_URL)", () => {
  // Lazy — getDb() throws without DATABASE_URL, so don't touch it at collect time.
  let db: ReturnType<typeof getDb>;
  let pg: PgSync;

  const ownerId = randomUUID();
  const strangerId = randomUUID();
  const daemonId = randomUUID();
  const ownWsId = randomUUID();
  const foreignWsId = randomUUID();

  beforeAll(async () => {
    db = getDb();
    pg = new PgSync();
    await db.insert(schema.users).values([
      { id: ownerId, email: `dw-owner-${ownerId}@e2e.dev`, name: "Daemon Owner" },
      { id: strangerId, email: `dw-stranger-${strangerId}@e2e.dev`, name: "Stranger" },
    ]);
    await db.insert(schema.workspaces).values([
      { id: ownWsId, name: "Owner WS", ownerId },
      // A workspace the daemon owner does NOT belong to.
      { id: foreignWsId, name: "Foreign WS", ownerId: strangerId },
    ]);
    await db.insert(schema.memberships).values([
      { workspaceId: ownWsId, userId: ownerId, role: "owner" },
      { workspaceId: foreignWsId, userId: strangerId, role: "owner" },
    ]);
    await db.insert(schema.daemons).values({ id: daemonId, ownerId, label: "test-daemon" });
  });

  afterAll(async () => {
    await db.delete(schema.workspaceDaemons).where(eq(schema.workspaceDaemons.daemonId, daemonId));
    await db.delete(schema.daemons).where(eq(schema.daemons.id, daemonId));
    await db
      .delete(schema.memberships)
      .where(inArray(schema.memberships.workspaceId, [ownWsId, foreignWsId]));
    await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, [ownWsId, foreignWsId]));
    await db.delete(schema.users).where(inArray(schema.users.id, [ownerId, strangerId]));
    await closePool();
  });

  it("denies a caller who does not own the daemon", async () => {
    expect(await pg.canManageDaemonWorkspace(strangerId, daemonId, foreignWsId)).toBe("not_owner");
  });

  it("denies the daemon owner targeting a workspace they are not a member of", async () => {
    expect(await pg.canManageDaemonWorkspace(ownerId, daemonId, foreignWsId)).toBe("not_member");
  });

  it("allows the daemon owner targeting their own workspace", async () => {
    expect(await pg.canManageDaemonWorkspace(ownerId, daemonId, ownWsId)).toBe("ok");
  });
});
