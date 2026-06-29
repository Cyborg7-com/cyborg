// Phase 3 (internal docs) — the RAW-API openai-compatible provider path.
//
// First real credential wiring: lets a cybo run on an API-key provider
// (MiniMax / OpenRouter) WITHOUT touching `agent/`. Two responsibilities, both
// daemon-side, both inside `cyborg/`:
//
//   1. PI awareness (writeOpenAiCompatibleModelsJson): write a per-cybo PI
//      agent dir seeded with a `models.json` describing the custom provider
//      (baseUrl + api + `apiKey: "$<ENV>"` + headers), so PI can reach the
// endpoint config-only (proven in internal docs SPIKE-PI). The dir is
//      handed to the child via `PI_CODING_AGENT_DIR`.
//   2. Credential resolution + injection (resolveCyboCredentialEnv): IF the
//      cybo's provider is `runtime: "openai-compatible"` AND its llm_auth_mode
//      resolves to an `api` credential, read the key from the P1 store and emit
//      the env the manifest's `$<ENV>` reads — through the EXISTING
//      `createAgent(config, agentId, { env })` seam (agent-manager.ts:801-811).
//
// NON-NEGOTIABLE no-regression (internal docs): native
// (claude/codex, "cli") and stock PI / opencode-go cybos NEVER enter this path —
// `resolveCyboCredentialEnv` returns an EMPTY plan for them, so their spawn env +
// launch config stay byte-identical to pre-P3. Only `openai-compatible` + an
// `api` credential gets the new env + models.json.
//
// Missing credential → a PRE-SPAWN refusal (CyboCredentialMissingError), never a
// silent failure; it rides the existing spawn-failure observability/notice path.
//
// Security: NEVER log the API key. The key lives in the child env (or the
// manifest `$VAR` reference) for the spawn's lifetime only; this module logs
// providerId + outcome only (internal docs).

import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import type { CyboHarness } from "./cybo-harness.js";
import type { CyboCredentialStore } from "./cybo-credentials.js";
import { credentialTypeForAuthMode } from "./cybo-credentials.js";
import { lookupProvider, type ProviderCatalogEntry } from "./provider-catalog.js";
import type { StoredCybo } from "./cybo-types.js";

// The PI config-root redirect env var (internal docs): redirects models.json +
// auth.json + sessions to a per-cybo dir, so we never mutate the host's shared
// ~/.pi/agent. `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR` in PI's config.js.
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

// ─── The PI models.json config shape (internal docs) ──
//
// What we AUTHOR is the *config* file PI merges over its built-in catalog on
// boot — a `providers` map. Each model is `{ id, name?, contextWindow?,
// maxTokens?, reasoning?, cost? }`. baseUrl + apiKey are REQUIRED for a custom
// (non-built-in) provider that declares a `models` array.

interface PiModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface PiModelEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  cost?: PiModelCost;
}

interface PiProviderConfig {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  models?: PiModelEntry[];
}

interface PiModelsConfig {
  providers: Record<string, PiProviderConfig>;
}

// Curated, host-verified per-provider model tables (internal docs §2.1).
// All ctx/cost numbers are copied verbatim from PI 0.78.0's models.generated.js —
// they feed true per-token cost into spend metering; do NOT estimate.
const OPENAI_COMPATIBLE_MODELS: Record<string, PiModelEntry[]> = {
  openrouter: [
    {
      id: "anthropic/claude-sonnet-4.5",
      name: "Anthropic: Claude Sonnet 4.5",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
    {
      id: "openai/gpt-5.1",
      name: "OpenAI: GPT-5.1",
      reasoning: true,
      contextWindow: 400_000,
      maxTokens: 128_000,
      cost: { input: 1.25, output: 10, cacheRead: 0.13, cacheWrite: 0 },
    },
    {
      id: "google/gemini-2.5-pro",
      name: "Google: Gemini 2.5 Pro",
      reasoning: true,
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0.375 },
    },
    {
      id: "deepseek/deepseek-v3.2-exp",
      name: "DeepSeek: DeepSeek V3.2 Exp",
      reasoning: true,
      contextWindow: 163_840,
      maxTokens: 65_536,
      cost: { input: 0.27, output: 0.41, cacheRead: 0, cacheWrite: 0 },
    },
    {
      id: "minimax/minimax-m2",
      name: "MiniMax: MiniMax M2",
      reasoning: true,
      contextWindow: 204_800,
      maxTokens: 196_608,
      cost: { input: 0.255, output: 1, cacheRead: 0.03, cacheWrite: 0 },
    },
    {
      id: "z-ai/glm-4.6",
      name: "Z.ai: GLM 4.6",
      reasoning: true,
      contextWindow: 202_752,
      maxTokens: 131_072,
      cost: { input: 0.43, output: 1.74, cacheRead: 0.08, cacheWrite: 0 },
    },
    {
      id: "qwen/qwen3-max",
      name: "Qwen: Qwen3 Max",
      reasoning: false,
      contextWindow: 262_144,
      maxTokens: 32_768,
      cost: { input: 0.78, output: 3.9, cacheRead: 0.156, cacheWrite: 0.975 },
    },
  ],
  minimax: [
    {
      id: "MiniMax-M2.7",
      name: "MiniMax M2.7",
      reasoning: true,
      contextWindow: 204_800,
      maxTokens: 131_072,
      cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
    },
    {
      id: "MiniMax-M2.7-highspeed",
      name: "MiniMax M2.7 Highspeed",
      reasoning: true,
      contextWindow: 204_800,
      maxTokens: 131_072,
      cost: { input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0.375 },
    },
    {
      id: "MiniMax-M2",
      name: "MiniMax M2",
      reasoning: true,
      contextWindow: 204_800,
      maxTokens: 196_608,
      cost: { input: 0.255, output: 1, cacheRead: 0.03, cacheWrite: 0 },
    },
  ],
};

// Thrown when an openai-compatible + api-key cybo has no credential on this
// daemon. Carries providerId so the caller can render a clear author refusal.
// NEVER carries the key.
export class CyboCredentialMissingError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly cyboName: string,
  ) {
    super(
      `${cyboName} needs an API key for "${providerId}" on this daemon — ` +
        `add it in workspace settings (provider credentials) before running it.`,
    );
    this.name = "CyboCredentialMissingError";
  }
}

// The plan a spawn applies: env to inject + an optional per-cybo PI agent dir to
// seed with the models.json. An EMPTY plan (no env, no dir) is the zero-regression
// default — every native / stock-PI cybo gets this and spawns exactly as before.
export interface CyboCredentialPlan {
  // Env injected via createAgent({ env }). Empty for the unchanged path.
  env: Record<string, string>;
  // When set, the spawn must write the models.json into this dir before spawn.
  piAgentDir?: string;
  // The catalog entry (only for the openai-compatible path) — carried so the
  // caller can write the matching models.json without a second lookup.
  catalogEntry?: ProviderCatalogEntry;
  // The providerId the models.json provider block is keyed by.
  providerId?: string;
}

const EMPTY_PLAN: CyboCredentialPlan = { env: {} };

// Build the per-cybo PI `models.json` config for an openai-compatible provider.
// Exported for unit tests (asserts baseUrl/api/$ENV reference + headers + model
// table) without touching disk.
export function buildOpenAiCompatibleModelsConfig(
  providerId: string,
  entry: ProviderCatalogEntry,
): PiModelsConfig {
  if (!entry.apiKeyEnvVar || !entry.baseURL) {
    // Defensive: the catalog must declare both for an openai-compatible entry.
    // The caller gates on runtime === "openai-compatible" before reaching here.
    throw new Error(
      `provider "${providerId}" is missing apiKeyEnvVar/baseURL — cannot build models.json`,
    );
  }
  const provider: PiProviderConfig = {
    name: entry.label,
    baseUrl: entry.baseURL,
    // The key is NEVER written literally — PI reads it from the child env at run
    // time via the `$VAR` form (internal docs). No secret lands on disk.
    apiKey: `$${entry.apiKeyEnvVar}`,
    api: entry.wireProtocol,
    ...(entry.extraHeaders ? { headers: { ...entry.extraHeaders } } : {}),
    models: OPENAI_COMPATIBLE_MODELS[providerId] ?? [],
  };
  return { providers: { [providerId]: provider } };
}

// Write the models.json into a per-cybo PI agent dir. Returns the dir so the
// caller threads it as PI_CODING_AGENT_DIR. Idempotent (overwrites).
export async function writeOpenAiCompatibleModelsJson(args: {
  baseDir: string; // the per-cybo cwd / sandbox; we nest a `.pi-agent` under it
  providerId: string;
  entry: ProviderCatalogEntry;
}): Promise<string> {
  const piAgentDir = join(args.baseDir, ".pi-agent");
  await fs.mkdir(piAgentDir, { recursive: true });
  const config = buildOpenAiCompatibleModelsConfig(args.providerId, args.entry);
  await fs.writeFile(join(piAgentDir, "models.json"), JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
  return piAgentDir;
}

// Resolve the credential PLAN for a cybo at spawn (internal docs).
//
//   - NOT openai-compatible (native claude/codex, stock pi, opencode-go, …)
//     → EMPTY_PLAN. The store is NEVER consulted. Byte-identical to pre-P3.
//   - openai-compatible but llm_auth_mode does NOT resolve to `api`
//     → EMPTY_PLAN (e.g. a misconfigured `cli` on an api provider stays on the
//       legacy path rather than silently injecting nothing different).
//   - openai-compatible + `api`:
//       • credential present → { env: { [ENV]: key }, piAgentDir, catalogEntry }
//       • credential absent  → throw CyboCredentialMissingError (pre-spawn refusal)
//
// `harness` is the already-resolved CyboHarness; for openai-compatible providers
// it is always `{ provider: "pi", ... }` (resolution is shared with stock pi).
export async function resolveCyboCredentialPlan(args: {
  cybo: Pick<StoredCybo, "provider" | "llm_auth_mode" | "name">;
  harness: CyboHarness;
  cwd: string;
  credentialStore: CyboCredentialStore | undefined;
  logger?: Pick<Logger, "info" | "warn">;
}): Promise<CyboCredentialPlan> {
  const { cybo, cwd, credentialStore, logger } = args;
  const entry = lookupProvider(cybo.provider);

  // Only the openai-compatible runtime enters the new path. Everything else —
  // including unknown providers (which default to the PI runtime) — is unchanged.
  if (!entry || entry.runtime !== "openai-compatible") {
    return EMPTY_PLAN;
  }

  // The cybo-facing power source must resolve to an `api` credential. If it does
  // not (e.g. the author left it on `cli`), do NOT inject anything — leave the
  // spawn on the legacy path. (internal docs reconciliation table.)
  if (credentialTypeForAuthMode(cybo.llm_auth_mode) !== "api") {
    return EMPTY_PLAN;
  }

  if (!entry.apiKeyEnvVar) {
    // An openai-compatible entry without an apiKeyEnvVar is a catalog bug; refuse
    // loudly rather than spawn an unauthed child that fails mid-turn.
    throw new CyboCredentialMissingError(cybo.provider, cybo.name);
  }

  // Resolve the key from the P1 store, keyed by providerId (internal docs).
  const cred = credentialStore ? await credentialStore.getCredential(cybo.provider) : undefined;
  if (!cred || cred.type !== "api") {
    // PRE-SPAWN refusal — never a silent failure (internal docs). The key is
    // not in this branch; nothing sensitive is logged.
    logger?.warn(
      { providerId: cybo.provider, event: "credential_missing" },
      "cybo-openai-compatible: no api credential for openai-compatible cybo, refusing spawn",
    );
    throw new CyboCredentialMissingError(cybo.provider, cybo.name);
  }

  const piAgentDir = await writeOpenAiCompatibleModelsJson({
    baseDir: cwd,
    providerId: cybo.provider,
    entry,
  });

  logger?.info(
    { providerId: cybo.provider, event: "credential_injected" },
    "cybo-openai-compatible: injected api credential + models.json for openai-compatible cybo",
  );

  return {
    env: {
      [entry.apiKeyEnvVar]: cred.key,
      [PI_AGENT_DIR_ENV]: piAgentDir,
    },
    piAgentDir,
    catalogEntry: entry,
    providerId: cybo.provider,
  };
}

// Exposed for tests that want the model tables without reaching into the module.
export const __testing = { OPENAI_COMPATIBLE_MODELS, PI_AGENT_DIR_ENV };
