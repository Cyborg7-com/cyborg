// Pure decision for dispatchPush's desktop-active push suppression — extracted so
// it can be unit-tested without standing up the relay (relay-standalone.ts runs
// main() on import). A desktop/web client silences the user's phone (FCM) push
// ONLY while it is foregrounded AND has had user activity within idleMs. A
// foregrounded-but-idle desktop (the user walked away from an open laptop)
// returns false, so the phone rings again. This is push-suppression ONLY — it is
// deliberately independent of presence/away status.

export interface PushActiveInput {
  // Connection surface; undefined on older clients → treated as not-a-desktop.
  clientType?: "desktop" | "web" | "mobile";
  // True while the client app is backgrounded (cyborg:app_state).
  backgrounded?: boolean;
  // Whether the underlying socket is OPEN.
  wsOpen: boolean;
  // Epoch ms of the last user-driven app message (NOT keepalive/ping).
  lastActivityAt?: number;
}

/**
 * Does this connection count as an "active desktop" that should silence the
 * user's phone push? Only a foregrounded desktop/web socket with user activity
 * within `idleMs` qualifies. Mobile, backgrounded, closed, never-active, or
 * idle-past-`idleMs` connections all return false (→ the phone is allowed to ring).
 */
export function isDesktopActiveForPush(c: PushActiveInput, now: number, idleMs: number): boolean {
  if (c.clientType !== "desktop" && c.clientType !== "web") return false;
  if (c.backgrounded) return false;
  if (!c.wsOpen) return false;
  if (c.lastActivityAt === undefined) return false;
  return now - c.lastActivityAt < idleMs;
}
