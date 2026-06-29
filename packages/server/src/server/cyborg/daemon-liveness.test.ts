import { describe, it, expect } from "vitest";
import { isDaemonOnline, DAEMON_ONLINE_WINDOW_MS } from "./daemon-liveness.js";

// #555: list_daemons marked a daemon online ONLY if its socket was in this relay
// instance's connected-set. That set is non-durable + per-instance, so after a
// relay restart (or in multi-instance) an owned, subscribed, heartbeating daemon
// showed offline and got filtered out of the provider rows. Reconcile the status
// against the persisted heartbeat (lastSeenAt) so a fresh heartbeat = online.

const NOW = 1_700_000_000_000;

describe("isDaemonOnline", () => {
  it("online when the socket is on this instance, regardless of heartbeat", () => {
    expect(isDaemonOnline({ connected: true, lastSeenAt: null, now: NOW })).toBe(true);
    // Stale heartbeat but connected here → still online.
    expect(isDaemonOnline({ connected: true, lastSeenAt: NOW - 10 * 60_000, now: NOW })).toBe(true);
  });

  it("online when NOT in the connected-set but heartbeat is recent (the #555 fix)", () => {
    expect(isDaemonOnline({ connected: false, lastSeenAt: NOW - 8_000, now: NOW })).toBe(true);
    expect(isDaemonOnline({ connected: false, lastSeenAt: NOW - 59_000, now: NOW })).toBe(true);
  });

  it("offline when not connected and the heartbeat is stale", () => {
    expect(isDaemonOnline({ connected: false, lastSeenAt: NOW - 61_000, now: NOW })).toBe(false);
    expect(isDaemonOnline({ connected: false, lastSeenAt: NOW - 10 * 60_000, now: NOW })).toBe(
      false,
    );
  });

  it("offline when not connected and never seen (lastSeenAt null)", () => {
    expect(isDaemonOnline({ connected: false, lastSeenAt: null, now: NOW })).toBe(false);
  });

  it("treats the window boundary as exclusive (< window, not <=)", () => {
    // Exactly at the window edge is NOT fresh; one ms inside is.
    expect(
      isDaemonOnline({ connected: false, lastSeenAt: NOW - DAEMON_ONLINE_WINDOW_MS, now: NOW }),
    ).toBe(false);
    expect(
      isDaemonOnline({ connected: false, lastSeenAt: NOW - DAEMON_ONLINE_WINDOW_MS + 1, now: NOW }),
    ).toBe(true);
  });

  it("honors a custom window", () => {
    expect(
      isDaemonOnline({ connected: false, lastSeenAt: NOW - 5_000, now: NOW, windowMs: 3_000 }),
    ).toBe(false);
    expect(
      isDaemonOnline({ connected: false, lastSeenAt: NOW - 2_000, now: NOW, windowMs: 3_000 }),
    ).toBe(true);
  });
});
