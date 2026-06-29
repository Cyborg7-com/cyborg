import { describe, it, expect } from "vitest";
import { CyborgStorage } from "./storage.js";
import { AUTONOMY_PRESETS, AUTONOMY_RANK, behaviorModeToLevel } from "./cybo-types.js";

// Cybo Autonomy S2 — the per-cybo autonomy dial. These pin the pure constants and
// that autonomy_level round-trips through SQLite storage (create + update + default).
describe("autonomy dial — pure constants", () => {
  it("exposes the 4 public presets mapped to L0/L1/L3/L4", () => {
    expect(AUTONOMY_PRESETS.map((p) => p.level)).toEqual(["L0", "L1", "L3", "L4"]);
    expect(AUTONOMY_PRESETS.map((p) => p.label)).toEqual([
      "Off",
      "Mention-only",
      "Active",
      "Autonomous",
    ]);
  });

  it("ranks levels L0<..<L5 for the future min() resolver", () => {
    expect(AUTONOMY_RANK.L0).toBeLessThan(AUTONOMY_RANK.L1);
    expect(AUTONOMY_RANK.L4).toBeGreaterThan(AUTONOMY_RANK.L3);
  });

  it("maps the deprecated behavior_mode → a level (responsive→L1, proactive→L3)", () => {
    expect(behaviorModeToLevel("responsive")).toBe("L1");
    expect(behaviorModeToLevel("proactive")).toBe("L3");
    expect(behaviorModeToLevel(null)).toBe("L1");
    expect(behaviorModeToLevel(undefined)).toBe("L1");
  });
});

describe("autonomy dial — storage round-trip", () => {
  function freshWorkspace() {
    const storage = new CyborgStorage(":memory:");
    const user = storage.upsertUser("a@b.c", "A");
    const ws = storage.createWorkspace("WS", user.id);
    return { storage, wsId: ws.id, userId: user.id };
  }

  it("defaults autonomy_level to null when unset (falls back via behavior_mode)", () => {
    const { storage, wsId, userId } = freshWorkspace();
    const cybo = storage.createCybo({
      workspaceId: wsId,
      slug: "apex",
      name: "Apex",
      soul: "You are Apex.",
      provider: "pi",
      createdBy: userId,
    });
    expect(cybo.autonomy_level).toBeNull();
  });

  it("persists autonomy_level on create + read-back", () => {
    const { storage, wsId, userId } = freshWorkspace();
    const cybo = storage.createCybo({
      workspaceId: wsId,
      slug: "rick",
      name: "Rick",
      soul: "You are Rick.",
      provider: "pi",
      createdBy: userId,
      autonomyLevel: "L3",
    });
    expect(cybo.autonomy_level).toBe("L3");
    expect(storage.getCybo(cybo.id)?.autonomy_level).toBe("L3");
  });

  it("updateCybo changes the level; omitting it preserves the existing value", () => {
    const { storage, wsId, userId } = freshWorkspace();
    const cybo = storage.createCybo({
      workspaceId: wsId,
      slug: "nova",
      name: "Nova",
      soul: "You are Nova.",
      provider: "pi",
      createdBy: userId,
      autonomyLevel: "L1",
    });
    expect(storage.updateCybo(cybo.id, { autonomyLevel: "L0" })?.autonomy_level).toBe("L0");
    // An unrelated update must not wipe the level.
    expect(storage.updateCybo(cybo.id, { name: "Nova II" })?.autonomy_level).toBe("L0");
  });
});
