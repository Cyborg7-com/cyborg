import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "./connection.js";
import * as schema from "./schema.js";
import { PgSync } from "./pg-sync.js";

const hasPg = !!process.env.DATABASE_URL;

// IDOR fix: relay `cyborg:fetch_thread` gates private-channel threads exactly
// like `cyborg:fetch_messages`. A workspace member who is NOT in a private
// channel must not read its thread replies. This locks the gate's decision via
// the SAME primitives the relay handler runs:
//   parent = getMessageById(parentId) → parent.channelId
//   if parent.channelId:
//     channel = getChannel(channelId)
//     if channel.is_private && !getChannelMemberRole(channelId, userId) → DENY
//   else (DM thread, channelId null) → allowed unchanged
// PG-gated like saved-messages.test.ts — skips with no DATABASE_URL.
describe.skipIf(!hasPg)("fetch_thread private-channel gate (IDOR, requires DATABASE_URL)", () => {
  let db: ReturnType<typeof getDb>;
  let pg: PgSync;

  const owner = randomUUID(); // workspace owner + private-channel member
  const member = randomUUID(); // private-channel member
  const outsider = randomUUID(); // workspace member, NOT in the private channel
  const wsId = randomUUID();
  const privCh = randomUUID();
  const pubCh = randomUUID();

  const privParent = `pp-${randomUUID()}`;
  const privReply = `pr-${randomUUID()}`;
  const pubParent = `qp-${randomUUID()}`;
  const pubReply = `qr-${randomUUID()}`;
  const dmParent = `dp-${randomUUID()}`; // channelId null → DM thread
  const dmReply = `dr-${randomUUID()}`;
  const allMsgIds = [privParent, privReply, pubParent, pubReply, dmParent, dmReply];
  const t0 = new Date("2026-03-01T00:00:00Z");

  async function insertMsg(o: {
    id: string;
    channelId: string | null;
    parentId: string | null;
    seq: number;
  }) {
    await db.insert(schema.messages).values({
      id: o.id,
      workspaceId: wsId,
      channelId: o.channelId,
      parentId: o.parentId,
      fromId: owner,
      fromType: "human",
      fromName: "Owner",
      text: `msg ${o.id}`,
      seq: o.seq,
      createdAt: new Date(t0.getTime() + o.seq * 60_000),
    });
  }

  // Mirrors the relay fetch_thread gate: returns true if `userId` may read the
  // thread under `parentId`. Built from the exact pg calls the handler makes.
  async function canReadThread(parentId: string, userId: string): Promise<boolean> {
    const parent = await pg.getMessageById(parentId);
    if (!parent || parent.workspaceId !== wsId) return false;
    if (parent.channelId) {
      const ch = await pg.getChannel(parent.channelId);
      if (ch?.is_private && !(await pg.getChannelMemberRole(parent.channelId, userId))) {
        return false;
      }
    }
    return true;
  }

  beforeAll(async () => {
    db = getDb();
    pg = new PgSync();
    await db.insert(schema.users).values([
      { id: owner, email: `ft-owner-${owner}@e2e.dev`, name: "Owner" },
      { id: member, email: `ft-member-${member}@e2e.dev`, name: "Member" },
      { id: outsider, email: `ft-outsider-${outsider}@e2e.dev`, name: "Outsider" },
    ]);
    await db.insert(schema.workspaces).values({ id: wsId, name: "FT WS", ownerId: owner });
    await db.insert(schema.channels).values([
      { id: privCh, workspaceId: wsId, name: "secret", createdBy: owner, isPrivate: true },
      { id: pubCh, workspaceId: wsId, name: "general", createdBy: owner, isPrivate: false },
    ]);
    // owner + member are in the private channel; outsider is not.
    await db.insert(schema.channelMembers).values([
      { channelId: privCh, userId: owner, role: "admin" },
      { channelId: privCh, userId: member, role: "member" },
    ]);
    await insertMsg({ id: privParent, channelId: privCh, parentId: null, seq: 1 });
    await insertMsg({ id: privReply, channelId: privCh, parentId: privParent, seq: 2 });
    await insertMsg({ id: pubParent, channelId: pubCh, parentId: null, seq: 3 });
    await insertMsg({ id: pubReply, channelId: pubCh, parentId: pubParent, seq: 4 });
    await insertMsg({ id: dmParent, channelId: null, parentId: null, seq: 5 });
    await insertMsg({ id: dmReply, channelId: null, parentId: dmParent, seq: 6 });
  });

  afterAll(async () => {
    await db
      .delete(schema.channelMembers)
      .where(inArray(schema.channelMembers.channelId, [privCh, pubCh]));
    await db.delete(schema.messages).where(inArray(schema.messages.id, allMsgIds));
    await db.delete(schema.channels).where(inArray(schema.channels.id, [privCh, pubCh]));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, wsId));
    await db.delete(schema.users).where(inArray(schema.users.id, [owner, member, outsider]));
  });

  it("DENIES a non-member reading a PRIVATE-channel thread", async () => {
    expect(await canReadThread(privParent, outsider)).toBe(false);
    // and the replies actually exist (so the deny is the gate, not an empty thread)
    const replies = await pg.getThreadReplies(privParent);
    expect(replies.map((r) => r.id)).toContain(privReply);
  });

  it("ALLOWS a private-channel member to read its thread", async () => {
    expect(await canReadThread(privParent, member)).toBe(true);
    expect(await canReadThread(privParent, owner)).toBe(true);
  });

  it("ALLOWS any workspace member to read a PUBLIC-channel thread", async () => {
    expect(await canReadThread(pubParent, outsider)).toBe(true);
  });

  it("ALLOWS a DM thread (null channelId) — channel gate does not apply", async () => {
    expect(await canReadThread(dmParent, outsider)).toBe(true);
  });
});
