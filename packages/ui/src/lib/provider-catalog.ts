// UI mirror of the server's openai-compatible provider catalog (internal docs
// internal docs). The daemon's `cyborg:list_providers` RPC only reports the host's
// NATIVE providers (claude/codex/pi + whatever CLIs are installed) — it does NOT
// expose the static `provider-catalog.ts` manifest that adds the raw-API
// openai-compatible providers (MiniMax, OpenRouter). Those are pure configuration
// (a baseURL + an api-key env var + a model snapshot), so the wizard surfaces them
// from this vendored snapshot, mirroring the server catalog 1:1.
//
// Keep this in sync with `packages/server/src/server/cyborg/provider-catalog.ts`
// (the `runtime: "openai-compatible"` entries). When the server grows an RPC that
// serves the catalog, swap this constant for that response — the shape is the same.
//
// SECRET HYGIENE (internal docs): nothing here holds a key. These are provider
// DEFINITIONS (baseURL, env-var name, model list). The actual key is write-only,
// stored per-daemon via `cyborg:set_cybo_credential`, surfaced only as set/not-set
// metadata via `cyborg:list_provider_auth`.

import type { ProviderInfo } from "./plugins/agents/types.js";

// An openai-compatible (raw-API) provider definition — the `api`-auth path. These
// run on the daemon's PI runtime via the openai-completions wire handler, gated on
// an API key the user supplies (internal docs).
export interface ApiKeyProvider {
  id: string;
  label: string;
  description: string;
  // The env var the daemon injects the key as at spawn (advisory — for copy only).
  apiKeyEnvVar: string;
  // Where to get a key (shown next to the entry field).
  consoleUrl?: string;
  // Curated model slugs (internal docs/§2.1). Model id form is provider-native:
  // `vendor/model` for OpenRouter, a bare name for MiniMax.
  models: string[];
}

// Vendored snapshot of the server catalog's `runtime: "openai-compatible"` entries
// (internal docs). Verbatim baseURL / env-var / model values — do NOT estimate.
export const API_KEY_PROVIDERS: ApiKeyProvider[] = [
  {
    id: "openrouter",
    label: "OpenRouter (API)",
    description: "300+ models behind one API key — Claude, GPT, Gemini, DeepSeek, and more.",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    consoleUrl: "https://openrouter.ai/keys",
    models: [
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-5.1",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-v3.2-exp",
      "minimax/minimax-m2",
      "z-ai/glm-4.6",
      "qwen/qwen3-max",
    ],
  },
  {
    id: "minimax",
    label: "MiniMax (API)",
    description: "MiniMax models via the OpenAI-compatible endpoint, authed with an API key.",
    apiKeyEnvVar: "MINIMAX_API_KEY",
    consoleUrl: "https://platform.minimax.io",
    models: ["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2"],
  },
];

const API_KEY_PROVIDER_IDS = new Set(API_KEY_PROVIDERS.map((p) => p.id));

// Is this provider id an api-key (openai-compatible) provider from the catalog?
export function isApiKeyProvider(providerId: string | null | undefined): boolean {
  return providerId != null && API_KEY_PROVIDER_IDS.has(providerId);
}

export function apiKeyProviderById(providerId: string | null | undefined): ApiKeyProvider | null {
  if (providerId == null) return null;
  return API_KEY_PROVIDERS.find((p) => p.id === providerId) ?? null;
}

// The `llm_auth_mode` an api-key provider implies (internal docs: the column
// value is `"api-key"`, the stored credential `type` is `"api"`).
export const API_KEY_AUTH_MODE = "api-key";

// Render an api-key provider as a `ProviderInfo` so it slots into the existing
// provider-row UI alongside the daemon's native providers. `available: true`
// because availability for these is "is a key set?", surfaced separately by the
// credential field — the row itself is always selectable (the cybo just records
// which provider it should use; the key is configured per daemon).
export function apiKeyProviderInfo(p: ApiKeyProvider): ProviderInfo {
  return {
    id: p.id,
    label: p.label,
    description: p.description,
    available: true,
    models: p.models.map((id) => ({ id })),
    modes: [],
    defaultModeId: null,
  };
}

// Merge the vendored api-key providers into the daemon's native provider list,
// de-duplicating by id (a native row always wins — if a daemon ever reports one of
// these natively, that real, probed row is the source of truth).
export function withApiKeyProviders(native: ProviderInfo[]): ProviderInfo[] {
  const seen = new Set(native.map((p) => p.id));
  const extra = API_KEY_PROVIDERS.filter((p) => !seen.has(p.id)).map(apiKeyProviderInfo);
  return [...native, ...extra];
}
