import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "./connection.js";
import * as schema from "./schema.js";
import { PgSync } from "./pg-sync.js";

const hasPg = !!process.env.DATABASE_URL;

// Webhook-triggered cybo runs (#620, scheduler phase 3) add two NULLABLE columns
// to `webhooks`: trigger_cybo_id + prompt_template (migration 0006, additive +
// idempotent). This locks the migration's back-compat contract against a real DB:
//   - a webhook created WITHOUT trigger columns reads back NULL/NULL → card-only,
//     exactly today's behavior (no regression for existing rows);
//   - a webhook WITH the trigger columns round-trips through the receive getter
//     (getActiveWebhookForChannel) so the route can read the trigger + template.
describe.skipIf(!hasPg)("PgSync webhook cybo-trigger columns (requires DATABASE_URL)", () => {
  let db: ReturnType<typeof getDb>;
  let pg: PgSync;

  const owner = randomUUID();
  const wsId = randomUUID();
  const channelId = randomUUID();
  const cyboId = randomUUID();
  // The card-only (legacy-shaped) webhook + the trigger-configured webhook.
  const cardOnlyId = randomUUID();
  const triggerId = randomUUID();

  beforeAll(async () => {
    db = getDb();
    pg = new PgSync();
    await db.insert(schema.users).values({ id: owner, email: `wt-${owner}@e2e.dev`, name: "O" });
    await db.insert(schema.workspaces).values({ id: wsId, name: "Trigger WS", ownerId: owner });
    await db
      .insert(schema.channels)
      .values({ id: channelId, workspaceId: wsId, name: "releases", createdBy: owner });

    // A webhook created via the normal CRUD path (no trigger fields) — proves the
    // columns are absent → NULL → card-only for every pre-existing row.
    await pg.createWebhook({
      id: cardOnlyId,
      channelId,
      workspaceId: wsId,
      name: "Card only",
      secret: "s1",
      eventMode: "all",
      createdBy: owner,
    });

    // A webhook WITH the trigger columns set (direct insert — the CRUD setter is
    // a follow-up UI concern; the migration + read path is what phase-3 needs).
    // Deactivate the card-only one first so getActiveWebhookForChannel (latest
    // active) returns the trigger row deterministically.
    await db
      .update(schema.webhooks)
      .set({ active: false })
      .where(eq(schema.webhooks.id, cardOnlyId));
    await db.insert(schema.webhooks).values({
      id: triggerId,
      channelId,
      workspaceId: wsId,
      name: "Release trigger",
      secret: "s2",
      eventMode: "all",
      active: true,
      triggerCyboId: cyboId,
      promptTemplate: "Release {{release.tag_name}} — post notes.",
      createdBy: owner,
    });
  });

  afterAll(async () => {
    await db.delete(schema.webhooks).where(eq(schema.webhooks.channelId, channelId));
    await db.delete(schema.channels).where(eq(schema.channels.id, channelId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, wsId));
    await db.delete(schema.users).where(eq(schema.users.id, owner));
  });

  it("a webhook created without trigger fields defaults to NULL (card-only)", async () => {
    const [row] = await db
      .select({ trigger: schema.webhooks.triggerCyboId, tmpl: schema.webhooks.promptTemplate })
      .from(schema.webhooks)
      .where(eq(schema.webhooks.id, cardOnlyId));
    expect(row.trigger).toBeNull();
    expect(row.tmpl).toBeNull();
  });

  it("getActiveWebhookForChannel carries the trigger cybo + template for a configured row", async () => {
    const wh = await pg.getActiveWebhookForChannel(channelId);
    expect(wh).not.toBeNull();
    expect(wh?.id).toBe(triggerId);
    expect(wh?.triggerCyboId).toBe(cyboId);
    expect(wh?.promptTemplate).toBe("Release {{release.tag_name}} — post notes.");
  });
});
