// Phase 3 (internal docs) unit tests — the RAW-API openai-compatible path.
//
// Covers the two halves of the dark seam going live (NARROWLY):
//   1. models.json wiring (buildOpenAiCompatibleModelsConfig / write…): the
//      per-cybo manifest carries the verbatim baseUrl + api + `$ENV` apiKey ref +
//      headers + the host-verified model table — and NEVER a literal key.
//   2. credential resolution (resolveCyboCredentialPlan): the NON-NEGOTIABLE
//      no-regression guarantee (native / stock-PI cybos get an EMPTY plan, store
//      never consulted) + the api-key injection (openrouter/minimax) + the
//      pre-spawn refusal when the credential is missing.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CyboCredentialStore } from "./cybo-credentials.js";
import { resolveCyboHarness } from "./cybo-harness.js";
import {
  buildOpenAiCompatibleModelsConfig,
  CyboCredentialMissingError,
  resolveCyboCredentialPlan,
  writeOpenAiCompatibleModelsJson,
} from "./cybo-openai-compatible.js";
import { lookupProvider } from "./provider-catalog.js";
import type { StoredCybo } from "./cybo-types.js";

// A 32-byte base64 master key so the store is deterministic + self-contained.
const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

function makeCybo(overrides: Partial<StoredCybo> = {}): StoredCybo {
  return {
    id: "cybo_x",
    workspace_id: "ws_1",
    slug: "x",
    name: "Apex",
    description: null,
    avatar: null,
    role: null,
    soul: "soul",
    provider: "claude",
    model: null,
    mcp_servers: null,
    llm_auth_mode: "cli",
    behavior_mode: "responsive",
    home_daemon_id: null,
    monthly_spend_cap: null,
    platform_permissions: "[]",
    is_default: 0,
    created_by: "u",
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

describe("buildOpenAiCompatibleModelsConfig (PI models.json wiring, internal docs)", () => {
  it("OpenRouter: baseUrl + openai-completions + $ENV key (never literal) + X-Title", () => {
    const entry = lookupProvider("openrouter")!;
    const cfg = buildOpenAiCompatibleModelsConfig("openrouter", entry);
    const p = cfg.providers.openrouter;
    expect(p.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(p.api).toBe("openai-completions");
    // apiKey is the $VAR reference PI resolves from the child env — NOT a secret.
    expect(p.apiKey).toBe("$OPENROUTER_API_KEY");
    expect(p.headers).toEqual({ "X-Title": "Cyborg7" });
    // Curated model table present with host-verified ctx/cost (spend metering).
    const sonnet = p.models?.find((m) => m.id === "anthropic/claude-sonnet-4.5");
    expect(sonnet?.contextWindow).toBe(1_000_000);
    expect(sonnet?.cost?.input).toBe(3);
  });

  it("MiniMax: custom openai-compatible endpoint (.io/v1) + $MINIMAX_API_KEY", () => {
    const entry = lookupProvider("minimax")!;
    const cfg = buildOpenAiCompatibleModelsConfig("minimax", entry);
    const p = cfg.providers.minimax;
    expect(p.baseUrl).toBe("https://api.minimax.io/v1");
    expect(p.api).toBe("openai-completions");
    expect(p.apiKey).toBe("$MINIMAX_API_KEY");
    expect(p.models?.map((m) => m.id)).toContain("MiniMax-M2.7");
  });

  it("serialized manifest NEVER contains a literal key (only the $VAR reference)", () => {
    const cfg = buildOpenAiCompatibleModelsConfig("openrouter", lookupProvider("openrouter")!);
    const json = JSON.stringify(cfg);
    expect(json).toContain("$OPENROUTER_API_KEY");
    expect(json).not.toMatch(/sk-[A-Za-z0-9]/);
  });
});

describe("writeOpenAiCompatibleModelsJson (per-cybo PI agent dir)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "p3-models-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes a .pi-agent/models.json under the cwd and returns the dir", async () => {
    const dir = await writeOpenAiCompatibleModelsJson({
      baseDir: tmp,
      providerId: "openrouter",
      entry: lookupProvider("openrouter")!,
    });
    expect(dir).toBe(join(tmp, ".pi-agent"));
    const written = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
    expect(written.providers.openrouter.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(written.providers.openrouter.apiKey).toBe("$OPENROUTER_API_KEY");
  });
});

describe("resolveCyboCredentialPlan — NO-REGRESSION (native / stock-PI untouched)", () => {
  let tmp: string;
  let store: CyboCredentialStore;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "p3-noreg-"));
    store = new CyboCredentialStore({ baseDir: tmp, masterKeyBase64: MASTER_KEY });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // The centerpiece: a `cli`/native cybo and a stock `pi` cybo resolve to an
  // EMPTY plan — no env, no models.json, store never consulted — so their spawn
  // config + env stay BYTE-IDENTICAL to pre-P3.
  const UNCHANGED: { provider: string; model: string | null; mode: string }[] = [
    { provider: "claude", model: "claude-haiku-4-5", mode: "cli" },
    { provider: "codex", model: "gpt-5-codex", mode: "cli" },
    { provider: "pi", model: "opencode-go/glm-5.1", mode: "cli" },
    { provider: "opencode-go", model: "glm-5.1", mode: "cli" },
    { provider: "anthropic", model: "anthropic/claude-sonnet-4-5", mode: "api-key" },
    // An openai-compatible provider left on `cli` (not api) ALSO stays on the
    // legacy path — we never inject for a non-api mode.
    { provider: "openrouter", model: "openrouter/openai/gpt-5.1", mode: "cli" },
    // Unknown provider (defaults to PI runtime) — never the new branch.
    { provider: "groq", model: "groq/llama", mode: "api-key" },
  ];

  for (const c of UNCHANGED) {
    it(`EMPTY plan (no env, no models.json) for ${c.provider} / ${c.mode}`, async () => {
      const cybo = makeCybo({ provider: c.provider, model: c.model, llm_auth_mode: c.mode });
      const harness = resolveCyboHarness(c.provider, c.model);
      const plan = await resolveCyboCredentialPlan({
        cybo,
        harness,
        cwd: tmp,
        credentialStore: store,
      });
      expect(plan.env).toEqual({});
      expect(plan.piAgentDir).toBeUndefined();
      expect(plan.providerId).toBeUndefined();
    });
  }

  it("the store is never consulted for a native cybo (works even with NO store)", async () => {
    const cybo = makeCybo({ provider: "claude", model: "sonnet", llm_auth_mode: "cli" });
    const plan = await resolveCyboCredentialPlan({
      cybo,
      harness: resolveCyboHarness("claude", "sonnet"),
      cwd: tmp,
      credentialStore: undefined,
    });
    expect(plan.env).toEqual({});
  });
});

describe("resolveCyboCredentialPlan — openai-compatible + api (the new path)", () => {
  let tmp: string;
  let store: CyboCredentialStore;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "p3-newpath-"));
    store = new CyboCredentialStore({ baseDir: tmp, masterKeyBase64: MASTER_KEY });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("injects OPENROUTER_API_KEY + PI_CODING_AGENT_DIR and writes models.json", async () => {
    await store.setCredential("openrouter", { type: "api", key: "sk-or-secret-123" });
    const cybo = makeCybo({
      provider: "openrouter",
      model: "openrouter/anthropic/claude-sonnet-4.5",
      llm_auth_mode: "api-key",
    });
    const harness = resolveCyboHarness(cybo.provider, cybo.model);
    const plan = await resolveCyboCredentialPlan({
      cybo,
      harness,
      cwd: tmp,
      credentialStore: store,
    });
    expect(plan.env.OPENROUTER_API_KEY).toBe("sk-or-secret-123");
    expect(plan.env.PI_CODING_AGENT_DIR).toBe(join(tmp, ".pi-agent"));
    expect(plan.providerId).toBe("openrouter");
    // The models.json reached disk and references the $ENV (not the literal key).
    const written = JSON.parse(readFileSync(join(tmp, ".pi-agent", "models.json"), "utf8"));
    expect(written.providers.openrouter.apiKey).toBe("$OPENROUTER_API_KEY");
    expect(JSON.stringify(written)).not.toContain("sk-or-secret-123");
  });

  it("MiniMax: injects MINIMAX_API_KEY", async () => {
    await store.setCredential("minimax", { type: "api", key: "mm-secret" });
    const cybo = makeCybo({
      provider: "minimax",
      model: "minimax/MiniMax-M2.7",
      llm_auth_mode: "api-key",
    });
    const plan = await resolveCyboCredentialPlan({
      cybo,
      harness: resolveCyboHarness(cybo.provider, cybo.model),
      cwd: tmp,
      credentialStore: store,
    });
    expect(plan.env.MINIMAX_API_KEY).toBe("mm-secret");
  });

  it("REFUSES pre-spawn (CyboCredentialMissingError) when the credential is absent", async () => {
    const cybo = makeCybo({
      provider: "openrouter",
      model: "openrouter/openai/gpt-5.1",
      llm_auth_mode: "api-key",
    });
    await expect(
      resolveCyboCredentialPlan({
        cybo,
        harness: resolveCyboHarness(cybo.provider, cybo.model),
        cwd: tmp,
        credentialStore: store,
      }),
    ).rejects.toBeInstanceOf(CyboCredentialMissingError);
  });

  it("REFUSES when NO store is provided for an openai-compatible api cybo", async () => {
    const cybo = makeCybo({
      provider: "minimax",
      model: "minimax/MiniMax-M2",
      llm_auth_mode: "api-key",
    });
    await expect(
      resolveCyboCredentialPlan({
        cybo,
        harness: resolveCyboHarness(cybo.provider, cybo.model),
        cwd: tmp,
        credentialStore: undefined,
      }),
    ).rejects.toBeInstanceOf(CyboCredentialMissingError);
  });

  it("the refusal message names the provider but NEVER the key", async () => {
    await store.setCredential("openrouter", { type: "api", key: "leak-me" });
    const cybo = makeCybo({
      // minimax has no stored credential → refuses
      provider: "minimax",
      model: "minimax/MiniMax-M2",
      llm_auth_mode: "api-key",
    });
    const err = await resolveCyboCredentialPlan({
      cybo,
      harness: resolveCyboHarness(cybo.provider, cybo.model),
      cwd: tmp,
      credentialStore: store,
    }).catch((e: unknown) => e as CyboCredentialMissingError);
    expect(err).toBeInstanceOf(CyboCredentialMissingError);
    expect(err.message).toContain("minimax");
    expect(err.message).not.toContain("leak-me");
  });
});
