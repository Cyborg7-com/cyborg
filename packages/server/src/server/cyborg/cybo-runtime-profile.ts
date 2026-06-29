// Cybo runtime capability profile — the AUTHENTICATED dimension of the runtime,
// published per daemon so the UI can show real capability instead of assuming.
//
// internal docs fact A vs fact B: "binary installed" (cybo_cli_status) is not
// "usable". A cybo runs on the cybo runtime with a model ref "backend/model"
// (internal docs Option A), and each BACKEND (anthropic / opencode-go / openai …)
// needs its own credentials inside the runtime. The signal here is exactly the
// one `PiRpcAgentClient.isAvailable()` already uses — the runtime's model list —
// re-read from the provider snapshot's CACHED entry (no extra probes) and broken
// down by backend (the model-id prefix). If ids carry no backend prefix the
// breakdown degrades to the binary signal: configured + total modelCount.
//
// Consumed by: bootstrap (computes + refreshes) → DaemonRelayClient meta
// (hello + heartbeat) → relay DaemonMetaSchema → daemons.meta → UI wizard rows
// and cybo cards (internal docs auth-UX spec, item 3).

import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";

export interface CyboRuntimeBackend {
  backend: string;
  modelCount: number;
}

export interface CyboRuntimeProfile {
  // ≥1 model is listed — the same bar isAvailable() sets. NOTE this means
  // credentials are PRESENT, not that they are valid: the runtime lists models
  // for any configured backend without validating the key (verified
  // empirically — a bogus key still lists). There is no cheap real-validation
  // signal to publish, so we deliberately don't pretend to have one; an invalid
  // key surfaces at session time. False covers both "no credentials" and
  // "runtime can't list models" (indistinguishable here).
  configured: boolean;
  modelCount: number;
  // Per-backend breakdown when model ids expose it ("backend/model"); empty
  // when only the binary signal is derivable.
  backends: CyboRuntimeBackend[];
}

// Group model ids by their backend prefix. Ids without a "/" don't name a
// backend — they still count toward modelCount (binary signal) but produce no
// backend row, so consumers never see an invented backend name.
export function profileFromModelIds(modelIds: readonly string[]): CyboRuntimeProfile {
  const byBackend = new Map<string, number>();
  for (const id of modelIds) {
    const slash = id.indexOf("/");
    if (slash <= 0) continue;
    const backend = id.slice(0, slash);
    byBackend.set(backend, (byBackend.get(backend) ?? 0) + 1);
  }
  return {
    configured: modelIds.length > 0,
    modelCount: modelIds.length,
    backends: [...byBackend.entries()]
      .map(([backend, modelCount]) => ({ backend, modelCount }))
      .sort((a, b) => a.backend.localeCompare(b.backend)),
  };
}

// Read the runtime profile from the provider snapshot's CACHED pi entry — a
// plain cache read (no `wait`), so this never triggers a probe and is safe to
// call on a timer. Returns null when the snapshot has no pi entry yet (e.g.
// first seconds after boot) so callers can omit the field instead of publishing
// a false "unconfigured".
export async function buildCyboRuntimeProfile(
  manager: Pick<ProviderSnapshotManager, "listProviders"> | null,
): Promise<CyboRuntimeProfile | null> {
  if (!manager) return null;
  try {
    const entries = await manager.listProviders({ providers: ["pi"] });
    const pi = entries.find((entry) => entry.provider === "pi");
    if (!pi || pi.status === "loading") return null;
    const ids = (pi.models ?? []).map((m) => m.id);
    // A non-ready pi (unavailable/error) has no usable models regardless of
    // what a stale models array says — publish the honest binary signal.
    if (pi.status !== "ready") return { configured: false, modelCount: 0, backends: [] };
    return profileFromModelIds(ids);
  } catch {
    return null;
  }
}

// ─── Per-backend spawn gate ──────────────────────────────────────────────────
//
// The spawn guard used to be BINARY ("runtime lists ≥1 model"), so a cybo
// pinned to anthropic opened a chat on a daemon whose runtime only had
// opencode-go configured — and died on the FIRST TURN with the runtime's
// raw "No API key found for the selected model". The runtime's model list
// already exposes configuration PER BACKEND (the id prefixes — the same
// breakdown the #398 capability meta publishes); this gate connects the spawn
// to it so a doomed chat is refused BEFORE it opens.

// The backend (model-id prefix) the cybo's pinned model needs, or null when no
// specific backend is derivable (no model → the runtime's default; capability
// is then the binary signal). Mirrors resolvePiModelRef in cybo-manager.ts.
export function cyboRequiredBackend(provider: string, model: string | null): string | null {
  let ref: string | null;
  if (!model) {
    ref = null;
  } else if (provider === "pi" || model.includes("/")) {
    ref = model.replace(/^pi\//, "");
  } else {
    ref = `${provider}/${model}`;
  }
  if (!ref) return null;
  const slash = ref.indexOf("/");
  return slash > 0 ? ref.slice(0, slash) : null;
}

// Decide whether the spawn may proceed for `backend` given the runtime's model
// ids. Returns null to ALLOW, or the missing backend name to REFUSE.
// Backward/limited-data compatible — falls back to the binary verdict (which
// the caller has already passed) whenever a per-backend answer isn't derivable:
//   • backend null (no pinned model)            → allow
//   • no per-backend breakdown in the ids       → allow (old/plain runtimes)
export function findBackendGap(modelIds: readonly string[], backend: string | null): string | null {
  if (!backend) return null;
  const profile = profileFromModelIds(modelIds);
  if (profile.backends.length === 0) return null;
  const hit = profile.backends.some((b) => b.backend === backend && b.modelCount > 0);
  return hit ? null : backend;
}

// Branded display name for a backend in user-facing copy (never the runtime's
// internal name).
const BACKEND_DISPLAY: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

export function backendDisplayName(backend: string): string {
  return BACKEND_DISPLAY[backend] ?? backend;
}

// The pre-spawn refusal, branded (internal docs): name the cybo, the backend it
// needs, and the remedy — shown INSTEAD of opening a chat that dies on turn 1.
// Native-harness gate (internal docs — provider IS the harness): a cybo whose
// provider is a NATIVE daemon harness (claude/codex) must spawn on that
// provider, with NO silent fallback to the runtime. When the daemon doesn't
// have it available, refuse pre-spawn with the remedy.
export const NATIVE_HARNESS_DISPLAY: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
};

// The CLI login command for each native harness — the concrete "HOW to fix it"
// the user runs ON THE DAEMON's machine to sign that provider in.
const NATIVE_HARNESS_LOGIN_CMD: Record<string, string> = {
  claude: "claude login",
  codex: "codex login",
};

// Pre-spawn / pre-reply refusal for a NATIVE harness (internal docs
// PART 1). Tells the user WHY the cybo can't reply HERE and the CONCRETE fix: run
// the harness login on THAT daemon (named, when we know it), or @-mention the cybo
// on a daemon that's already signed in. Branded — never leaks the harness's
// internal name. `daemonLabel` (the daemon's host/display name) is woven in when
// the call site has it, so the user knows exactly WHICH machine to sign in.
export function nativeHarnessGapMessage(
  cyboName: string,
  harness: string,
  daemonLabel?: string | null,
): string {
  const label = NATIVE_HARNESS_DISPLAY[harness] ?? harness;
  const loginCmd = NATIVE_HARNESS_LOGIN_CMD[harness] ?? `${harness} login`;
  const where = daemonLabel ? `the daemon **${daemonLabel}**` : "this daemon";
  return (
    `**${cyboName}** can't reply here — ${where} has no **${label}** login. ` +
    `Fix: run \`${loginCmd}\` on that machine, or @-mention **${cyboName}** on a ` +
    `daemon that's signed in to ${label}.`
  );
}

export function spawnBackendGapMessage(cyboName: string, backend: string): string {
  return (
    `${cyboName} needs ${backendDisplayName(backend)} — the Cybo runtime on this daemon ` +
    `isn't connected to it. Set up Cybo on this daemon (cybo login), or start it on a ` +
    `daemon that has ${backendDisplayName(backend)} connected.`
  );
}
