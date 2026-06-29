// CRITICAL regression guard — the per-channel auto-tasks (channel watcher) switch
// is OPT-IN (default OFF), matching the schema.ts auto_tasks_enabled contract:
// "NULL/false = OFF (opt-in): the watcher only fires when explicitly true".
//
// Before this fix BOTH getters returned `!== false` / `!== 0`, so an unconfigured
// channel (NULL) read as ON — a cybo could act autonomously in a channel nobody
// turned the watcher on for. These tests pin the inverted default + the new setter.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

import { CyborgStorage } from "./storage.js";

// ─── SQLite getter/setter (no Postgres needed) ──────────────────────────────

describe("CyborgStorage.getChannelAutoTasksEnabled — OPT-IN default", () => {
  function seedChannel(): { storage: CyborgStorage; channelId: string } {
    const storage = new CyborgStorage(":memory:");
    const user = storage.upsertUser(`auto-${randomUUID()}@e2e.dev`, "Owner");
    const ws = storage.createWorkspace("WS", user.id);
    const ch = storage.createChannel(ws.id, "general", user.id);
    return { storage, channelId: ch.id };
  }

  it("returns false for an unconfigured channel (NULL = OFF)", () => {
    const { storage, channelId } = seedChannel();
    expect(storage.getChannelAutoTasksEnabled(channelId)).toBe(false);
  });

  it("returns false for a non-existent channel", () => {
    const { storage } = seedChannel();
    expect(storage.getChannelAutoTasksEnabled("ch_does_not_exist")).toBe(false);
  });

  it("returns true ONLY for an explicit 1, false for an explicit 0", () => {
    const { storage, channelId } = seedChannel();
    const db = (storage as unknown as { db: import("better-sqlite3").Database }).db;

    db.prepare("UPDATE channels SET auto_tasks_enabled = 1 WHERE id = ?").run(channelId);
    expect(storage.getChannelAutoTasksEnabled(channelId)).toBe(true);

    db.prepare("UPDATE channels SET auto_tasks_enabled = 0 WHERE id = ?").run(channelId);
    expect(storage.getChannelAutoTasksEnabled(channelId)).toBe(false);
  });

  it("round-trips through setChannelAutoTasksEnabled (set → get)", () => {
    const { storage, channelId } = seedChannel();
    // default OFF
    expect(storage.getChannelAutoTasksEnabled(channelId)).toBe(false);
    // turn ON
    expect(storage.setChannelAutoTasksEnabled(channelId, true)).toBe(true);
    expect(storage.getChannelAutoTasksEnabled(channelId)).toBe(true);
    // turn OFF again
    expect(storage.setChannelAutoTasksEnabled(channelId, false)).toBe(true);
    expect(storage.getChannelAutoTasksEnabled(channelId)).toBe(false);
  });

  it("setChannelAutoTasksEnabled returns false for a non-existent channel", () => {
    const { storage } = seedChannel();
    expect(storage.setChannelAutoTasksEnabled("ch_nope", true)).toBe(false);
  });
});

// ─── PgSync getter/setter (requires DATABASE_URL) ───────────────────────────

const hasPg = !!process.env.DATABASE_URL;

describe.skipIf(!hasPg)("PgSync.getChannelAutoTasksEnabled — OPT-IN default (real PG)", () => {
  let pg: import("./db/pg-sync.js").PgSync;
  let closePool: () => Promise<void>;

  beforeAll(async () => {
    const mod = await import("./db/pg-sync.js");
    pg = new mod.PgSync();
    ({ closePool } = await import("./db/connection.js"));
  });

  afterAll(async () => {
    await closePool();
  });

  async function seedChannel(): Promise<string> {
    const userId = `u_${randomUUID()}`;
    const wsId = `ws_${randomUUID()}`;
    const chId = `ch_${randomUUID()}`;
    await pg.upsertUser(userId, `auto-${userId}@e2e.dev`, "Owner");
    await pg.createWorkspace(wsId, "WS", userId);
    await pg.createChannel(chId, wsId, "general", userId);
    return chId;
  }

  it("returns false for an unconfigured channel (NULL = OFF)", async () => {
    const chId = await seedChannel();
    expect(await pg.getChannelAutoTasksEnabled(chId)).toBe(false);
  });

  it("returns true ONLY after an explicit true, false after an explicit false", async () => {
    const chId = await seedChannel();
    expect(await pg.setChannelAutoTasksEnabled(chId, true)).toBe(true);
    expect(await pg.getChannelAutoTasksEnabled(chId)).toBe(true);
    expect(await pg.setChannelAutoTasksEnabled(chId, false)).toBe(true);
    expect(await pg.getChannelAutoTasksEnabled(chId)).toBe(false);
  });

  it("setChannelAutoTasksEnabled returns false for a non-existent channel", async () => {
    expect(await pg.setChannelAutoTasksEnabled(`ch_${randomUUID()}`, true)).toBe(false);
  });
});
