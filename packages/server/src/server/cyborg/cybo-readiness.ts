// Cybo provider-readiness (#636) — the server-side answer to "created but
// unspawnable".
//
// create_cybo commits a `provider` to PG without anyone checking that a
// REACHABLE daemon can actually run it; the mismatch only surfaces at spawn/turn
// time (the "Apex saga" class). The agreed fix (issue #636, recommended option)
// is NOT to reject the creation — provider/auth state is dynamic and a daemon
// can come online a second later — but to ATTACH a readiness status the UI can
// surface honestly. This module is the pure computation behind that status.
//
// It deliberately MIRRORS the UI's cyboCapabilityFor / cyboBackendOf
// (packages/ui/src/lib/cybo-capability.ts) so client and server agree on what
// "runnable" means; the server just collapses the capability partition into one
// of three states the create/update/list paths can return.

import { resolveCyboHarness } from "./cybo-manager.js";

// The progression a cybo moves through as daemons appear and get configured:
//   ready        — a reachable daemon can run this cybo's harness right now.
//   needs-daemon — a daemon is needed (none online, or the online ones can't
//                  run this provider) — the actionable "do something" state.
//   created      — exists, but readiness is INDETERMINATE (only older daemons
//                  online that publish neither a runtime profile NOR an honest
//                  provider list). Neutral: surfaces NO alarm, mirroring the
//                  UI's "unknown → don't warn".
export type CyboReadiness = "ready" | "needs-daemon" | "created";

// A workspace daemon narrowed to what readiness needs. `online` is the LIVE
// liveness flag (relay.getConnectedDaemons() ∩ this workspace's daemons) — PG's
// `status` column alone lags a hard disconnect, so the caller intersects with
// the in-memory connection set. `cyboRuntime` is the runtime profile the daemon
// publishes each heartbeat (credentials present + per-backend model counts).
export interface ReadinessDaemon {
  online: boolean;
  cyboInstalled?: boolean;
  cyboRuntime?: {
    configured: boolean;
    backends: { backend: string; modelCount: number }[];
  };
  // The HONEST daemon_hello ready-provider list (#697/#795). A native harness id
  // (claude/codex) appears here ONLY when the daemon's host is actually logged in
  // — the daemon post-filters signed-out native ids before advertising
  // (hello-provider-list.ts). `undefined` means the daemon never reported a list
  // (older build): native readiness stays indeterminate rather than warning.
  providers?: string[];
}

// The backend a cybo's (provider, model) pair resolves to — mirrors the server's
// resolvePiModelRef (cybo-manager.ts) and the UI's cyboBackendOf: a model
// carrying "backend/model" names the backend (after stripping a stray leading
// "pi/"); otherwise the provider IS the backend (standalone shape, e.g.
// provider="opencode-go" + model="glm-5.1"). Returns null when no backend is
// derivable (no model and provider is the runtime itself) — capability is then
// the runtime's binary `configured` signal.
export function cyboBackendOf(provider: string, model: string | null): string | null {
  const ref = model?.replace(/^pi\//, "") ?? null;
  if (ref && ref.includes("/")) {
    const backend = ref.slice(0, ref.indexOf("/"));
    return backend.length > 0 ? backend : null;
  }
  return provider === "pi" ? null : provider || null;
}

// A real object literal, excluding null AND arrays (`typeof [] === "object"`),
// so a malformed heartbeat that sends an array where an object is expected is
// rejected rather than read field-by-field as `undefined`.
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// `profile` is the daemon's published cyboRuntime — zod-validated at ingestion,
// but it lands in loosely-typed PG JSONB that may hold legacy/partial/forged
// rows, so this treats it as fully UNTRUSTED (#720): a non-object profile, a
// non-array `backends`, or a malformed entry degrades to the binary `configured`
// signal (or "not configured"), and never throws.
function runtimeConfiguredFor(profile: unknown, backend: string | null): boolean {
  // A profile that isn't even a plain object can't be trusted as configured.
  if (!isPlainObject(profile)) return false;
  const configured = profile.configured === true;
  // No derivable backend → the binary signal is the whole truth.
  if (backend === null) return configured;
  const backends = Array.isArray(profile.backends) ? profile.backends : [];
  if (backends.length === 0) return configured;
  return backends.some((b) => {
    if (!isPlainObject(b)) return false;
    // Number.isFinite (not just `typeof === "number"`): a forged `Infinity`
    // would pass `> 0`, NaN is already excluded by it — guard both.
    return (
      b.backend === backend &&
      typeof b.modelCount === "number" &&
      Number.isFinite(b.modelCount) &&
      b.modelCount > 0
    );
  });
}

// Build ReadinessDaemon[] from the PG workspace-daemon rows + the set of
// currently-connected daemon ids. `meta` is JSONB whose static type omits
// cyboRuntime (see relay-protocol.ts DaemonMetaSchema — it's stored but not
// reflected in the column type), so we read it through a narrow cast.
// `providersForDaemon` reads the LIVE honest provider list the relay tracks per
// connection (WorkspaceRelay.getDaemonProviders) — it is NOT in PG meta because
// native login is host-state that changes at runtime; native readiness depends
// on it (logged-in native ids are present, logged-out ones are filtered out).
export function readinessDaemonsFrom(
  wsDaemons: readonly { id: string; meta: unknown }[],
  connectedIds: ReadonlySet<string>,
  providersForDaemon?: (daemonId: string) => string[] | undefined,
): ReadinessDaemon[] {
  return wsDaemons.map((d) => {
    const meta = (d.meta ?? {}) as {
      cyboInstalled?: boolean;
      cyboRuntime?: ReadinessDaemon["cyboRuntime"];
    };
    return {
      online: connectedIds.has(d.id),
      cyboInstalled: meta.cyboInstalled,
      cyboRuntime: meta.cyboRuntime,
      providers: providersForDaemon?.(d.id),
    };
  });
}

// Collapse the workspace's daemons into a single readiness state for one cybo.
export function computeCyboReadiness(
  provider: string,
  model: string | null,
  daemons: readonly ReadinessDaemon[],
): CyboReadiness {
  const online = daemons.filter((d) => d.online);
  // Nothing reachable can run anything — the literal "needs a daemon" case, and
  // the heart of the #636 failure (a cybo created against an empty roster).
  if (online.length === 0) return "needs-daemon";

  const harness = resolveCyboHarness(provider, model);
  if (harness.provider !== "pi") {
    // Native harness (claude/codex): runs on the daemon's OWN host login. The
    // relay can't watch the login directly, but each daemon now advertises an
    // HONEST provider list in daemon_hello (#697/#795): the native id is present
    // ONLY when the host is actually logged in (signed-out native ids are
    // post-filtered before advertising). So readiness reflects reality:
    //   ready        — ≥1 online daemon advertises this native harness logged in.
    //   needs-daemon — online daemons reported lists, but NONE include it (every
    //                  capable host is signed out) → the actionable "Set up" path.
    //   created      — only daemons that report no list at all (older builds) →
    //                  indeterminate, don't alarm.
    let loggedIn = 0;
    let reportedWithout = 0;
    for (const d of online) {
      if (d.providers === undefined) continue; // older daemon — no honest list
      if (d.providers.includes(harness.provider)) loggedIn++;
      else reportedWithout++;
    }
    if (loggedIn > 0) return "ready";
    if (reportedWithout > 0) return "needs-daemon";
    return "created";
  }

  const backend = cyboBackendOf(provider, model);
  let configured = 0;
  let incapable = 0; // online but the runtime can't run this backend / is absent
  let unknown = 0; // older daemon, no runtime profile — capability indeterminate
  for (const d of online) {
    const profile = d.cyboRuntime;
    if (profile) {
      if (runtimeConfiguredFor(profile, backend)) configured++;
      else incapable++;
    } else if (d.cyboInstalled === false) {
      incapable++;
    } else {
      unknown++;
    }
  }
  if (configured > 0) return "ready";
  // A daemon is online but affirmatively can't run this provider → a (capable)
  // daemon is still needed: the "Set up Cybo" path the UI already owns.
  if (incapable > 0) return "needs-daemon";
  // Only profile-less daemons online (older builds): indeterminate, don't alarm.
  void unknown;
  return "created";
}
