import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CyborgAuth } from "./auth.js";
import { pgCyboToRosterEntry, type PgCyboRow } from "./cybo-roster-merge.js";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { WorkspaceManager } from "./workspace-manager.js";

// Problem (4): a cybo has an explicit "home" daemon — the machine it lives on,
// chosen at creation — that must be persisted and carried authoritatively. These
// tests pin the SQLite persistence path (create → read → update, incl. clearing)
// and the roster carry (PG row → wire entry) end to end.
describe("cybo home daemon (problem 4)", () => {
  let tmpDir: string;
  let storage: DualStorage;
  let workspaceId: string;
  let userId: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cybo-home-daemon-"));
    storage = new DualStorage(new CyborgStorage(join(tmpDir, "test.db")), null);
    const auth = new CyborgAuth(storage);
    const workspaceManager = new WorkspaceManager(storage);
    const owner = auth.validateToken(auth.createToken("alice@test.com", "Alice"))!;
    userId = owner.user.id;
    workspaceId = workspaceManager.createWorkspace("Home WS", userId).id;
  });

  afterEach(() => {
    try {
      storage.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("persists home_daemon_id on create and reads it back", () => {
    const cybo = storage.createCybo({
      workspaceId,
      slug: "atlas",
      name: "Atlas",
      soul: "You are Atlas.",
      provider: "pi",
      createdBy: userId,
      homeDaemonId: "daemon_macbook",
    });
    expect(cybo.home_daemon_id).toBe("daemon_macbook");

    // Re-read from disk (not the in-memory return) to prove it was stored.
    const reread = storage.getCybo(cybo.id);
    expect(reread?.home_daemon_id).toBe("daemon_macbook");
  });

  it("defaults home_daemon_id to null when not provided (existing cybos)", () => {
    const cybo = storage.createCybo({
      workspaceId,
      slug: "ghost",
      name: "Ghost",
      soul: "You are Ghost.",
      provider: "pi",
      createdBy: userId,
    });
    expect(cybo.home_daemon_id).toBeNull();
  });

  it("updates home_daemon_id and can clear it back to null", () => {
    const cybo = storage.createCybo({
      workspaceId,
      slug: "rover",
      name: "Rover",
      soul: "You are Rover.",
      provider: "pi",
      createdBy: userId,
      homeDaemonId: "daemon_one",
    });

    const moved = storage.updateCybo(cybo.id, { homeDaemonId: "daemon_two" });
    expect(moved?.home_daemon_id).toBe("daemon_two");

    // Explicit null clears it; undefined would leave it untouched.
    const cleared = storage.updateCybo(cybo.id, { homeDaemonId: null });
    expect(cleared?.home_daemon_id).toBeNull();
  });

  it("leaves home_daemon_id untouched when an unrelated field is updated", () => {
    const cybo = storage.createCybo({
      workspaceId,
      slug: "keep",
      name: "Keep",
      soul: "You are Keep.",
      provider: "pi",
      createdBy: userId,
      homeDaemonId: "daemon_sticky",
    });
    const updated = storage.updateCybo(cybo.id, { name: "Keeper" });
    expect(updated?.name).toBe("Keeper");
    expect(updated?.home_daemon_id).toBe("daemon_sticky");
  });

  it("carries homeDaemonId through pgCyboToRosterEntry (roster shows 'lives on X')", () => {
    const row: PgCyboRow = {
      id: "cybo_abc",
      slug: "atlas",
      name: "Atlas",
      description: null,
      avatar: null,
      role: null,
      provider: "pi",
      model: null,
      llm_auth_mode: "cli",
      behavior_mode: "responsive",
      home_daemon_id: "daemon_macbook",
      monthly_spend_cap: null,
      platform_permissions: "[]",
      is_default: 0,
      created_at: 1_780_000_000_000,
    };
    expect(pgCyboToRosterEntry(row).homeDaemonId).toBe("daemon_macbook");

    // A cybo created before this column existed carries null, not undefined.
    expect(pgCyboToRosterEntry({ ...row, home_daemon_id: null }).homeDaemonId).toBeNull();
  });
});
