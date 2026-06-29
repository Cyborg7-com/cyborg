/**
 * Daemon online/offline reconciliation for the daemon LIST (display) path.
 *
 * `list_daemons` used to set each daemon's status purely from
 * `relay.getConnectedDaemons()` — the in-memory set of sockets held by THIS
 * relay instance. That set is neither durable nor shared across instances, so a
 * daemon with a fresh heartbeat shows as "offline" right after a relay restart
 * or whenever the client hits a different instance than the daemon's socket
 * landed on (#555). The client then filters it out of the provider rows /
 * sidebar even though it is genuinely online and owned.
 *
 * Reconcile both signals: a daemon is online if its socket is on this instance
 * (`connected`) OR its persisted `lastSeenAt` heartbeat is recent. Heartbeats
 * are written to PG on a short interval, so a recent `lastSeenAt` is a durable,
 * multi-instance-safe liveness signal for DISPLAY.
 *
 * NOTE: this is for the LIST/display only. Command/spawn FORWARDING must still
 * use the raw connected-set — you can only forward to a socket this instance
 * actually holds, regardless of heartbeat freshness.
 */

// A heartbeat newer than this is considered "online" for display. The daemon
// heartbeat interval is well under a minute, so 60s tolerates a missed beat or
// two (and a relay restart) without flapping a live daemon to offline.
export const DAEMON_ONLINE_WINDOW_MS = 60_000;

export function isDaemonOnline(opts: {
  /** Daemon's socket is held by THIS relay instance. */
  connected: boolean;
  /** Persisted heartbeat time (epoch ms), or null if never seen. */
  lastSeenAt: number | null;
  /** Current time (epoch ms) — injected for testability. */
  now: number;
  /** Freshness window; defaults to DAEMON_ONLINE_WINDOW_MS. */
  windowMs?: number;
}): boolean {
  if (opts.connected) return true;
  if (opts.lastSeenAt == null) return false;
  return opts.now - opts.lastSeenAt < (opts.windowMs ?? DAEMON_ONLINE_WINDOW_MS);
}
