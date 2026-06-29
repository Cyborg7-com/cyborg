import { describe, it, expect } from "vitest";
import {
  cyboBackendOf,
  cyboCapabilityFor,
  cyboSetupHref,
  daemonDisplayName,
  isNativeHarnessCybo,
  nativeHarnessAvailable,
  rowBackends,
} from "./cybo-capability.js";
import type { Daemon } from "$lib/plugins/agents/types.js";

function daemon(id: string, meta: Daemon["meta"]): Daemon {
  return { id, label: id, ownerId: "u1", status: "online", lastSeenAt: Date.now(), meta };
}

const AUTHED_ANTHROPIC = {
  configured: true,
  modelCount: 2,
  backends: [{ backend: "anthropic", modelCount: 2 }],
};
const NO_AUTH = { configured: false, modelCount: 0, backends: [] };

describe("cyboBackendOf (mirrors the server's resolvePiModelRef)", () => {
  it("full ref in the model names the backend (new-cybo UI shape)", () => {
    expect(cyboBackendOf("pi", "opencode-go/glm-5.1")).toBe("opencode-go");
    expect(cyboBackendOf("anything", "anthropic/claude-haiku-4-5")).toBe("anthropic");
  });
  it("strips a stray leading pi/ exactly like the server", () => {
    expect(cyboBackendOf("pi", "pi/anthropic/claude-haiku-4-5")).toBe("anthropic");
  });
  it("standalone shape: provider IS the backend", () => {
    expect(cyboBackendOf("opencode-go", "glm-5.1")).toBe("opencode-go");
  });
  it("runtime-only with no model → null (binary capability)", () => {
    expect(cyboBackendOf("pi", null)).toBeNull();
  });
});

describe("rowBackends", () => {
  it("model ids with prefixes name the row's backends (runtime row)", () => {
    expect(
      rowBackends({
        id: "pi",
        models: [{ id: "anthropic/a" }, { id: "anthropic/b" }, { id: "openai/c" }],
      }),
    ).toEqual(["anthropic", "openai"]);
  });
  it("plain ids → the provider id is the backend (join path)", () => {
    expect(rowBackends({ id: "claude", models: [{ id: "claude-haiku-4-5" }] })).toEqual(["claude"]);
  });
  it("runtime row with no models → [] (binary capability)", () => {
    expect(rowBackends({ id: "pi", models: [] })).toEqual([]);
  });
});

describe("cyboCapabilityFor", () => {
  it("partitions ready / needs-setup / unknown across online daemons", () => {
    const configured = daemon("d1", { host: "Rodrigo-MacBook", cyboRuntime: AUTHED_ANTHROPIC });
    const needs = daemon("d2", {
      host: "Sebastians-MacBook",
      cyboInstalled: true,
      cyboRuntime: NO_AUTH,
    });
    const old = daemon("d3", { host: "Old-Daemon", cyboInstalled: true });
    const r = cyboCapabilityFor(["anthropic"], [configured, needs, old]);
    expect(r.configured.map((d) => d.id)).toEqual(["d1"]);
    expect(r.needsSetup.map((d) => d.id)).toEqual(["d2"]);
    expect(r.unknown.map((d) => d.id)).toEqual(["d3"]);
  });

  it("configured runtime WITHOUT the row's backend → needs setup (honest per-backend)", () => {
    const d = daemon("d1", { cyboRuntime: AUTHED_ANTHROPIC });
    expect(cyboCapabilityFor(["openai"], [d]).needsSetup.map((x) => x.id)).toEqual(["d1"]);
  });

  it("no derivable backend → the binary configured signal decides", () => {
    const yes = daemon("d1", { cyboRuntime: AUTHED_ANTHROPIC });
    const no = daemon("d2", { cyboRuntime: NO_AUTH, cyboInstalled: true });
    const r = cyboCapabilityFor([], [yes, no]);
    expect(r.configured.map((d) => d.id)).toEqual(["d1"]);
    expect(r.needsSetup.map((d) => d.id)).toEqual(["d2"]);
  });

  it("profile without a breakdown degrades to the binary signal", () => {
    const d = daemon("d1", {
      cyboRuntime: { configured: true, modelCount: 3, backends: [] },
    });
    expect(cyboCapabilityFor(["anthropic"], [d]).configured.map((x) => x.id)).toEqual(["d1"]);
  });

  it("a daemon that affirmatively reports NO runtime is excluded entirely", () => {
    const d = daemon("d1", { cyboInstalled: false });
    const r = cyboCapabilityFor(["anthropic"], [d]);
    expect(r.configured).toEqual([]);
    expect(r.needsSetup).toEqual([]);
    expect(r.unknown).toEqual([]);
  });
});

describe("native harness (provider IS the harness — internal docs)", () => {
  it("claude/codex are native harness cybos; runtime backends are not", () => {
    expect(isNativeHarnessCybo("claude")).toBe(true);
    expect(isNativeHarnessCybo("codex")).toBe(true);
    expect(isNativeHarnessCybo("pi")).toBe(false);
    expect(isNativeHarnessCybo("anthropic")).toBe(false);
    expect(isNativeHarnessCybo("opencode-go")).toBe(false);
  });

  it("native harness is available iff its OWN provider row is available (mirrors the daemon gate)", () => {
    const list = [
      { id: "claude", available: true },
      { id: "codex", available: false },
      { id: "pi", available: true },
    ];
    // claude connected → available
    expect(nativeHarnessAvailable("claude", list)).toBe(true);
    // codex present but unavailable → not available
    expect(nativeHarnessAvailable("codex", list)).toBe(false);
  });

  it("native harness with no provider row (snapshot lag) → not available (auto-heal re-probes)", () => {
    expect(nativeHarnessAvailable("claude", [{ id: "pi", available: true }])).toBe(false);
    expect(nativeHarnessAvailable("claude", [])).toBe(false);
  });

  it("a runtime provider never reads as a native harness, even if a row is available", () => {
    // The runtime credentials axis (cyboCapabilityFor) — NOT this helper — gates pi.
    expect(nativeHarnessAvailable("pi", [{ id: "pi", available: true }])).toBe(false);
    expect(nativeHarnessAvailable("anthropic", [{ id: "anthropic", available: true }])).toBe(false);
  });
});

describe("CTA shim", () => {
  it("routes to the daemon detail (the surface the embedded terminal will attach to)", () => {
    expect(cyboSetupHref("ws_1", "d_9")).toBe("/workspace/ws_1/daemons/d_9");
  });
  it("daemonDisplayName prefers the sticky PG label over the reported host (#441)", () => {
    // label is user-renamable and sticky; meta.host is the raw reported
    // hostname (an IP on networks without reverse-DNS).
    expect(
      daemonDisplayName({ ...daemon("d1", { host: "192.168.1.22" }), label: "Seb's daemon" }),
    ).toBe("Seb's daemon");
  });
  it("daemonDisplayName falls back host → id and strips the mDNS suffix", () => {
    expect(daemonDisplayName({ ...daemon("d1", { host: "Sebs-MacBook.local" }), label: "" })).toBe(
      "Sebs-MacBook",
    );
    expect(daemonDisplayName({ ...daemon("d2", {}), label: "Sebs-MacBook.local" })).toBe(
      "Sebs-MacBook",
    );
    expect(daemonDisplayName({ ...daemon("d3-12345678", {}), label: "" })).toBe("d3-12345");
  });
});
