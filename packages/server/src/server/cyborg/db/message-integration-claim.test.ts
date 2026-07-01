import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb, closePool } from "./connection.js";
import * as schema from "./schema.js";
import { PgSync } from "./pg-sync.js";

const hasPg = !!process.env.DATABASE_URL;

// Outbound-mirror claim (Slack bridge): claimMessageIntegration is an ATOMIC
// reservation (INSERT … ON CONFLICT (message_id) DO NOTHING) taken BEFORE the
// network post so two concurrent re-broadcasts of the same Cyborg message can't
// both post to Slack. The claim writes a PER-MESSAGE pending sentinel
// (`pending:<messageId>`) as external_id — a shared placeholder would collide on
// the (provider, external_id, workspace_id) unique index across concurrent claims
// in the same workspace. upsert fills the real ts post-send; delete releases a
// failed claim so a later re-broadcast can retry.
describe.skipIf(!hasPg)("PgSync.claimMessageIntegration (requires DATABASE_URL)", () => {
  let db: ReturnType<typeof getDb>;
  let pg: PgSync;

  const ownerId = randomUUID();
  const wsId = randomUUID();
  const chanId = randomUUID();
  const m1 = randomUUID();
  const m2 = randomUUID();
  const provider = "slack";

  beforeAll(async () => {
    db = getDb();
    pg = new PgSync();
    await db
      .insert(schema.users)
      .values({ id: ownerId, email: `mi-claim-${ownerId}@e2e.dev`, name: "Owner" });
    await db.insert(schema.workspaces).values({ id: wsId, name: "MI Claim WS", ownerId });
    await db
      .insert(schema.channels)
      .values({ id: chanId, workspaceId: wsId, name: "claim", createdBy: ownerId });
    await db.insert(schema.messages).values([
      {
        id: m1,
        workspaceId: wsId,
        channelId: chanId,
        fromId: ownerId,
        fromType: "user",
        text: "claim me 1",
        seq: 1,
      },
      {
        id: m2,
        workspaceId: wsId,
        channelId: chanId,
        fromId: ownerId,
        fromType: "user",
        text: "claim me 2",
        seq: 2,
      },
    ]);
  });

  afterAll(async () => {
    await db
      .delete(schema.messageIntegrations)
      .where(inArray(schema.messageIntegrations.messageId, [m1, m2]));
    await db.delete(schema.messages).where(inArray(schema.messages.id, [m1, m2]));
    await db.delete(schema.channels).where(eq(schema.channels.id, chanId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, wsId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
    await closePool();
  });

  it("first claim wins, a concurrent second claim is a no-op", async () => {
    expect(await pg.claimMessageIntegration({ messageId: m1, workspaceId: wsId, provider })).toBe(
      true,
    );
    expect(await pg.claimMessageIntegration({ messageId: m1, workspaceId: wsId, provider })).toBe(
      false,
    );
  });

  it("writes the per-message pending sentinel as external_id", async () => {
    const row = await pg.getMessageIntegrationByMessageId(m1);
    expect(row?.externalId).toBe(`pending:${m1}`);
  });

  it("upsert replaces the sentinel with the real Slack ts", async () => {
    const ts = "1700000001.000200";
    await pg.upsertMessageIntegration({
      messageId: m1,
      workspaceId: wsId,
      provider,
      externalId: ts,
    });
    const row = await pg.getMessageIntegrationByMessageId(m1);
    expect(row?.externalId).toBe(ts);
  });

  it("delete releases the claim so a re-claim succeeds", async () => {
    await pg.deleteMessageIntegration(m1);
    expect(await pg.getMessageIntegrationByMessageId(m1)).toBeNull();
    expect(await pg.claimMessageIntegration({ messageId: m1, workspaceId: wsId, provider })).toBe(
      true,
    );
  });

  it("two distinct messages in the same workspace both claim (no pending-sentinel collision)", async () => {
    // m1 is claimed above with sentinel `pending:<m1>`. Claiming m2 in the SAME
    // workspace must also succeed: the sentinel is per-message, so the two pending
    // rows have distinct external_ids and the (provider, external_id, workspace_id)
    // unique index does not fire.
    expect(await pg.claimMessageIntegration({ messageId: m2, workspaceId: wsId, provider })).toBe(
      true,
    );
    const [r1, r2] = await Promise.all([
      pg.getMessageIntegrationByMessageId(m1),
      pg.getMessageIntegrationByMessageId(m2),
    ]);
    expect(r1?.externalId).toBe(`pending:${m1}`);
    expect(r2?.externalId).toBe(`pending:${m2}`);
  });
});
