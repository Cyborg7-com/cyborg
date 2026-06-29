// Provider catalog for cybo harness resolution (TRACK A / Phase 2).
//
// A manifest that maps `providerId → { runtime, wireProtocol, baseURL?,
// authMethods, models }`, modeled 1:1 on PI's own model schema
// (`@earendil-works/pi-ai/dist/models.generated.js`: a model is
// `{ api, baseUrl, provider, … }` keyed by ~6 wire protocols). This is the
// OpenClaw "provider is a manifest, not code" property — proven config-only in
// internal docs (SPIKE-PI). See internal docs for the decision.
//
// SCOPE (Phase 2): make `resolveCyboHarness` CATALOG-DRIVEN for the EXISTING
// provider set with ZERO behavior regression. The catalog here is a SUPERSET of
// today's hard-coded set (claude/codex native; pi + runtime backends on PI). It
// does NOT yet wire any raw-API provider (MiniMax/OpenRouter) into resolution —
// that is Phase 3, which only adds a catalog entry + the credential-injection
// seam. Adding a provider becomes a catalog entry, not code.
//
// The vendored `models` lists are a snapshot consistent with PI's
// `models.generated.js` format (internal docs). They are advisory metadata for
// the UI wizard and capability checks; resolution itself only needs `runtime`.
// Do NOT hard-fail on a model that is absent from the snapshot (internal docs
// "models.dev snapshot staleness").

// ─── Catalog types ─────────────────────────────────────────────────────
//
// `runtime` selects the harness:
//   - "native"            → the daemon's own provider (claude/codex host login);
//                           model is passed verbatim (the provider's own ids).
//   - "pi"                → the Cybo PI runtime with a "backend/model" ref.
//   - "openai-compatible" → also runs ON the PI runtime (PI's openai-completions
//                           wire handler), but flagged distinctly so Phase 3 can
//                           gate the api-key injection path. For RESOLUTION it
//                           behaves exactly like "pi" (a "backend/model" ref).
export type ProviderRuntime = "native" | "pi" | "openai-compatible";

// The wire protocol PI dispatches on (`api` in models.generated.js). ~6 values;
// "native" providers carry their own client so the field is informational.
export type WireProtocol =
  | "native"
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "google"
  | "google-vertex";

// How a provider can be authenticated (mirrors the credential union in
// cybo-credentials.ts / internal docs). Advisory for the wizard; resolution does
// not consult it.
export type ProviderAuthMethod = "cli" | "api" | "oauth" | "wellknown";

export interface ProviderCatalogEntry {
  // Human-facing label for the wizard.
  label: string;
  // Which harness this provider resolves to (see ProviderRuntime).
  runtime: ProviderRuntime;
  // PI wire protocol (`api`). "native" for claude/codex host-login providers.
  wireProtocol: WireProtocol;
  // Endpoint for openai-compatible / custom providers (Phase 3 consumes this).
  // Absent for native + built-in PI backends (PI already knows their baseUrl).
  baseURL?: string;
  // Auth methods this provider supports (advisory; first entry is the default).
  authMethods: ProviderAuthMethod[];
  // The env var the daemon injects the resolved API key under at spawn (Phase 3).
  // PI's per-cybo models.json references it as `$<apiKeyEnvVar>`. Only meaningful
  // for `runtime: "openai-compatible"` + an `api` credential — internal docs
  apiKeyEnvVar?: string;
  // Extra per-request headers PI must send (non-auth). E.g. OpenRouter's
  // `X-Title` ranking header (internal docs). Never carries secrets.
  extraHeaders?: Record<string, string>;
  // Optional model snapshot (PI models.generated.js format). Advisory metadata —
  // never a hard gate on resolution.
  models?: string[];
}

export type ProviderCatalog = Record<string, ProviderCatalogEntry>;

// ─── The seeded catalog (superset of today) ────────────────────────────
//
// Native subscription harnesses (internal docs: "provider IS the harness"). These
// MUST stay the only two "native" entries to keep parity with today's
// NATIVE_CYBO_HARNESSES = {claude, codex}.
//
// PI-runtime backends: the providers a cybo can name today and have run on the PI
// runtime via a "backend/model" ref. `pi` is the generic entry (model already
// carries the backend); the named backends mirror common entries in PI's bundled
// snapshot. Adding more here is pure config.
export const PROVIDER_CATALOG: ProviderCatalog = {
  // ── Native (host login, verbatim model) ──
  claude: {
    label: "Claude (native)",
    runtime: "native",
    wireProtocol: "native",
    authMethods: ["cli", "oauth"],
    models: ["sonnet", "opus", "haiku"],
  },
  codex: {
    label: "Codex (native)",
    runtime: "native",
    wireProtocol: "native",
    authMethods: ["cli", "oauth"],
    models: ["gpt-5-codex", "gpt-5"],
  },

  // ── PI runtime backends ("backend/model" ref) ──
  // Generic PI entry: the cybo's model already carries the backend (e.g.
  // "opencode-go/glm-5.1"); resolution strips any stray leading "pi/".
  pi: {
    label: "Pi runtime",
    runtime: "pi",
    wireProtocol: "openai-completions",
    authMethods: ["cli", "api"],
  },
  "opencode-go": {
    label: "opencode (zen/go)",
    runtime: "pi",
    wireProtocol: "openai-completions",
    baseURL: "https://opencode.ai/zen/go/v1",
    authMethods: ["api"],
    models: ["glm-5.1", "deepseek-v4-flash"],
  },
  anthropic: {
    label: "Anthropic (API)",
    runtime: "pi",
    wireProtocol: "anthropic-messages",
    authMethods: ["api"],
    models: ["claude-sonnet-4-5", "claude-opus-4-1"],
  },
  google: {
    label: "Google Gemini (API)",
    runtime: "pi",
    wireProtocol: "google",
    authMethods: ["api"],
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },

  // ── Raw-API openai-compatible providers (Phase 3, internal docs) ──
  // These resolve to the SAME PI runtime "backend/model" ref as the "pi" entries
  // (PI dispatches openai-completions by `api`); the distinct `runtime` flag is
  // ONLY what gates Phase 3's api-key credential injection + per-cybo models.json.
  // The baseURL + apiKeyEnvVar below are the verbatim, host-verified values from
  // internal docs — do NOT estimate. resolveCyboHarness keeps producing the legacy
  // PI ref for these (no-regression: openai-compatible behaves like pi for
  // resolution), so adding them here cannot change how an existing cybo spawns.
  openrouter: {
    label: "OpenRouter (API)",
    runtime: "openai-compatible",
    wireProtocol: "openai-completions",
    baseURL: "https://openrouter.ai/api/v1",
    authMethods: ["api"],
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    extraHeaders: { "X-Title": "Cyborg7" },
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
  minimax: {
    label: "MiniMax (API)",
    runtime: "openai-compatible",
    wireProtocol: "openai-completions",
    baseURL: "https://api.minimax.io/v1",
    authMethods: ["api"],
    apiKeyEnvVar: "MINIMAX_API_KEY",
    models: ["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2"],
  },
};

// Look up a provider in the catalog. Returns undefined for an unknown provider —
// callers must apply the catalog DEFAULT (PI runtime), which preserves today's
// "everything not native → pi" behavior for providers not yet vendored. See
// resolveCyboHarness for the use of this default.
export function lookupProvider(providerId: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG[providerId];
}

// The runtime an unknown provider falls back to. Today's switch sends every
// non-native provider to PI, so an unknown providerId must resolve to "pi" — NOT
// "openai-compatible" (that would change the resolution shape). Keeping this as a
// named constant documents the no-regression contract.
export const DEFAULT_RUNTIME: ProviderRuntime = "pi";
