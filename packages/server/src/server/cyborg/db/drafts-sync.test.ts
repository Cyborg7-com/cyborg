import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import { getDb, closePool } from "./connection.js";
import * as schema from "./schema.js";
import { PgSync } from "./pg-sync.js";

const hasPg = !!process.env.DATABASE_URL;

// Server-side draft sync (#610): drafts follow the user across devices. These
// prove the PG layer the relay + dispatcher call: one row per (user_id, scope),
// upsert-overwrites in place (never duplicates), clear deletes, and reads are
// isolated per-user and per-scope. Skips cleanly without DATABASE_URL.
describe.skipIf(!hasPg)("PgSync drafts (#610, requires DATABASE_URL)", () => {
  let db: ReturnType<typeof getDb>;
  let pg: PgSync;

  const owner = randomUUID();
  const other = randomUUID(); // a second user — proves per-user isolation
  const wsId = randomUUID();
  const wsOther = randomUUID(); // a second workspace — proves per-workspace scoping
  const users = [owner, other];
  const wss = [wsId, wsOther];

  const scopeChan = "channel:" + randomUUID();
  const scopeDm = "dm:" + randomUUID();

  beforeAll(async () => {
    db = getDb();
    pg = new PgSync();
    await db.insert(schema.users).values([
      { id: owner, email: `draft-owner-${owner}@e2e.dev`, name: "Owner" },
      { id: other, email: `draft-other-${other}@e2e.dev`, name: "Other" },
    ]);
    await db.insert(schema.workspaces).values([
      { id: wsId, name: "Draft WS", ownerId: owner },
      { id: wsOther, name: "Draft WS 2", ownerId: owner },
    ]);
  });

  afterAll(async () => {
    // drafts cascade-delete with the workspace, but delete explicitly first so a
    // partial test run still cleans up.
    await db.delete(schema.drafts).where(inArray(schema.drafts.userId, users));
    await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, wss));
    await db.delete(schema.users).where(inArray(schema.users.id, users));
    await closePool();
  });

  it("setDraft inserts then fetch returns it with epoch-ms updatedAt", async () => {
    const before = Date.now();
    await pg.setDraft({ workspaceId: wsId, userId: owner, scope: scopeChan, text: "hello" });
    const drafts = await pg.getDrafts(wsId, owner);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].scope).toBe(scopeChan);
    expect(drafts[0].text).toBe("hello");
    expect(typeof drafts[0].updatedAt).toBe("number");
    // updatedAt is epoch ms set to ~now (allow a small skew window).
    expect(drafts[0].updatedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(drafts[0].updatedAt).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("persists the CLIENT's updatedAt verbatim (not now()) so reconcile stays newest-wins", async () => {
    // A draft edited offline at time T and synced LATER must keep T as its
    // updatedAt — if PG stamped its own now(), cross-device newest-wins would be
    // wrong. Use a fixed past instant well outside any now()-fallback skew window.
    const clientTs = 1_700_000_000_000; // 2023-11-14T22:13:20Z, in the past
    await pg.setDraft({
      workspaceId: wsId,
      userId: owner,
      scope: scopeChan,
      text: "edited offline",
      updatedAt: new Date(clientTs),
    });

    const drafts = await pg.getDrafts(wsId, owner);
    const row = drafts.find((d) => d.scope === scopeChan);
    expect(row?.text).toBe("edited offline");
    // Exact round-trip: getDrafts returns epoch ms, so it must equal what we sent.
    expect(row?.updatedAt).toBe(clientTs);

    // And an overwrite with a NEWER client ts updates it (still verbatim, not now()).
    const newerTs = clientTs + 60_000;
    await pg.setDraft({
      workspaceId: wsId,
      userId: owner,
      scope: scopeChan,
      text: "edited again",
      updatedAt: new Date(newerTs),
    });
    const after = (await pg.getDrafts(wsId, owner)).find((d) => d.scope === scopeChan);
    expect(after?.text).toBe("edited again");
    expect(after?.updatedAt).toBe(newerTs);
  });

  it("a second setDraft for the same (user, scope) OVERWRITES — no duplicate row", async () => {
    await pg.setDraft({ workspaceId: wsId, userId: owner, scope: scopeChan, text: "v1" });
    await pg.setDraft({
      workspaceId: wsId,
      userId: owner,
      scope: scopeChan,
      text: "v2 overwrites",
    });

    const drafts = await pg.getDrafts(wsId, owner);
    expect(drafts).toHaveLength(1); // upsert, not append
    expect(drafts[0].text).toBe("v2 overwrites");

    // Belt-and-braces: assert the raw row count directly, not just the fetch shape.
    const rows = await db.select().from(schema.drafts).where(eq(schema.drafts.userId, owner));
    expect(rows.filter((r) => r.scope === scopeChan)).toHaveLength(1);
  });

  it("keeps distinct rows for different scopes of the same user", async () => {
    await pg.setDraft({ workspaceId: wsId, userId: owner, scope: scopeChan, text: "chan draft" });
    await pg.setDraft({ workspaceId: wsId, userId: owner, scope: scopeDm, text: "dm draft" });

    const drafts = await pg.getDrafts(wsId, owner);
    const byScope = new Map(drafts.map((d) => [d.scope, d.text]));
    expect(byScope.get(scopeChan)).toBe("chan draft");
    expect(byScope.get(scopeDm)).toBe("dm draft");
    expect(drafts).toHaveLength(2);
  });

  it("clearDraft removes only the targeted (user, scope) row and is idempotent", async () => {
    await pg.setDraft({ workspaceId: wsId, userId: owner, scope: scopeChan, text: "to clear" });
    await pg.setDraft({ workspaceId: wsId, userId: owner, scope: scopeDm, text: "keep me" });

    await pg.clearDraft(wsId, owner, scopeChan);
    let drafts = await pg.getDrafts(wsId, owner);
    expect(drafts.map((d) => d.scope)).toEqual([scopeDm]); // chan gone, dm kept

    // Idempotent: clearing again is a harmless no-op.
    await pg.clearDraft(wsId, owner, scopeChan);
    drafts = await pg.getDrafts(wsId, owner);
    expect(drafts.map((d) => d.scope)).toEqual([scopeDm]);
  });

  it("isolates drafts per user — owner never sees other's drafts and vice versa", async () => {
    await pg.setDraft({ workspaceId: wsId, userId: owner, scope: scopeDm, text: "owner secret" });
    await pg.setDraft({ workspaceId: wsId, userId: other, scope: scopeDm, text: "other secret" });

    const ownerDrafts = await pg.getDrafts(wsId, owner);
    const otherDrafts = await pg.getDrafts(wsId, other);

    expect(ownerDrafts.find((d) => d.scope === scopeDm)?.text).toBe("owner secret");
    expect(otherDrafts.find((d) => d.scope === scopeDm)?.text).toBe("other secret");
    // each user sees ONLY their own row for that scope
    expect(ownerDrafts.filter((d) => d.scope === scopeDm)).toHaveLength(1);
    expect(otherDrafts.filter((d) => d.scope === scopeDm)).toHaveLength(1);
  });

  it("scopes getDrafts to the requested workspace", async () => {
    // The same user has a draft in a DIFFERENT workspace; getDrafts(wsId) must not
    // return it. (PK is (user_id, scope), so use a distinct scope per workspace —
    // the realistic case, since scope ids are conversation-unique across the app.)
    const otherWsScope = "channel:" + randomUUID();
    await pg.setDraft({
      workspaceId: wsOther,
      userId: owner,
      scope: otherWsScope,
      text: "ws2 only",
    });

    const ws1 = await pg.getDrafts(wsId, owner);
    const ws2 = await pg.getDrafts(wsOther, owner);
    expect(ws1.find((d) => d.scope === otherWsScope)).toBeUndefined();
    expect(ws2.find((d) => d.scope === otherWsScope)?.text).toBe("ws2 only");
  });

  it("returns an empty array for a user with no drafts", async () => {
    const fresh = randomUUID();
    const drafts = await pg.getDrafts(wsId, fresh);
    expect(drafts).toEqual([]);
  });
});
