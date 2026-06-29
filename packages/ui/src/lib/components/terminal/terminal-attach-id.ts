// Stable per-(terminal, app-realm) subscriber id (internal docs GAP-1, #778/#779
// regression fix).
//
// THE BUG. Each TerminalView mount used to mint a FRESH attachId per mount. On
// the cloud/relay path a remount (the Liquid Glass nav, #761, remounts the view
// on every tab switch) sends attach(terminalId, newAttachId) while teardown's
// detach(oldAttachId) is still in flight over the relay — a network round-trip,
// so it can land AFTER the new attach or be dropped on a socket blip. The daemon
// dedups attachers by EXACT attachId, so a fresh id never matches the stale one:
// the stale attacher (its own live relay-forward emit) lingers, and the daemon
// fans pty output out to it too. Every stale attacher = one extra copy of every
// output frame AND every keystroke echo → `ls` renders as `llss`, output 2-4×.
//
// THE FIX. For a KNOWN terminalId, reuse the SAME attachId across every remount
// in this app realm. A remount then re-presents the same id, so the daemon's
// existing replace-in-place dedup collapses it to a single attacher instead of
// stacking — independent of whether the prior detach won the race.
//
// MULTI-TAB IS PRESERVED. Two real browser tabs are two separate JS realms with
// two separate module instances of this map, so they compute DIFFERENT ids for
// the same terminal and the daemon keeps both attachers (legit fan-out). Only a
// remount WITHIN one realm/connection collapses — exactly the abandoned-view
// case the regression came from.
//
// A fresh start (no terminalId yet) gets a unique per-call id: there is exactly
// one start per logical open, so it can never double-register, and the id is
// then pinned to the resolved terminalId by rememberAttachId() so a later
// remount-as-attach reuses it.

const byTerminalId = new Map<string, string>();

function mintId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `att_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

// The attachId to use for this mount. With a known terminalId (the attach /
// remount path) it is stable across remounts in this realm; without one (a fresh
// start) it is a unique id, pinned to the real terminalId once start resolves.
export function stableAttachId(terminalId: string | undefined): string {
  if (terminalId) {
    let id = byTerminalId.get(terminalId);
    if (!id) {
      id = mintId();
      byTerminalId.set(terminalId, id);
    }
    return id;
  }
  return mintId();
}

// Pin the attachId a fresh start used to the terminalId the daemon assigned, so a
// subsequent remount (which now knows terminalId) reuses the SAME id and the
// daemon replaces in place rather than stacking a second attacher.
export function rememberAttachId(terminalId: string, attachId: string): void {
  byTerminalId.set(terminalId, attachId);
}

// Drop the mapping for a terminal that is gone for good (shell exit / explicit
// close) so the map can't grow without bound across a long-lived session. A plain
// detach (tab switch) must NOT forget it — the whole point is that the next
// remount reuses the same id.
export function forgetAttachId(terminalId: string): void {
  byTerminalId.delete(terminalId);
}
