// Pure default-daemon selection — extracted from DaemonState.loadedId so the
// ownership/access priority is unit-testable without the runes ($state) class.
//
// NEVER fall back to a daemon the user doesn't own / can't access: silently
// landing on someone else's daemon is how cybos got created on a stranger's
// machine. Priority:
//   1. own + online        (yours and reachable — the happy path)
//   2. accessible + online  (reachable, you hold a grant)
//   3. own (even offline)   (still YOURS — surface it so the user brings it
//                            online, instead of silently using another's)
//   4. accessible (offline) (a daemon you genuinely have access to)
//   5. null                 (nothing usable — better than a foreign daemon)
// Online daemons the user may run code on (owner OR daemon_access grant).
// Capability/provider surfaces must use THIS, not the raw online list:
// offering "Set up →" on a foreign daemon advertises other members' machines
// as setup targets the user can't actually use. The same access matrix that
// gates spawns and slash-daemon designation (slash-daemon-access.ts server
// side) applies to the OFFER, not just the execution.
export function accessibleOnlineDaemons<D extends { id: string; ownerId: string }>(
  daemons: readonly D[],
  isOnline: (daemon: D) => boolean,
  hasAccess: (daemon: D) => boolean,
): D[] {
  return daemons.filter((d) => isOnline(d) && hasAccess(d));
}

export function pickDefaultDaemon<D extends { id: string; ownerId: string }>(
  daemons: readonly D[],
  currentUserId: string | undefined,
  isOnline: (daemon: D) => boolean,
  hasAccess: (daemon: D) => boolean,
): string | null {
  if (daemons.length === 0) return null;
  const ownedOnline = daemons.find((d) => d.ownerId === currentUserId && isOnline(d));
  if (ownedOnline) return ownedOnline.id;
  const accessibleOnline = daemons.find((d) => isOnline(d) && hasAccess(d));
  if (accessibleOnline) return accessibleOnline.id;
  const owned = daemons.find((d) => d.ownerId === currentUserId);
  if (owned) return owned.id;
  const accessible = daemons.find((d) => hasAccess(d));
  if (accessible) return accessible.id;
  return null;
}
