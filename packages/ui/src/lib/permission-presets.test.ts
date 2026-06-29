import { describe, expect, it } from "vitest";
import {
  derivePreset,
  PERMISSION_PRESETS,
  PLATFORM_PERMISSION_OPTIONS,
  presetPermissions,
  READ_ONLY_SENTINEL,
} from "./permission-presets";

describe("permission presets (#444)", () => {
  it("observer is non-empty and grants NO gated permission (fail-open guard)", () => {
    // An empty list is legacy fail-open (unrestricted until #206 strict mode) —
    // Observer expressed as [] would silently mean "can do everything".
    const observer = presetPermissions("observer");
    expect(observer.length).toBeGreaterThan(0);
    const gatedIds = new Set(PLATFORM_PERMISSION_OPTIONS.map((o) => o.id));
    expect(observer.some((p) => gatedIds.has(p))).toBe(false);
    expect(observer).toContain(READ_ONLY_SENTINEL);
  });

  it("collaborator posts and manages tasks, nothing else", () => {
    expect(presetPermissions("collaborator").sort()).toEqual(["create_task", "send_message"]);
  });

  it("operator covers every fine-grained toggle", () => {
    expect(presetPermissions("operator").sort()).toEqual(
      PLATFORM_PERMISSION_OPTIONS.map((o) => o.id).sort(),
    );
  });

  it("derivePreset round-trips every preset", () => {
    for (const preset of PERMISSION_PRESETS) {
      expect(derivePreset(presetPermissions(preset.id))).toBe(preset.id);
    }
  });

  it("derivePreset is order-insensitive", () => {
    expect(derivePreset(["create_task", "send_message"])).toBe("collaborator");
  });

  it("the legacy empty list derives as custom, NEVER as observer", () => {
    // [] is fail-open (unrestricted) — presenting it as Observer would be the
    // exact false security promise internal docs calls out.
    expect(derivePreset([])).toBe("custom");
  });

  it("partial or unknown grant sets derive as custom", () => {
    expect(derivePreset(["send_message"])).toBe("custom");
    expect(derivePreset(["send_message", "create_task", "manage_channels"])).toBe("custom");
    expect(derivePreset(["something_else"])).toBe("custom");
  });

  it("presetPermissions returns a fresh copy (no shared mutable state)", () => {
    const a = presetPermissions("operator");
    a.push("mutated");
    expect(presetPermissions("operator")).not.toContain("mutated");
  });
});
