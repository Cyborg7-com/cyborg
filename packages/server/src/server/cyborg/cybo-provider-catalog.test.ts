// Phase 2 (internal docs) NO-REGRESSION guarantee + catalog unit tests.
//
// The centerpiece is `legacyResolveCyboHarness` — a faithful copy of the
// pre-Phase-2 switch (the exact code that shipped before this change). The table
// test asserts that the NEW catalog-driven `resolveCyboHarness` returns
// BYTE-IDENTICAL output for a representative input matrix. If any row differs,
// that is a bug in the catalog — fix the catalog, not the test.

import { describe, expect, it } from "vitest";
import { NATIVE_CYBO_HARNESSES, resolveCyboHarness, type CyboHarness } from "./cybo-harness.js";
import { DEFAULT_RUNTIME, lookupProvider, PROVIDER_CATALOG } from "./provider-catalog.js";

// ─── The frozen LEGACY implementation (pre-Phase-2 — DO NOT "improve") ──
//
// Copied verbatim from cybo-harness.ts as it stood before the catalog rewrite.
// This is the oracle the new implementation must match.

const LEGACY_NATIVE = new Set(["claude", "codex"]);

function legacyResolvePiModelRef(provider: string, model: string | null): string | undefined {
  if (!model) return undefined;
  if (provider === "pi" || model.includes("/")) return model.replace(/^pi\//, "");
  return `${provider}/${model}`;
}

function legacyResolveCyboHarness(provider: string, model: string | null): CyboHarness {
  if (LEGACY_NATIVE.has(provider)) {
    return { provider: provider as "claude" | "codex", model: model ?? undefined };
  }
  return { provider: "pi", model: legacyResolvePiModelRef(provider, model) };
}

// ─── Representative input matrix ────────────────────────────────────────
//
// Covers: native verbatim, pi full-ref (with/without stray "pi/" prefix),
// runtime backend + bare id (the standalone shape), full-ref under a backend
// provider, null/empty/undefined-ish models, and providers NOT in the catalog
// (must hit the PI default). Each pair is run through BOTH implementations.

const PROVIDERS = [
  "claude",
  "codex",
  "pi",
  "opencode-go",
  "anthropic",
  "google",
  // Providers deliberately NOT in the catalog — must fall back to the PI default
  // exactly like the legacy "everything not native → pi" branch.
  "openrouter",
  "minimax",
  "groq",
  "some-unknown-backend",
];

const MODELS: (string | null)[] = [
  null,
  "",
  "glm-5.1",
  "opencode-go/glm-5.1",
  "pi/opencode-go/glm-5.1",
  "anthropic/claude-sonnet-4-5",
  "sonnet",
  "opus",
  "gpt-5-codex",
  "x-ai/grok-2",
  "MiniMax-M2",
];

describe("Phase 2 no-regression: catalog-driven resolveCyboHarness == legacy switch", () => {
  for (const provider of PROVIDERS) {
    for (const model of MODELS) {
      const label = `${provider} / ${model === null ? "null" : `"${model}"`}`;
      it(`byte-identical: ${label}`, () => {
        const legacy = legacyResolveCyboHarness(provider, model);
        const next = resolveCyboHarness(provider, model);
        // Deep-equal asserts identical keys, provider, and model (incl. undefined).
        expect(next).toEqual(legacy);
        // Belt-and-suspenders: assert the model field matches exactly, including
        // the undefined-vs-absent distinction the spawn config relies on.
        expect(next.model).toBe(legacy.model);
        expect(next.provider).toBe(legacy.provider);
      });
    }
  }

  it("covers every native and every catalog provider in the matrix", () => {
    // Guard against the matrix silently drifting away from the catalog.
    for (const id of Object.keys(PROVIDER_CATALOG)) {
      expect(PROVIDERS).toContain(id);
    }
  });
});

describe("resolveCyboHarness — explicit expected outputs (spec anchors)", () => {
  it("native claude passes model verbatim", () => {
    expect(resolveCyboHarness("claude", "sonnet")).toEqual({
      provider: "claude",
      model: "sonnet",
    });
  });

  it("native codex with no model yields undefined model", () => {
    expect(resolveCyboHarness("codex", null)).toEqual({
      provider: "codex",
      model: undefined,
    });
  });

  it("pi full-ref strips a stray leading pi/", () => {
    expect(resolveCyboHarness("pi", "pi/opencode-go/glm-5.1")).toEqual({
      provider: "pi",
      model: "opencode-go/glm-5.1",
    });
  });

  it("runtime backend + bare id joins backend/id (standalone shape)", () => {
    expect(resolveCyboHarness("opencode-go", "glm-5.1")).toEqual({
      provider: "pi",
      model: "opencode-go/glm-5.1",
    });
  });

  it("runtime backend + full ref is passed through as-is", () => {
    expect(resolveCyboHarness("anthropic", "anthropic/claude-sonnet-4-5")).toEqual({
      provider: "pi",
      model: "anthropic/claude-sonnet-4-5",
    });
  });

  it("unknown provider falls back to the PI runtime", () => {
    expect(resolveCyboHarness("openrouter", "x-ai/grok-2")).toEqual({
      provider: "pi",
      model: "x-ai/grok-2",
    });
  });

  it("pi with no model leaves model undefined (PI uses its default)", () => {
    expect(resolveCyboHarness("pi", null)).toEqual({ provider: "pi", model: undefined });
  });
});

describe("provider catalog — lookup + invariants", () => {
  it("exposes exactly claude and codex as native (parity with old hard-coded set)", () => {
    const native = Object.entries(PROVIDER_CATALOG)
      .filter(([, e]) => e.runtime === "native")
      .map(([id]) => id)
      .sort();
    expect(native).toEqual(["claude", "codex"]);
  });

  it("NATIVE_CYBO_HARNESSES is derived from the catalog and equals {claude, codex}", () => {
    expect([...NATIVE_CYBO_HARNESSES].sort()).toEqual(["claude", "codex"]);
  });

  it("lookupProvider returns the entry for a known provider", () => {
    const entry = lookupProvider("opencode-go");
    expect(entry?.runtime).toBe("pi");
    expect(entry?.wireProtocol).toBe("openai-completions");
    expect(entry?.baseURL).toBe("https://opencode.ai/zen/go/v1");
  });

  it("lookupProvider returns undefined for an unknown provider", () => {
    expect(lookupProvider("definitely-not-a-provider")).toBeUndefined();
  });

  it("the default runtime is pi (matches legacy 'everything not native → pi')", () => {
    expect(DEFAULT_RUNTIME).toBe("pi");
  });

  it("Phase 3 adds openai-compatible entries (MiniMax + OpenRouter) — and ONLY those", () => {
    // Phase 2 shipped zero; Phase 3 (internal docs) is the first to add raw-API
    // openai-compatible providers. They resolve like `pi` (no-regression — see
    // the byte-identical matrix above) but carry the api-key wiring metadata.
    const oc = Object.entries(PROVIDER_CATALOG)
      .filter(([, e]) => e.runtime === "openai-compatible")
      .map(([id]) => id)
      .sort();
    expect(oc).toEqual(["minimax", "openrouter"]);
    for (const id of oc) {
      const e = lookupProvider(id);
      // Each must declare the baseURL + apiKeyEnvVar Phase 3's injection relies on.
      expect(e?.wireProtocol, `${id} wireProtocol`).toBe("openai-completions");
      expect(e?.baseURL, `${id} baseURL`).toMatch(/^https:\/\//);
      expect(e?.apiKeyEnvVar, `${id} apiKeyEnvVar`).toMatch(/_API_KEY$/);
      expect(e?.authMethods, `${id} authMethods`).toContain("api");
    }
    expect(lookupProvider("openrouter")?.baseURL).toBe("https://openrouter.ai/api/v1");
    expect(lookupProvider("openrouter")?.apiKeyEnvVar).toBe("OPENROUTER_API_KEY");
    expect(lookupProvider("minimax")?.baseURL).toBe("https://api.minimax.io/v1");
    expect(lookupProvider("minimax")?.apiKeyEnvVar).toBe("MINIMAX_API_KEY");
  });

  it("every entry declares at least one auth method", () => {
    for (const [id, entry] of Object.entries(PROVIDER_CATALOG)) {
      expect(entry.authMethods.length, `${id} authMethods`).toBeGreaterThan(0);
    }
  });
});
