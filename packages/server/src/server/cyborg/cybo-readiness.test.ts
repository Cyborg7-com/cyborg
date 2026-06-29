import { describe, expect, it } from "vitest";
import {
  computeCyboReadiness,
  cyboBackendOf,
  readinessDaemonsFrom,
  type ReadinessDaemon,
} from "./cybo-readiness.js";

const offline: ReadinessDaemon = { online: false };
const online = (cyboRuntime?: ReadinessDaemon["cyboRuntime"]): ReadinessDaemon => ({
  online: true,
  cyboRuntime,
});
const runtime = (backends: { backend: string; modelCount: number }[]): ReadinessDaemon =>
  online({ configured: backends.some((b) => b.modelCount > 0), backends });

describe("cyboBackendOf", () => {
  it("reads the backend from a 'backend/model' ref", () => {
    expect(cyboBackendOf("pi", "opencode-go/glm-5.1")).toBe("opencode-go");
  });
  it("strips a stray leading pi/", () => {
    expect(cyboBackendOf("pi", "pi/opencode-go/glm-5.1")).toBe("opencode-go");
  });
  it("treats a slugless provider as the backend (standalone shape)", () => {
    expect(cyboBackendOf("opencode-go", "glm-5.1")).toBe("opencode-go");
  });
  it("returns null when only the runtime itself is named", () => {
    expect(cyboBackendOf("pi", null)).toBeNull();
  });
});

describe("computeCyboReadiness", () => {
  it("needs-daemon when nothing is online (the #636 empty-roster case)", () => {
    expect(computeCyboReadiness("opencode-go", "glm-5.1", [offline, offline])).toBe("needs-daemon");
    expect(computeCyboReadiness("opencode-go", "glm-5.1", [])).toBe("needs-daemon");
  });

  it("ready when an online daemon's runtime lists the backend", () => {
    const daemons = [runtime([{ backend: "opencode-go", modelCount: 3 }])];
    expect(computeCyboReadiness("opencode-go", "glm-5.1", daemons)).toBe("ready");
    expect(computeCyboReadiness("pi", "opencode-go/glm-5.1", daemons)).toBe("ready");
  });

  it("needs-daemon when the online runtime can't run this backend", () => {
    const daemons = [runtime([{ backend: "anthropic", modelCount: 2 }])];
    expect(computeCyboReadiness("opencode-go", "glm-5.1", daemons)).toBe("needs-daemon");
  });

  it("needs-daemon when the online daemon has no runtime installed", () => {
    const daemons: ReadinessDaemon[] = [{ online: true, cyboInstalled: false }];
    expect(computeCyboReadiness("opencode-go", "glm-5.1", daemons)).toBe("needs-daemon");
  });

  it("created (neutral) when only profile-less older daemons are online", () => {
    const daemons: ReadinessDaemon[] = [{ online: true }];
    expect(computeCyboReadiness("opencode-go", "glm-5.1", daemons)).toBe("created");
  });

  it("native harness: ready when an online daemon advertises the harness logged in (#795)", () => {
    // The honest daemon_hello list (providers) carries the native id ONLY when
    // the host is actually logged in — so its presence means "Active"/Start chat.
    const daemons: ReadinessDaemon[] = [{ online: true, providers: ["claude", "pi"] }];
    expect(computeCyboReadiness("claude", "claude-opus-4-6", daemons)).toBe("ready");
    const codexDaemon: ReadinessDaemon[] = [{ online: true, providers: ["codex"] }];
    expect(computeCyboReadiness("codex", "gpt-5", codexDaemon)).toBe("ready");
  });

  it("native harness: needs-daemon when online daemons report a list but none has the login", () => {
    // Daemon is online and HONEST (reports providers), but claude is absent →
    // every capable host is signed out → the actionable "Needs setup" state.
    const daemons: ReadinessDaemon[] = [{ online: true, providers: ["pi", "opencode-go"] }];
    expect(computeCyboReadiness("claude", "claude-opus-4-6", daemons)).toBe("needs-daemon");
  });

  it("native harness: ready wins over a peer that lacks the login", () => {
    const daemons: ReadinessDaemon[] = [
      { online: true, providers: ["pi"] },
      { online: true, providers: ["claude"] },
    ];
    expect(computeCyboReadiness("claude", "claude-opus-4-6", daemons)).toBe("ready");
  });

  it("native harness: created (neutral) when only providers-less older daemons are online", () => {
    // An older daemon that never reported a provider list → indeterminate, no alarm.
    const daemons = [runtime([{ backend: "anthropic", modelCount: 1 }])];
    expect(computeCyboReadiness("claude", "claude-opus-4-6", daemons)).toBe("created");
    expect(computeCyboReadiness("codex", "gpt-5", daemons)).toBe("created");
  });

  it("native harness: needs-daemon when nothing is online", () => {
    expect(computeCyboReadiness("claude", "claude-sonnet-4-6", [offline])).toBe("needs-daemon");
  });

  it("degrades (never throws) on malformed legacy daemon meta", () => {
    // backends is not an array (loose PG JSONB / older daemon) → fall back to the
    // binary `configured` signal instead of throwing.
    const bad = [
      { online: true, cyboRuntime: { configured: true, backends: "oops" } },
    ] as unknown as ReadinessDaemon[];
    expect(computeCyboReadiness("opencode-go", "glm-5.1", bad)).toBe("ready");
    // a null entry inside backends must be skipped, not dereferenced.
    const nullEntry = [
      { online: true, cyboRuntime: { configured: false, backends: [null] } },
    ] as unknown as ReadinessDaemon[];
    expect(computeCyboReadiness("opencode-go", "glm-5.1", nullEntry)).toBe("needs-daemon");
  });

  it("hardening (#720): a non-object cyboRuntime profile can't be trusted as configured", () => {
    // A forged/legacy heartbeat where cyboRuntime is a string or an array (not an
    // object) must NOT be read field-by-field — it degrades to "not configured",
    // so the only-online-daemon collapses to needs-daemon, never a crash.
    for (const forged of ["configured", 42, true, ["anthropic"]] as unknown[]) {
      const daemons = [{ online: true, cyboRuntime: forged }] as unknown as ReadinessDaemon[];
      expect(computeCyboReadiness("opencode-go", "glm-5.1", daemons)).toBe("needs-daemon");
    }
  });

  it("hardening (#720): a backend entry that's an array (not a plain object) is skipped", () => {
    // `typeof [] === "object"` — an array entry would have slipped past a bare
    // typeof guard and read .backend/.modelCount as undefined. isPlainObject
    // rejects it, so it doesn't count as a configured backend.
    const arrayEntry = [
      { online: true, cyboRuntime: { configured: false, backends: [["opencode-go", 3]] } },
    ] as unknown as ReadinessDaemon[];
    expect(computeCyboReadiness("opencode-go", "glm-5.1", arrayEntry)).toBe("needs-daemon");
  });

  it("hardening (#720): a non-finite modelCount (Infinity) doesn't count as configured", () => {
    // Infinity > 0 is true — a bare typeof guard would let a forged Infinity
    // through. Number.isFinite rejects it (and NaN).
    const inf = [
      {
        online: true,
        cyboRuntime: {
          configured: false,
          backends: [{ backend: "opencode-go", modelCount: Infinity }],
        },
      },
    ] as unknown as ReadinessDaemon[];
    expect(computeCyboReadiness("opencode-go", "glm-5.1", inf)).toBe("needs-daemon");
  });

  it("hardening (#720): a non-object profile with no derivable backend is not 'ready'", () => {
    // backend === null path (pi + no model) must also guard the profile: a
    // non-object profile → not configured → not ready.
    const daemons = [{ online: true, cyboRuntime: "configured" }] as unknown as ReadinessDaemon[];
    expect(computeCyboReadiness("pi", null, daemons)).toBe("needs-daemon");
  });

  it("ready wins over an incapable peer", () => {
    const daemons = [
      runtime([{ backend: "anthropic", modelCount: 1 }]),
      runtime([{ backend: "opencode-go", modelCount: 5 }]),
    ];
    expect(computeCyboReadiness("opencode-go", "glm-5.1", daemons)).toBe("ready");
  });
});

describe("readinessDaemonsFrom", () => {
  it("marks online by membership in the connected set and reads meta", () => {
    const rows = [
      { id: "a", meta: { cyboRuntime: { configured: true, backends: [] } } },
      { id: "b", meta: { cyboInstalled: false } },
      { id: "c", meta: null },
    ];
    const result = readinessDaemonsFrom(rows, new Set(["a"]));
    expect(result[0]).toEqual({
      online: true,
      cyboInstalled: undefined,
      cyboRuntime: { configured: true, backends: [] },
      providers: undefined,
    });
    expect(result[1].online).toBe(false);
    expect(result[1].cyboInstalled).toBe(false);
    expect(result[2]).toEqual({
      online: false,
      cyboInstalled: undefined,
      cyboRuntime: undefined,
      providers: undefined,
    });
  });

  it("threads the live honest provider list per daemon (#795)", () => {
    const rows = [
      { id: "a", meta: null },
      { id: "b", meta: null },
    ];
    const providersFor = (id: string): string[] | undefined =>
      id === "a" ? ["claude", "pi"] : undefined;
    const result = readinessDaemonsFrom(rows, new Set(["a", "b"]), providersFor);
    expect(result[0].providers).toEqual(["claude", "pi"]);
    expect(result[1].providers).toBeUndefined();
    // End-to-end: the logged-in native id makes the native cybo ready.
    expect(computeCyboReadiness("claude", "claude-opus-4-6", result)).toBe("ready");
  });
});
