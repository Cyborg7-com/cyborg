import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "./connection.js";
import * as schema from "./schema.js";
import { PgSync } from "./pg-sync.js";

const hasPg = !!process.env.DATABASE_URL;

// Slack-parity invites (0044): reusable OPEN links + add-to-channels. Locks the
// invariants the relay handlers rest on: an open invite is keyed ONE-per-workspace,
// keeps its token on update but rotates it on reset, is never returned by the
// pending-invites list, and email-bound invites carry their channel_ids. PG-gated
// like saved-messages.test.ts — skips with no DATABASE_URL (run against dev RDS).
describe.skipIf(!hasPg)("PgSync open invites + channels (0044, requires DATABASE_URL)", () => {
  let db: ReturnType<typeof getDb>;
  let pg: PgSync;

  const owner = randomUUID();
  const wsId = randomUUID();
  const future = new Date(Date.now() + 60_000);

  beforeAll(async () => {
    db = getDb();
    pg = new PgSync(db);
    await db
      .insert(schema.users)
      .values({ id: owner, email: `oi-${owner}@e2e.dev`, name: "Owner" });
    await db.insert(schema.workspaces).values({ id: wsId, name: "Open Invite WS", ownerId: owner });
  });

  afterAll(async () => {
    await db.delete(schema.invitations).where(eq(schema.invitations.workspaceId, wsId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, wsId));
    await db.delete(schema.users).where(eq(schema.users.id, owner));
  });

  it("email-bound invite stores channel_ids and is_open=false", async () => {
    const id = randomUUID();
    await pg.createInvitation({
      id,
      workspaceId: wsId,
      email: `inv-${id}@e2e.dev`,
      role: "member",
      createdBy: owner,
      expiresAt: future,
      channelIds: ["c1", "c2"],
    });
    const row = await pg.getInvitation(id);
    expect(row?.isOpen).toBe(false);
    expect(row?.channelIds).toEqual(["c1", "c2"]);

    await pg.setInvitationChannels(id, ["c3"]);
    expect((await pg.getInvitation(id))?.channelIds).toEqual(["c3"]);
  });

  it("open invite is one-per-workspace: update keeps the token, reset rotates it", async () => {
    // Create.
    const first = await pg.upsertOpenInvitation({
      workspaceId: wsId,
      role: "member",
      channelIds: ["c1"],
      createdBy: owner,
      expiresAt: future,
      newId: randomUUID(),
    });
    expect(first.isOpen).toBe(true);
    expect(first.email).toBeNull();

    // Update in place — SAME token, new role/channels.
    const updated = await pg.upsertOpenInvitation({
      workspaceId: wsId,
      role: "viewer",
      channelIds: ["c1", "c2"],
      createdBy: owner,
      expiresAt: future,
      newId: randomUUID(), // ignored when a live link already exists (no rotate)
    });
    expect(updated.id).toBe(first.id);
    expect(updated.role).toBe("viewer");
    expect(updated.channelIds).toEqual(["c1", "c2"]);

    // getOpenInvitation returns the single live link.
    const got = await pg.getOpenInvitation(wsId);
    expect(got?.id).toBe(first.id);

    // Reset — mints a NEW token, old one is gone, still exactly one live link.
    const rotated = await pg.upsertOpenInvitation({
      workspaceId: wsId,
      role: "viewer",
      channelIds: ["c1", "c2"],
      createdBy: owner,
      expiresAt: future,
      newId: randomUUID(),
      rotate: true,
    });
    expect(rotated.id).not.toBe(first.id);
    expect(await pg.getInvitation(first.id)).toBeNull();
    expect((await pg.getOpenInvitation(wsId))?.id).toBe(rotated.id);
  });

  it("open invite never appears in the pending-invites list", async () => {
    await pg.upsertOpenInvitation({
      workspaceId: wsId,
      role: "member",
      channelIds: [],
      createdBy: owner,
      expiresAt: future,
      newId: randomUUID(),
    });
    const pending = await pg.getPendingInvitations(wsId);
    expect(pending.every((p) => p.email !== "")).toBe(true);
    // The open link (NULL email) must be excluded entirely.
    const openRow = await pg.getOpenInvitation(wsId);
    expect(pending.some((p) => p.id === openRow?.id)).toBe(false);
  });
});
