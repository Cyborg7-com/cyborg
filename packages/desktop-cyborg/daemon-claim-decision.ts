// Pure decision for desktop daemon claiming — no fs / electron imports, so it is
// trivially unit-testable in isolation (daemon-manager.ts pulls in `electron`).

export type DaemonClaimDecision =
  | { action: "noop" }
  | { action: "defer"; reason: string }
  | { action: "reclaim"; healed: boolean };

// Decide what to do with a desktop daemon-claim request given the device's
// currently-persisted owner + relay, and the logged-in user + the relay the app
// just connected to.
//
// The ONLY case we refuse ("defer") is a device that is ALREADY actively bound to
// a DIFFERENT user on the SAME Cyborg relay — a legitimate shared-machine claim
// the relay itself protects (upsertDaemon only transfers ownership from
// 'unclaimed'/'system'), so stealing it locally would just churn restarts.
//
// Everything else self-heals. A stale/foreign claim — a leftover owner with NO
// relay url, or one pointing at a DIFFERENT relay (e.g. an old Paseo or
// pre-migration claim that never connected to this Cyborg relay) — used to make
// claimDesktopDaemon bail silently, leaving the user with a daemon that never
// registers and no in-app way to recover. We now rebind it to the logged-in user
// + this relay so the daemon connects and registers on the next start.
export function decideDaemonClaim(
  currentOwner: string,
  currentRelay: string,
  ownerId: string,
  relayUrl: string,
): DaemonClaimDecision {
  const ownerMismatch = Boolean(currentOwner) && currentOwner !== ownerId;
  const boundToSameRelay = Boolean(currentRelay) && currentRelay === relayUrl;
  if (ownerMismatch && boundToSameRelay) {
    return {
      action: "defer",
      reason: "device actively claimed by another user on this relay",
    };
  }
  if (currentOwner === ownerId && currentRelay === relayUrl) {
    return { action: "noop" };
  }
  return { action: "reclaim", healed: ownerMismatch };
}
