// #671 expired-status sweep — the pure half.
//
// The periodic sweep in relay-standalone.ts deletes expired user_statuses and
// must then broadcast a `user_status_changed` CLEAR per cleared row so live
// clients drop the chip instantly (otherwise it lingers until the next full
// resync). The DELETE+broadcast wiring is a closure inside main() (it closes
// over `pg` and `broadcastUserStatusChanged`/`guestSubs`), but the part that
// matters for correctness — turning the cleared (workspace,user) rows into the
// exact clear payloads to broadcast — is pure and lives here so it is unit
// tested directly (see status-sweep.test.ts) instead of asserted via a source
// scan.
//
// Kept as a small pure function (no `pg`, no relay closures) so it is trivially
// testable and the "this is just a mapping" guarantee is enforced by its
// signature.

export interface ExpiredStatusClear {
  workspaceId: string;
  userId: string;
  // The empty-status shape — every field that signals "no status". This is the
  // SAME payload `cyborg:set_user_status` emits when a user clears their own
  // status, so the live client handler drops on it identically.
  emoji: null;
  text: null;
  expiresAt: null;
}

// Map the rows clearExpiredStatuses() returned into the clear broadcasts the
// sweep must fan out — one per (workspaceId, userId).
export function buildExpiredStatusClears(
  clearedRows: ReadonlyArray<{ workspaceId: string; userId: string }>,
): ExpiredStatusClear[] {
  return clearedRows.map(({ workspaceId, userId }) => ({
    workspaceId,
    userId,
    emoji: null,
    text: null,
    expiresAt: null,
  }));
}
