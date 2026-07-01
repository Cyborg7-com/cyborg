import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb, closePool } from "./connection.js";
import * as schema from "./schema.js";
import { PgSync } from "./pg-sync.js";

const hasPg = !!process.env.DATABASE_URL;

// Tenant-isolation regression (Slack bridge): a Slack ts (external_id) is unique
// per-channel, NOT globally, so the SAME ts can legitimately exist in two
// different workspaces. The reverse lookup getMessageIntegrationByExternal MUST
// scope by workspaceId — the unique index is (provider, external_id, workspace_id).
// Resolving by (provider, externalId) alone would return a non-deterministic,
// possibly wrong-tenant row and let an inbound edit/delete/reaction land on
// another workspace's message. These lock the 3-arg WHERE.
describe.skipIf(!hasPg)(
  "PgSync.getMessageIntegrationByExternal workspace scope (requires DATABASE_URL)",
  () => {
    let db: ReturnType<typeof getDb>;
    let pg: PgSync;

    const ownerId = randomUUID();
    const wsA = randomUUID();
    const wsB = randomUUID();
    const wsC = randomUUID(); // never receives a mapping for `ts`
    const chanA = randomUUID();
    const chanB = randomUUID();
    const msgA = randomUUID();
    const msgB = randomUUID();
    // The same Slack ts, colliding across the two workspaces on purpose.
    const ts = "1700000000.000100";

    beforeAll(async () => {
      db = getDb();
      pg = new PgSync();
      await db
        .insert(schema.users)
        .values({ id: ownerId, email: `mi-scope-${ownerId}@e2e.dev`, name: "Owner" });
      await db.insert(schema.workspaces).values([
        { id: wsA, name: "MI Scope WS A", ownerId },
        { id: wsB, name: "MI Scope WS B", ownerId },
        { id: wsC, name: "MI Scope WS C", ownerId },
      ]);
      await db.insert(schema.channels).values([
        { id: chanA, workspaceId: wsA, name: "scope-a", createdBy: ownerId },
        { id: chanB, workspaceId: wsB, name: "scope-b", createdBy: ownerId },
      ]);
      await db.insert(schema.messages).values([
        {
          id: msgA,
          workspaceId: wsA,
          channelId: chanA,
          fromId: ownerId,
          fromType: "user",
          text: "hello from A",
          seq: 1,
        },
        {
          id: msgB,
          workspaceId: wsB,
          channelId: chanB,
          fromId: ownerId,
          fromType: "user",
          text: "hello from B",
          seq: 1,
        },
      ]);
      // Two rows sharing (provider='slack', external_id=ts) but in DIFFERENT
      // workspaces — allowed by the (provider, external_id, workspace_id) unique
      // index, each pointing at that workspace's own message.
      await db.insert(schema.messageIntegrations).values([
        { messageId: msgA, workspaceId: wsA, provider: "slack", externalId: ts },
        { messageId: msgB, workspaceId: wsB, provider: "slack", externalId: ts },
      ]);
    });

    afterAll(async () => {
      await db
        .delete(schema.messageIntegrations)
        .where(inArray(schema.messageIntegrations.messageId, [msgA, msgB]));
      await db.delete(schema.messages).where(inArray(schema.messages.id, [msgA, msgB]));
      await db.delete(schema.channels).where(inArray(schema.channels.id, [chanA, chanB]));
      await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, [wsA, wsB, wsC]));
      await db.delete(schema.users).where(eq(schema.users.id, ownerId));
      await closePool();
    });

    it("resolves the ts to workspace A's own message", async () => {
      const row = await pg.getMessageIntegrationByExternal("slack", ts, wsA);
      expect(row?.messageId).toBe(msgA);
    });

    it("resolves the same ts to workspace B's own message", async () => {
      const row = await pg.getMessageIntegrationByExternal("slack", ts, wsB);
      expect(row?.messageId).toBe(msgB);
    });

    it("returns null for a workspace that has no mapping for that ts", async () => {
      expect(await pg.getMessageIntegrationByExternal("slack", ts, wsC)).toBeNull();
    });
  },
);
