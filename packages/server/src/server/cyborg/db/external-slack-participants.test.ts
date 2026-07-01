import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, closePool } from "./connection.js";
import * as schema from "./schema.js";
import { PgSync } from "./pg-sync.js";

const hasPg = !!process.env.DATABASE_URL;

// External Slack guests (id `slack:<team>:<user>`) post into a workspace's channels
// but never get a membership row (seat-safe). getExternalSlackParticipants surfaces
// their users-row name + avatar for the profile panel WITHOUT counting them as
// members/seats, while getMembers (INNER JOIN memberships) keeps excluding them.
describe.skipIf(!hasPg)("PgSync getExternalSlackParticipants (requires DATABASE_URL)", () => {
  let db: ReturnType<typeof getDb>;
  let pg: PgSync;

  const ownerId = randomUUID();
  const wsId = randomUUID();
  const chanId = randomUUID();
  // Deterministic synthetic Slack guest id (slack:<team>:<user>).
  const slackId = `slack:T1:U1-${randomUUID()}`;
  const msgId1 = randomUUID();
  const msgId2 = randomUUID();

  beforeAll(async () => {
    db = getDb();
    pg = new PgSync();
    // Real owner user + workspace + owner membership + a channel.
    await db
      .insert(schema.users)
      .values({ id: ownerId, email: `slack-ext-${ownerId}@e2e.dev`, name: "Owner" });
    await db.insert(schema.workspaces).values({ id: wsId, name: "Slack Ext WS", ownerId });
    await pg.addMember(wsId, ownerId, "owner");
    await db
      .insert(schema.channels)
      .values({ id: chanId, workspaceId: wsId, name: "general", createdBy: ownerId });

    // Synthetic external Slack guest — users row only, NO membership.
    await pg.upsertSyntheticUser(
      slackId,
      "slack_T1_U1@remote.local",
      "Alice Slack",
      "https://img/alice.png",
    );

    // Two messages from the SAME slack guest to prove distinct collapses them.
    await db.insert(schema.messages).values({
      id: msgId1,
      workspaceId: wsId,
      channelId: chanId,
      fromId: slackId,
      fromType: "human",
      text: "hello from slack",
      seq: 1,
    });
    await db.insert(schema.messages).values({
      id: msgId2,
      workspaceId: wsId,
      channelId: chanId,
      fromId: slackId,
      fromType: "human",
      text: "second message from slack",
      seq: 2,
    });
  });

  afterAll(async () => {
    await db.delete(schema.messages).where(eq(schema.messages.workspaceId, wsId));
    await db.delete(schema.channels).where(eq(schema.channels.id, chanId));
    await db.delete(schema.memberships).where(eq(schema.memberships.workspaceId, wsId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, wsId));
    await db.delete(schema.users).where(eq(schema.users.id, slackId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
    await closePool();
  });

  it("returns exactly the external Slack guest with name + avatar (distinct on repeat posts)", async () => {
    const external = await pg.getExternalSlackParticipants(wsId);
    expect(external).toHaveLength(1);
    expect(external[0]).toEqual({
      userId: slackId,
      name: "Alice Slack",
      imageUrl: "https://img/alice.png",
    });
  });

  it("getMembers excludes the slack: guest and returns the real owner (seat/roster exclusion)", async () => {
    const members = await pg.getMembers(wsId);
    const ids = members.map((m) => m.userId);
    expect(ids).toContain(ownerId);
    expect(ids).not.toContain(slackId);
  });
});
