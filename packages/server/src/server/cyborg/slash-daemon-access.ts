// Daemon-access gate for the workspace slash config (Settings → AI).
//
// Slash commands EXECUTE on the designated daemon, so designating one is
// RCE-equivalent: the same access matrix that gates cybo spawns (own the
// daemon OR hold a daemon_access grant — see handleSpawnCybo / #296) must
// gate this selection. Workspace membership of the daemon alone is NOT
// enough — another member's daemon in the same workspace is still foreign.
//
// The check applies only to daemons the request INTRODUCES: ids already in
// the saved config stay valid, so an admin without access to a daemon a
// previous admin designated can still edit the other fields (model, on/off)
// without being locked out — keeping an existing value grants nothing new.

export interface DaemonAccessChecker {
  canUserAccessDaemon(workspaceId: string, daemonId: string, userId: string): Promise<boolean>;
}

export interface SlashDaemonRefs {
  // undefined = field not present in the request (unchanged).
  defaultSlashDaemonId?: string | null;
  fallbackDaemons?: string[];
}

export interface SavedSlashDaemonRefs {
  defaultSlashDaemonId: string | null;
  fallbackDaemons: string[];
}

// The first newly-introduced daemon id the user can NOT access, or null when
// every introduced daemon passes the access matrix.
export async function findInaccessibleSlashDaemon(opts: {
  pg: DaemonAccessChecker;
  workspaceId: string;
  userId: string;
  requested: SlashDaemonRefs;
  current: SavedSlashDaemonRefs;
}): Promise<string | null> {
  const { pg, workspaceId, userId, requested, current } = opts;
  const alreadyConfigured = new Set<string>(current.fallbackDaemons);
  if (current.defaultSlashDaemonId) alreadyConfigured.add(current.defaultSlashDaemonId);

  const introduced: string[] = [];
  if (requested.defaultSlashDaemonId) introduced.push(requested.defaultSlashDaemonId);
  if (requested.fallbackDaemons) introduced.push(...requested.fallbackDaemons);

  for (const daemonId of introduced) {
    if (alreadyConfigured.has(daemonId)) continue;
    if (!(await pg.canUserAccessDaemon(workspaceId, daemonId, userId))) return daemonId;
  }
  return null;
}

export function slashDaemonAccessError(daemonId: string): string {
  return `No access to daemon ${daemonId} — you can only designate daemons you own or were granted access to.`;
}
