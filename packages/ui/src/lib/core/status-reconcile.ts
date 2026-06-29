// #671 status reconciliation — the pure half.
//
// WorkspaceUserStatusesState (state.svelte.ts) holds the user→status map in a
// Svelte `$state` rune, so it can't be runtime-imported under this package's
// plain-node vitest. But the DECISION it makes on each update — which entries
// survive a snapshot reseed, and whether a live change stores or drops an entry
// — is pure map math with no rune dependency, so it lives here and is unit
// tested directly (status-reconcile.test.ts). The rune class just assigns the
// map these functions return.
//
// The invariant both encode: a status with neither emoji nor text is "cleared"
// and must be ABSENT from the map (not stored as an empty row). The server #671
// sweep broadcasts exactly that empty shape (emoji:null,text:null) when a status
// expires, and fetch_user_statuses omits cleared users — so dropping empties is
// what makes an expired status actually disappear.

export interface MemberStatus {
  emoji: string | null;
  text: string | null;
  expiresAt: number | null;
}

// A non-empty status is one the user actually set (has an emoji and/or text).
// An all-null/empty status means "no status" and must not occupy the map.
export function isActiveStatus(status: MemberStatus): boolean {
  return Boolean(status.emoji || status.text);
}

// Snapshot reseed (fetch_user_statuses): build a FRESH map from the response so
// a user absent from the snapshot is dropped (a merge would strand expired
// statuses forever). Only active statuses are kept.
export function reconcileStatusSnapshot(
  statuses: ReadonlyArray<{ userId: string } & MemberStatus>,
): Record<string, MemberStatus> {
  const next: Record<string, MemberStatus> = {};
  for (const s of statuses) {
    if (isActiveStatus(s)) {
      next[s.userId] = { emoji: s.emoji, text: s.text, expiresAt: s.expiresAt };
    }
  }
  return next;
}

// One live change (user_status_changed). Returns the next map: an active status
// is stored; a cleared status DROPS the entry. Does not mutate the input.
export function applyStatusChange(
  current: Readonly<Record<string, MemberStatus>>,
  userId: string,
  status: MemberStatus,
): Record<string, MemberStatus> {
  const next = { ...current };
  if (isActiveStatus(status)) {
    next[userId] = status;
  } else {
    delete next[userId];
  }
  return next;
}
