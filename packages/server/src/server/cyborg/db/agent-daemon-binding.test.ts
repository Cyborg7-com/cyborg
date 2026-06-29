import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb, closePool } from "./connection.js";
import * as schema from "./schema.js";
import { PgSync } from "./pg-sync.js";

const hasPg = !!process.env.DATABASE_URL;

// Regression (#agent-session-reload): the relay resolves the daemon that OWNS
// an agent via getAgentDaemonId before forwarding agent-scoped RPCs
// (fetch_agent_timeline, set_agent_model, …). Without that resolution, multi-
// daemon workspaces delivered those RPCs to an arbitrary subscriber, which
// answered "Agent not found in workspace" — blank session history after a
// reload and model switches that never applied.
describe.skipIf(!hasPg)("PgSync.getAgentDaemonId (requires DATABASE_URL)", () => {
  let db: ReturnType<typeof getDb>;
  let pg: PgSync;

  const ownerId = randomUUID();
  const wsId = randomUUID();
  const otherWsId = randomUUID();
  const daemonId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    db = getDb();
    pg = new PgSync();
    await db
      .insert(schema.users)
      .values({ id: ownerId, email: `adb-${ownerId}@e2e.dev`, name: "Owner" });
    await db.insert(schema.workspaces).values([
      { id: wsId, name: "Binding WS", ownerId },
      { id: otherWsId, name: "Other WS", ownerId },
    ]);
    await db.insert(schema.daemons).values({ id: daemonId, ownerId, label: "binding-daemon" });
    await db
      .insert(schema.daemonAgents)
      .values({ daemonId, agentId, workspaceId: wsId, provider: "pi" });
  });

  afterAll(async () => {
    await db.delete(schema.daemonAgents).where(eq(schema.daemonAgents.agentId, agentId));
    await db.delete(schema.daemons).where(eq(schema.daemons.id, daemonId));
    await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, [wsId, otherWsId]));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
    await closePool();
  });

  it("resolves the owning daemon for a bound agent", async () => {
    expect(await pg.getAgentDaemonId(agentId, wsId)).toBe(daemonId);
  });

  it("returns null when the agent is bound in a different workspace", async () => {
    expect(await pg.getAgentDaemonId(agentId, otherWsId)).toBeNull();
  });

  it("returns null for an unknown agent", async () => {
    expect(await pg.getAgentDaemonId(randomUUID(), wsId)).toBeNull();
  });
});
