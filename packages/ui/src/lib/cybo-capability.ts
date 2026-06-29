// Cybo capability per daemon — pure helpers behind the wizard's provider rows
// and the cybo cards (internal docs auth-UX spec, item 3).
//
// A cybo always runs on the cybo runtime with a model ref "backend/model"
// (internal docs Option A; see resolvePiModelRef in cybo-manager.ts — mirrored
// in cyboBackendOf below). Whether a daemon can run it TODAY is therefore a
// fact about that daemon's runtime profile (daemon.meta.cyboRuntime: the
// configured backends + model counts each daemon publishes), not about the
// wizard's "provider available" flag, which only describes one daemon's
// native CLIs.
//
// BRANDING (internal docs, non-negotiable): user-facing copy says "Cybo" /
// "Cybo runtime" — the runtime's internal name never appears in the UI.

import type { Daemon } from "$lib/plugins/agents/types.js";

export interface CyboCapability {
  // Online daemons whose runtime lists ≥1 model for the backend — credentials
  // PRESENT ("configured"), deliberately NOT "ready": the runtime does not
  // validate keys when listing models (an invalid key still lists and only
  // fails at session time), and no cheap real-validation signal exists.
  configured: Daemon[];
  // Online daemons with the runtime installed but the backend unconfigured
  // (or the whole runtime unconfigured) — the "Set up Cybo" CTA targets.
  needsSetup: Daemon[];
  // Online daemons that publish no runtime profile (older builds): capability
  // unknown — consumers should fall back to today's behavior, not warn.
  unknown: Daemon[];
}

// The backend a cybo's (provider, model) pair resolves to — mirrors the server's
// resolvePiModelRef: a model carrying "backend/model" names the backend (after
// stripping a stray leading "pi/"); otherwise the provider IS the backend
// (standalone shape, e.g. provider="opencode-go" + model="glm-5.1"). Returns
// null when no backend is derivable (no model and provider is the runtime
// itself) — capability is then the runtime's binary `authenticated` signal.
export function cyboBackendOf(provider: string, model: string | null): string | null {
  const ref = model?.replace(/^pi\//, "") ?? null;
  if (ref && ref.includes("/")) {
    const backend = ref.slice(0, ref.indexOf("/"));
    return backend.length > 0 ? backend : null;
  }
  return provider === "pi" ? null : provider || null;
}

// The backend(s) a wizard provider ROW stands for (no model picked yet): model
// ids carrying "backend/model" name backends (the runtime row lists those);
// otherwise the row's provider id is the backend the saved cybo would resolve
// to (the join path in resolvePiModelRef).
// Provider IS the harness (internal docs): claude/codex cybos run NATIVELY on
// the daemon's own provider (its host login), NOT through the Cybo runtime —
// so the runtime-credentials capability axis below does not apply to them.
// Their availability is the provider catalog's own `available` flag.
export const NATIVE_HARNESS_IDS = new Set(["claude", "codex"]);

export function isNativeHarnessRow(id: string): boolean {
  return NATIVE_HARNESS_IDS.has(id);
}

// A cybo runs on a NATIVE harness when its provider IS claude/codex (internal docs)
// — `cybo.provider` is the row/provider id, so the cybo check is the row check.
// Native-harness cybos do NOT route through the Cybo runtime, so the runtime
// credentials axis (cyboCapabilityFor / daemon.meta.cyboRuntime) does not apply
// to them: their availability is the daemon's own provider catalog `available`
// flag, mirroring the server gate (spawnHarnessGateBlocked → listProviders →
// status !== "unavailable" for the native provider).
export function isNativeHarnessCybo(provider: string): boolean {
  return NATIVE_HARNESS_IDS.has(provider);
}

// Mirror of the daemon's native-harness gate (spawnHarnessGateBlocked,
// dispatcher.ts): a native-harness cybo is "configured + runnable" on the
// shown/home daemon exactly when that daemon's own provider catalog lists the
// native provider as `available`. `providers` is the shown daemon's snapshot
// (providerState.list). An empty/absent row is treated as not-yet-available
// (the snapshot can lag a fresh login — the auto-heal re-probe covers that).
export function nativeHarnessAvailable(
  provider: string,
  providers: readonly { id: string; available: boolean }[] | null | undefined,
): boolean {
  if (!isNativeHarnessCybo(provider) || !providers) return false;
  const row = providers.find((p) => p.id === provider);
  return row?.available === true;
}

export function rowBackends(row: { id: string; models?: { id: string }[] | null }): string[] {
  const fromModels = new Set<string>();
  for (const m of row.models ?? []) {
    const slash = m.id.indexOf("/");
    if (slash > 0) fromModels.add(m.id.slice(0, slash));
  }
  if (fromModels.size > 0) return [...fromModels].sort();
  return row.id === "pi" ? [] : [row.id];
}

function backendConfigured(
  profile: NonNullable<NonNullable<Daemon["meta"]>["cyboRuntime"]>,
  backends: string[],
): boolean {
  // No derivable backend → the binary signal is the whole truth.
  if (backends.length === 0) return profile.configured;
  // No breakdown published → degrade to the binary signal too.
  if (profile.backends.length === 0) return profile.configured;
  return profile.backends.some((b) => backends.includes(b.backend) && b.modelCount > 0);
}

// Partition the ONLINE daemons by whether they can run the given backend(s)
// today. Offline daemons are excluded — they can't run anything right now.
export function cyboCapabilityFor(
  backends: string[],
  onlineDaemons: readonly Daemon[],
): CyboCapability {
  const result: CyboCapability = { configured: [], needsSetup: [], unknown: [] };
  for (const daemon of onlineDaemons) {
    const profile = daemon.meta?.cyboRuntime;
    if (!profile) {
      // Older daemon (no profile) — only "unknown" if the runtime might exist;
      // a daemon that affirmatively reports no runtime can't run cybos at all.
      if (daemon.meta?.cyboInstalled !== false) result.unknown.push(daemon);
      continue;
    }
    if (backendConfigured(profile, backends)) result.configured.push(daemon);
    else result.needsSetup.push(daemon);
  }
  return result;
}

export function daemonDisplayName(daemon: Daemon): string {
  // PG label first (#441): it's sticky and user-renamable, while meta.host is
  // the raw reported hostname (an IP on networks without reverse-DNS). Strip
  // the mDNS suffix so "Sebs-MacBook.local" reads as "Sebs-MacBook".
  const name = daemon.label || daemon.meta?.host || daemon.id.slice(0, 8);
  return name.replace(/\.local$/i, "");
}

// ─── "Set up Cybo" CTA (coordination shim) ───────────────────────────
//
// CONTRACT with the auth-UX work (internal docs): the CTA is labelled
// "Set up Cybo on this daemon" and will open an embedded terminal running
// `cybo login` attached to THAT daemon. Until that lands, the agreed
// entry point is the daemon's detail page (its "Cybo runtime" section shows
// the exact command to run) — same destination the embedded terminal will
// later attach to. Capability surfaces must route through THIS helper so the
// terminal swap is a one-place change.
export const CYBO_SETUP_CTA_LABEL = "Set up Cybo on this daemon";

export function cyboSetupHref(workspaceId: string, daemonId: string): string {
  return `/workspace/${workspaceId}/daemons/${daemonId}`;
}

// Honest tooltip for the "configured" state — shared by wizard rows and cards.
// Configured ≠ verified: the runtime lists models without validating keys.
export const CYBO_CONFIGURED_TIP =
  "credentials present — not yet verified; a failed session will surface here";
