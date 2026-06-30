// Regression for the prod "@sprite couldn't start: UNIQUE constraint failed:
// cybos.workspace_id, cybos.slug" bug. persistCybo denormalizes the PG-resolved
// cybo into local SQLite on every @-mention spawn. The daemon's SQLite can already
// hold a STALE duplicate under the SAME (workspace_id, slug) but a DIFFERENT id (a
// failed PG mirror / a pre-PG daemon-local row). The old id-only guard missed it,
// so the plain INSERT threw a UNIQUE violation that aborted the whole spawn — the
// cybo never answered. persistCybo must now be idempotent on the REAL identity
// (workspace_id, slug) and converge the local cache onto the PG-canonical id.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import type { StoredCybo } from "./cybo-types.js";

describe("CyborgStorage.persistCybo — idempotent on (workspace_id, slug)", () => {
  let storage: CyborgStorage;
  let tmpDir: string;
  const WS = "ws_test";

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cybo-persist-"));
    storage = new CyborgStorage(path.join(tmpDir, "test.db"));
    // cybos.workspace_id REFERENCES workspaces(id) and foreign_keys = ON, so the
    // workspace row must exist before any cybo can be persisted.
    storage.createWorkspaceWithId(WS, "Test", "user_owner");
  });

  afterEach(() => {
    // Close the SQLite connection BEFORE removing the dir so Windows can't hit
    // EBUSY on the open db handle; finally guarantees cleanup even if close throws.
    try {
      storage.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeCybo(id: string, slug: string, name: string): StoredCybo {
    const now = Date.now();
    return {
      id,
      workspace_id: WS,
      slug,
      name,
      description: null,
      avatar: null,
      role: null,
      soul: "you are a test cybo",
      provider: "pi",
      model: null,
      mcp_servers: null,
      tool_grants: null,
      llm_auth_mode: "cli",
      behavior_mode: "responsive",
      home_daemon_id: null,
      autonomy_level: null,
      monthly_spend_cap: null,
      platform_permissions: JSON.stringify([]),
      is_default: 0,
      created_by: "user_owner",
      created_at: now,
      updated_at: now,
    };
  }

  it("reconciles a stale same-slug-different-id row instead of throwing UNIQUE", () => {
    // The exact prod scenario: a daemon-local 'sprite' row exists under an old id,
    // then a mention resolves the PG-canonical 'sprite' under a new id.
    storage.persistCybo(makeCybo("cybo_OLD", "sprite", "Sprite (stale)"));

    // The throw this used to produce is what surfaced as "@sprite couldn't start";
    // persisting the canonical row must succeed silently.
    expect(() => {
      storage.persistCybo(makeCybo("cybo_NEW", "sprite", "Sprite"));
    }).not.toThrow();

    // Exactly one 'sprite' survives — no duplicate roster entry for the user.
    expect(storage.getCybos(WS)).toHaveLength(1);
    // The local cache converged on the PG-canonical id, so the spawn's agent
    // binding (cybo_id = cybo_NEW) resolves the name/avatar on the cybo's messages.
    expect(storage.getCyboBySlug(WS, "sprite")?.id).toBe("cybo_NEW");
    expect(storage.getCybo("cybo_NEW")).toBeDefined();
    expect(storage.getCybo("cybo_NEW")?.name).toBe("Sprite");
    // The stale row is gone (and its old id no longer resolves).
    expect(storage.getCybo("cybo_OLD")).toBeUndefined();
  });

  it("re-points a stale cybo's referencing rows onto the canonical id (no orphan)", () => {
    // Other tables store cybo_id as a plain TEXT column (no FK / no cascade), so
    // converging onto the PG id must MOVE those references — not orphan them — or
    // a later schedule fire / archived-session resume throws CyboNotFoundError.
    storage.persistCybo(makeCybo("cybo_OLD", "sprite", "Sprite (stale)"));
    const sched = storage.createSchedule({
      workspaceId: WS,
      cyboId: "cybo_OLD",
      cronExpr: "0 9 * * *",
      prompt: "daily standup",
      createdBy: "user_owner",
    });
    const archived = storage.archiveSession({
      workspaceId: WS,
      provider: "pi",
      providerHandleId: "ph_1",
      cyboId: "cybo_OLD",
    });
    // The stale cybo also authored a message (from_id = its id) and received a DM
    // (to_id = its id) — these carry the cybo id BY VALUE, not via a cybo_id column.
    const reply = storage.insertMessage({
      workspaceId: WS,
      channelId: "chan_1",
      fromId: "cybo_OLD",
      fromType: "agent",
      fromName: "Sprite (stale)",
      text: "on it",
    });
    const dmToCybo = storage.insertMessage({
      workspaceId: WS,
      fromId: "user_owner",
      fromType: "human",
      toId: "cybo_OLD",
      text: "@sprite ship it",
    });

    storage.persistCybo(makeCybo("cybo_NEW", "sprite", "Sprite"));

    // The stale row is gone and the canonical row is the sole survivor.
    expect(storage.getCybo("cybo_OLD")).toBeUndefined();
    expect(storage.getCyboBySlug(WS, "sprite")?.id).toBe("cybo_NEW");
    // Its referencing rows now point at the canonical id (no dangling cybo_id).
    expect(storage.getSchedule(sched.id)?.cybo_id).toBe("cybo_NEW");
    expect(storage.getArchivedSessions(WS).find((a) => a.id === archived.id)?.cybo_id).toBe(
      "cybo_NEW",
    );
    // messages.from_id / to_id (cybo id by value) converge too, so the cybo's
    // history keeps rendering its name/avatar after the stale row is dropped.
    expect(storage.getMessageById(reply.id)?.from_id).toBe("cybo_NEW");
    expect(storage.getMessageById(dmToCybo.id)?.to_id).toBe("cybo_NEW");
  });

  it("is a no-op when the SAME id is already present (cheap idempotency)", () => {
    // A repeated mention of the same cybo must not duplicate or churn the row.
    storage.persistCybo(makeCybo("cybo_NEW", "sprite", "Sprite"));
    expect(() => {
      storage.persistCybo(makeCybo("cybo_NEW", "sprite", "Sprite renamed"));
    }).not.toThrow();
    expect(storage.getCybos(WS)).toHaveLength(1);
    // Already-present id short-circuits BEFORE the insert, so the row is untouched
    // (no resync of fields) — name stays as first persisted.
    expect(storage.getCybo("cybo_NEW")?.name).toBe("Sprite");
  });

  it("skips disk-local (`local:`) ids — they never occupy a workspace slot", () => {
    // Disk cybos have no PG workspace row; persisting one must write nothing.
    storage.persistCybo(makeCybo("local:sprite", "sprite", "Disk Sprite"));
    expect(storage.getCybos(WS)).toHaveLength(0);
    expect(storage.getCybo("local:sprite")).toBeUndefined();
  });
});
