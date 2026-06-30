// Problem (4) — make a cybo's "home" daemon AUTHORITATIVE for spawn routing.
//
// `cybo.home_daemon_id` is the machine the cybo lives on (chosen at creation,
// editable later). It was persisted end-to-end but INERT: the spawn always
// landed on the sponsor/selected daemon. This module is the ONE pure decision
// function both spawn paths (the relay's direct `spawn_cybo` and the @-mention /
// channel-watch orchestrator) consult to honor the home daemon when it can run
// the spawn, and to fall back GRACEFULLY (with a surfaced reason) when it can't.
//
// Pure + dependency-free so it's trivially unit-testable: the caller passes the
// home id, the set of online+workspace daemon ids, and an accessibility probe.

export type HomeDaemonRouteReason =
  | "unset" // no home_daemon_id — keep the caller's existing pick (null result).
  | "home" // home is online + accessible — pin it.
  | "offline" // home is set but not online (or not a workspace daemon) — fall back.
  | "inaccessible"; // home is online but the caller lacks the required scope — fall back.

export interface HomeDaemonRouteDecision {
  // The daemon to pin the spawn to, or null to keep the caller's existing
  // (sponsor/effective) resolution. `reason` explains the choice for logging
  // and author-facing notices.
  daemonId: string | null;
  reason: HomeDaemonRouteReason;
}

export interface HomeDaemonRouteInputs {
  // The cybo's configured home daemon (null/undefined ⇒ "Auto / sponsor").
  homeDaemonId: string | null | undefined;
  // Ids of daemons that are BOTH members of the target workspace AND online
  // right now. The home daemon must be in this set to be eligible.
  onlineWorkspaceDaemonIds: ReadonlySet<string>;
  // Whether the caller is allowed to run on a given daemon (the same per-daemon
  // scope gate the no-target spawn enforces). Defaults to "allowed" for callers
  // that don't model per-daemon access (e.g. the @-mention path, which routes by
  // the cybo identity, not a human's daemon scopes).
  isAccessible?: (daemonId: string) => boolean;
}

// Decide where a cybo's session should spawn, honoring its home daemon.
//
//   - home unset  → { daemonId: null, reason: "unset" }  (keep current behavior)
//   - home online + accessible → { daemonId: home, reason: "home" }  (pin it)
//   - home offline / not a workspace daemon → { null, "offline" }    (fall back)
//   - home online but inaccessible to caller → { null, "inaccessible" } (fall back)
//
// A null `daemonId` ALWAYS means "leave the caller's existing resolution alone"
// — this function never invents a different daemon; it only pins the home daemon
// when that's a safe, runnable choice.
export function resolveSpawnDaemon(inputs: HomeDaemonRouteInputs): HomeDaemonRouteDecision {
  const home = inputs.homeDaemonId?.trim();
  if (!home) return { daemonId: null, reason: "unset" };
  if (!inputs.onlineWorkspaceDaemonIds.has(home)) {
    return { daemonId: null, reason: "offline" };
  }
  const accessible = inputs.isAccessible ? inputs.isAccessible(home) : true;
  if (!accessible) return { daemonId: null, reason: "inaccessible" };
  return { daemonId: home, reason: "home" };
}

// Whether the relay should run home-daemon routing for a spawn AT ALL.
//
// #1035 only honored the home daemon when the caller pinned NO daemon
// (`!targetDaemonId`). But the interactive Agents/DM "Start chat" UI ALWAYS sends
// an INCIDENTAL daemonId — the currently-shown / effective daemon, not a
// deliberate per-spawn pick — so home routing was silently shadowed and a homed
// cybo's interactive session landed on the sponsor daemon instead of its home.
//
// A homed cybo must CONVERGE on its home, so routing now runs even when an
// incidental daemonId is present (it OVERRIDES it iff home is online +
// accessible — resolveSpawnDaemon still falls back gracefully otherwise). The
// ONLY way to opt out is an explicit `pinDaemon` flag from the caller — a
// deliberate "run on THIS daemon, do not re-home" choice. No client sends
// pinDaemon today, so the incidental shown-daemon path now re-homes (the fix);
// a future "run here" affordance can set pinDaemon to keep its target.
export function shouldApplyHomeRoutingForSpawn(inputs: { explicitDaemonPin: boolean }): boolean {
  return !inputs.explicitDaemonPin;
}

// Human-readable explanation for a fallback (logs + author notices). Returns
// null for the non-fallback reasons ("unset" / "home") since there's nothing to
// explain when behavior is normal.
export function describeHomeDaemonFallback(
  reason: HomeDaemonRouteReason,
  cyboSlug: string,
): string | null {
  switch (reason) {
    case "offline":
      return `@${cyboSlug}'s home daemon is offline — running on another online daemon instead.`;
    case "inaccessible":
      return `@${cyboSlug}'s home daemon isn't accessible to you — running on another online daemon instead.`;
    default:
      return null;
  }
}

// Async orchestrator the relay's spawn_cybo path calls. Resolves the cybo's home
// daemon against the live online/accessible state and returns the daemon to PIN
// the spawn to (or null to keep the caller's existing resolution). Side effects
// (structured log + author notice) run through the injected callbacks so the
// relay's inline call site stays a one-liner and all the routing logic + its
// fallback messaging are unit-testable here. `getOnlineWorkspaceDaemonIds` and
// `isAccessible` are the only env probes; everything else is pure.
export interface HomeDaemonRoutingDeps {
  homeDaemonId: string | null | undefined;
  cyboSlug: string | null | undefined;
  getOnlineWorkspaceDaemonIds: () => Promise<ReadonlySet<string>>;
  isAccessible: (daemonId: string) => Promise<boolean>;
  onPinned?: (daemonId: string) => void;
  onFallback?: (reason: HomeDaemonRouteReason, message: string | null) => void;
  // A transient probe failure (DB/online-lookup error) — routing falls back to
  // the caller's default (returns null) WITHOUT surfacing a misleading "home
  // daemon offline" notice to the author. Logged here instead.
  onError?: (err: unknown) => void;
}

// Returns the daemon id to pin, or null when the caller's existing resolution
// should stand (home unset, or home offline/inaccessible → graceful fallback).
export async function applyHomeDaemonRouting(deps: HomeDaemonRoutingDeps): Promise<string | null> {
  const home = deps.homeDaemonId?.trim();
  if (!home) return null;
  try {
    const onlineWorkspaceDaemonIds = await deps.getOnlineWorkspaceDaemonIds();
    // Probe the home daemon's accessibility once (the only id resolveSpawnDaemon
    // asks about) so the decision fn stays synchronous + pure.
    const homeAccessible = onlineWorkspaceDaemonIds.has(home)
      ? await deps.isAccessible(home)
      : false;
    const decision = resolveSpawnDaemon({
      homeDaemonId: home,
      onlineWorkspaceDaemonIds,
      isAccessible: (id) => id === home && homeAccessible,
    });
    if (decision.daemonId) {
      deps.onPinned?.(decision.daemonId);
      return decision.daemonId;
    }
    deps.onFallback?.(
      decision.reason,
      describeHomeDaemonFallback(decision.reason, deps.cyboSlug ?? "cybo"),
    );
    return null;
  } catch (err) {
    // A transient probe failure (e.g. a DB lookup error in
    // getOnlineWorkspaceDaemonIds / isAccessible) must NOT hard-fail the spawn:
    // fall back to the caller's default resolution (return null) and log via
    // onError — never surface a misleading "home daemon offline" notice.
    deps.onError?.(err);
    return null;
  }
}
