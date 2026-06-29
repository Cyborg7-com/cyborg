import { describe, expect, it } from "vitest";
import {
  mergePgCybosIntoRoster,
  resolveWorkspaceCybo,
  type PgCyboRow,
} from "./cybo-roster-merge.js";

// The REAL prod row (verified in PG the day of the incident): apex exists,
// correct workspace — yet EDIT answered "Cybo not found".
const APEX_PG: PgCyboRow = {
  id: "cybo_d46b732d-df8c-4335-a406-d20427b13b4b",
  slug: "apex",
  name: "Apex",
  description: null,
  avatar: null,
  role: null,
  provider: "opencode-go",
  model: "glm-5.1",
  llm_auth_mode: "cli",
  behavior_mode: "responsive",
  home_daemon_id: null,
  monthly_spend_cap: null,
  platform_permissions: '["send_message"]',
  is_default: 0,
  created_at: 1_780_000_000_000,
};

describe("mergePgCybosIntoRoster (PG is authoritative)", () => {
  it("PROD REPRO: a stale daemon-SQLite duplicate of apex is REPLACED by the PG row", () => {
    // The answering daemon lists its own apex (failed PG mirror → different id).
    const list: Record<string, unknown>[] = [
      { id: "cybo_stale-local-duplicate", slug: "apex", name: "Apex", isLocal: false },
      { id: "cybo_other", slug: "otra", name: "Otra" },
    ];
    mergePgCybosIntoRoster(list, [APEX_PG]);

    const apexEntries = list.filter((e) => e.slug === "apex");
    expect(apexEntries).toHaveLength(1);
    // THE fix: the roster now carries the PG id, so the Edit page navigates and
    // mutates with an id pg.getCybos can resolve.
    expect(apexEntries[0].id).toBe(APEX_PG.id);
    expect(apexEntries[0].provider).toBe("opencode-go");
    expect(apexEntries[0].platformPermissions).toEqual(["send_message"]);
    // STRICT ISOLATION: a daemon-SQLite straggler with no PG row for this
    // workspace and no local: provenance is a leak/stale copy → dropped.
    expect(list.some((e) => e.id === "cybo_other")).toBe(false);
  });

  it("STRICT ISOLATION: a cross-workspace leaked cybo (SQLite-only, no PG here) is dropped", () => {
    // The "Apex personal" prod bug: a daemon's SQLite scopes a cybo into THIS
    // workspace, but its canonical PG row lives elsewhere → not in pg.getCybos.
    const list: Record<string, unknown>[] = [
      { id: "cybo_eaf5c6a6", slug: "apexpersonal", name: "Apex personal", isLocal: false },
    ];
    mergePgCybosIntoRoster(list, [APEX_PG]);
    expect(list.some((e) => e.id === "cybo_eaf5c6a6")).toBe(false);
    // The workspace's real PG cybo is still present.
    expect(list.map((e) => e.id)).toContain(APEX_PG.id);
  });

  it("STRICT ISOLATION: a disk (local:) cybo with no PG row is KEPT", () => {
    const list: Record<string, unknown>[] = [
      { id: "local:solo", slug: "solo", name: "Solo", isLocal: true, daemonId: "d1" },
    ];
    mergePgCybosIntoRoster(list, [APEX_PG]);
    expect(list.some((e) => e.id === "local:solo")).toBe(true);
    expect(list.map((e) => e.id)).toContain(APEX_PG.id);
  });

  it("a DISK copy (local:apex, with provenance) is also shadowed by the PG row", () => {
    const list: Record<string, unknown>[] = [
      { id: "local:apex", slug: "apex", name: "Apex", isLocal: true, daemonId: "d1" },
    ];
    mergePgCybosIntoRoster(list, [APEX_PG]);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(APEX_PG.id);
    expect(list[0].isLocal).toBe(false);
  });

  it("same-id collision (mirror worked): PG fields win", () => {
    const list: Record<string, unknown>[] = [
      { id: APEX_PG.id, slug: "apex", name: "Apex (stale fields)" },
    ];
    mergePgCybosIntoRoster(list, [APEX_PG]);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Apex");
  });

  it("no collision → PG cybos append (previous behavior preserved)", () => {
    const list: Record<string, unknown>[] = [{ id: "local:solo", slug: "solo", name: "Solo" }];
    mergePgCybosIntoRoster(list, [APEX_PG]);
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.id)).toContain(APEX_PG.id);
  });

  it("malformed platform_permissions degrades to []", () => {
    const list: Record<string, unknown>[] = [];
    mergePgCybosIntoRoster(list, [{ ...APEX_PG, platform_permissions: "{not json" }]);
    expect(list[0].platformPermissions).toEqual([]);
  });
});

describe("resolveWorkspaceCybo (tolerant mutation lookup)", () => {
  const CYBOS = [APEX_PG, { ...APEX_PG, id: "cybo_b", slug: "beta", name: "Beta" }];

  it("exact PG id resolves (the post-merge happy path — DONE: update_cybo of apex persists)", () => {
    expect(resolveWorkspaceCybo(CYBOS, APEX_PG.id)?.slug).toBe("apex");
  });

  it("a local:<slug> id from a pre-fix roster resolves to the PG row", () => {
    expect(resolveWorkspaceCybo(CYBOS, "local:apex")?.id).toBe(APEX_PG.id);
  });

  it("the raw slug resolves too", () => {
    expect(resolveWorkspaceCybo(CYBOS, "apex")?.id).toBe(APEX_PG.id);
  });

  it("an unknown stale id stays a MISS (no guessing across slugs)", () => {
    expect(resolveWorkspaceCybo(CYBOS, "cybo_stale-local-duplicate")).toBeUndefined();
  });
});

// Gemini review follow-ups (#433): multi-duplicate collisions and non-array
// permissions JSON.
describe("gemini review hardening", () => {
  it("BOTH a stale SQLite duplicate AND the disk copy are removed — single apex, PG id", () => {
    const list: Record<string, unknown>[] = [
      { id: "cybo_stale-local-duplicate", slug: "apex", name: "Apex" },
      { id: "cybo_other", slug: "otra", name: "Otra" },
      { id: "local:apex", slug: "apex", name: "Apex", isLocal: true, daemonId: "d1" },
    ];
    mergePgCybosIntoRoster(list, [APEX_PG]);
    const apexEntries = list.filter((e) => e.slug === "apex");
    expect(apexEntries).toHaveLength(1);
    expect(apexEntries[0].id).toBe(APEX_PG.id);
    // STRICT ISOLATION: the unrelated daemon-only straggler is dropped.
    expect(list.some((e) => e.id === "cybo_other")).toBe(false);
  });

  it("valid-JSON non-array permissions degrade to [] (no type pollution)", () => {
    const list: Record<string, unknown>[] = [];
    mergePgCybosIntoRoster(list, [{ ...APEX_PG, platform_permissions: '{"send_message": true}' }]);
    expect(list[0].platformPermissions).toEqual([]);
  });

  it("arrays with non-string members are filtered to the string subset", () => {
    const list: Record<string, unknown>[] = [];
    mergePgCybosIntoRoster(list, [
      { ...APEX_PG, platform_permissions: '["send_message", 42, null, "react"]' },
    ]);
    expect(list[0].platformPermissions).toEqual(["send_message", "react"]);
  });
});
