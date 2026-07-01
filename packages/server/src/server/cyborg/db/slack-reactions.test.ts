import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, closePool } from "./connection.js";
import * as schema from "./schema.js";
import { PgSync } from "./pg-sync.js";

const hasPg = !!process.env.DATABASE_URL;

// Directional reaction apply (Slack bridge): unlike toggleReaction (which flips on
// current state), addReaction/removeReaction know the exact target state from the
// event kind (reaction_added / reaction_removed). A retried or duplicate event must
// NOT flip the wrong way — addReaction is a no-op when the (userId, emoji) pair
// already exists, removeReaction is a no-op when it's absent. Both return whether
// the reactions array actually changed. The persisted JSONB entries carry the
// {userId, userName, emoji, createdAt} shape.
describe.skipIf(!hasPg)("PgSync add/removeReaction (requires DATABASE_URL)", () => {
  let db: ReturnType<typeof getDb>;
  let pg: PgSync;

  const ownerId = randomUUID();
  const wsId = randomUUID();
  const chanId = randomUUID();
  const msgId = randomUUID();
  // Reaction userIds live in the JSONB payload (no FK), so plain ids are fine.
  const alice = randomUUID();
  const bob = randomUUID();
  const emoji = "thumbsup";

  async function readReactions(): Promise<
    { userId: string; userName?: string; emoji: string; createdAt: number }[]
  > {
    const [row] = await db
      .select({ reactions: schema.messages.reactions })
      .from(schema.messages)
      .where(eq(schema.messages.id, msgId));
    return row?.reactions ?? [];
  }

  beforeAll(async () => {
    db = getDb();
    pg = new PgSync();
    await db
      .insert(schema.users)
      .values({ id: ownerId, email: `slack-rx-${ownerId}@e2e.dev`, name: "Owner" });
    await db.insert(schema.workspaces).values({ id: wsId, name: "Slack Rx WS", ownerId });
    await db
      .insert(schema.channels)
      .values({ id: chanId, workspaceId: wsId, name: "reactions", createdBy: ownerId });
    await db.insert(schema.messages).values({
      id: msgId,
      workspaceId: wsId,
      channelId: chanId,
      fromId: ownerId,
      fromType: "user",
      text: "react to me",
      seq: 1,
    });
  });

  afterAll(async () => {
    await db.delete(schema.messages).where(eq(schema.messages.id, msgId));
    await db.delete(schema.channels).where(eq(schema.channels.id, chanId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, wsId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
    await closePool();
  });

  it("addReaction dedupes on (userId, emoji): true then false", async () => {
    expect(await pg.addReaction(wsId, msgId, alice, "Alice", emoji)).toBe(true);
    expect(await pg.addReaction(wsId, msgId, alice, "Alice", emoji)).toBe(false);
    expect(await readReactions()).toHaveLength(1);
  });

  it("persists the {userId,userName,emoji,createdAt} entry shape", async () => {
    const [entry] = await readReactions();
    expect(entry).toMatchObject({ userId: alice, userName: "Alice", emoji });
    expect(typeof entry?.createdAt).toBe("number");
    expect(Object.keys(entry ?? {}).sort()).toEqual(["createdAt", "emoji", "userId", "userName"]);
  });

  it("a second user's reaction keeps both entries", async () => {
    expect(await pg.addReaction(wsId, msgId, bob, "Bob", emoji)).toBe(true);
    const reactions = await readReactions();
    expect(reactions).toHaveLength(2);
    expect(reactions.map((r) => r.userId).sort()).toEqual([alice, bob].sort());
  });

  it("removeReaction is directional/idempotent: true then false, and leaves other users", async () => {
    expect(await pg.removeReaction(wsId, msgId, alice, emoji)).toBe(true);
    expect(await pg.removeReaction(wsId, msgId, alice, emoji)).toBe(false);
    expect((await readReactions()).map((r) => r.userId)).toEqual([bob]);
  });
});
