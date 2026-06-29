// Pure cybo-harness resolution — extracted from cybo-manager.ts so the relay's
// mention orchestrator (cybo-mention-invoke.ts) can import it WITHOUT pulling in
// cybo-manager's daemon-side surface (#697). cybo-manager re-exports these, so
// it stays the canonical place to find them and existing imports are unaffected.
// Zero runtime deps — safe for the EC2 relay bundle.

// Cybos run on Pi; build the Pi model reference ("backend/model") the same way a
// working Pi session does (provider="pi", model="opencode-go/glm-5.1"). TWO
// storage shapes exist and must both resolve correctly:
//   • new-cybo UI:   provider="pi"          + model="opencode-go/glm-5.1" (full ref)
//   • standalone:    provider="opencode-go" + model="glm-5.1"            (backend+id)
// Naive `${provider}/${model}` double-prefixed the first shape into
// "pi/opencode-go/glm-5.1", which Pi rejects ("Model not found"). Use the model
// as-is whenever it already carries the backend (provider==="pi" or it contains a
// "/"), stripping any stray leading "pi/"; otherwise join backend + id. No model
// → undefined (Pi falls back to its configured default).
function resolvePiModelRef(provider: string, model: string | null): string | undefined {
  if (!model) return undefined;
  if (provider === "pi" || model.includes("/")) return model.replace(/^pi\//, "");
  return `${provider}/${model}`;
}

// ─── Provider IS the harness (internal docs — supersedes "cybos always run on
// Pi" from internal docs) ──────────────────────────────────────────────────────
//
// cybo.provider names the HARNESS the cybo runs on:
//   • "claude" / "codex" → the daemon's NATIVE provider (reuses the host's own
//     Claude Code / Codex login — zero extra auth, billed to that plan).
//   • "pi" or any runtime backend (opencode-go, anthropic, google, …) → the
//     Cybo runtime, with the "backend/model" ref as before.
//
// Phase 2 (internal docs): resolution is now CATALOG-DRIVEN — the provider is
// looked up in `provider-catalog.ts` and its `runtime` selects the harness. The
// catalog is a SUPERSET of today's set, and the mapping is chosen so that
// claude/codex/pi/runtime-backends resolve BYTE-IDENTICALLY to the previous
// switch (guarded by cybo-provider-catalog.test.ts). An UNKNOWN provider falls
// back to DEFAULT_RUNTIME ("pi"), exactly matching the old "everything not
// native → pi" default.
import {
  DEFAULT_RUNTIME,
  lookupProvider,
  PROVIDER_CATALOG,
  type ProviderRuntime,
} from "./provider-catalog.js";

// Back-compat: the native provider set, now DERIVED from the catalog so there is
// one source of truth. Equals {claude, codex} today. Kept as a named export
// because cybo-manager re-exports it and other modules may reason about it.
export const NATIVE_CYBO_HARNESSES = new Set<string>(
  Object.entries(PROVIDER_CATALOG)
    .filter(([, entry]) => entry.runtime === "native")
    .map(([id]) => id),
);

export interface CyboHarness {
  // The AgentSessionConfig.provider to spawn on.
  provider: "claude" | "codex" | "pi";
  // The model to pass: native harnesses take the cybo's model verbatim (their
  // own ids); the runtime takes the "backend/model" ref.
  model: string | undefined;
}

export function resolveCyboHarness(provider: string, model: string | null): CyboHarness {
  // Catalog lookup → runtime. Unknown providers default to the PI runtime, which
  // preserves the legacy "everything not native → pi" behavior.
  const runtime: ProviderRuntime = lookupProvider(provider)?.runtime ?? DEFAULT_RUNTIME;

  if (runtime === "native") {
    // Native harnesses (claude/codex) take the cybo's model verbatim and spawn on
    // their own provider id. The catalog only ever marks claude/codex native, so
    // the cast stays sound.
    return { provider: provider as "claude" | "codex", model: model ?? undefined };
  }

  // "pi" and "openai-compatible" both run on the PI runtime and take a
  // "backend/model" ref. (Phase 2 ships no openai-compatible entry; Phase 3 adds
  // them. Resolution is identical for both — the distinction only gates Phase 3's
  // credential injection.)
  return { provider: "pi", model: resolvePiModelRef(provider, model) };
}
