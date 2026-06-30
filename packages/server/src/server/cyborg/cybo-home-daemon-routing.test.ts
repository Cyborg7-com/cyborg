import { describe, expect, it, vi } from "vitest";
import {
  applyHomeDaemonRouting,
  describeHomeDaemonFallback,
  resolveSpawnDaemon,
  shouldApplyHomeRoutingForSpawn,
} from "./cybo-home-daemon-routing.js";

// Problem (4) — the cybo's HOME daemon must be AUTHORITATIVE for where its
// session spawns. These tests pin the pure decision (resolveSpawnDaemon) and the
// async orchestrator (applyHomeDaemonRouting) across the three cases the relay
// needs: home set + online + accessible → home; home offline → fallback; home
// inaccessible → fallback; home unset → keep the caller's resolution.
describe("resolveSpawnDaemon (problem 4)", () => {
  const online = (...ids: string[]) => new Set(ids);

  it("pins the home daemon when it is online and accessible", () => {
    const d = resolveSpawnDaemon({
      homeDaemonId: "daemon_home",
      onlineWorkspaceDaemonIds: online("daemon_home", "daemon_other"),
      isAccessible: () => true,
    });
    expect(d).toEqual({ daemonId: "daemon_home", reason: "home" });
  });

  it("falls back (offline) when the home daemon is not an online workspace daemon", () => {
    const d = resolveSpawnDaemon({
      homeDaemonId: "daemon_home",
      onlineWorkspaceDaemonIds: online("daemon_other"),
      isAccessible: () => true,
    });
    expect(d).toEqual({ daemonId: null, reason: "offline" });
  });

  it("falls back (inaccessible) when the home daemon is online but caller lacks access", () => {
    const d = resolveSpawnDaemon({
      homeDaemonId: "daemon_home",
      onlineWorkspaceDaemonIds: online("daemon_home"),
      isAccessible: () => false,
    });
    expect(d).toEqual({ daemonId: null, reason: "inaccessible" });
  });

  it("keeps the caller's resolution (unset) when no home daemon is configured", () => {
    expect(resolveSpawnDaemon({ homeDaemonId: null, onlineWorkspaceDaemonIds: online() })).toEqual({
      daemonId: null,
      reason: "unset",
    });
    expect(
      resolveSpawnDaemon({ homeDaemonId: "   ", onlineWorkspaceDaemonIds: online("x") }),
    ).toEqual({ daemonId: null, reason: "unset" });
  });

  it("treats a missing isAccessible probe as allowed (mention path default)", () => {
    const d = resolveSpawnDaemon({
      homeDaemonId: "daemon_home",
      onlineWorkspaceDaemonIds: online("daemon_home"),
    });
    expect(d).toEqual({ daemonId: "daemon_home", reason: "home" });
  });
});

describe("describeHomeDaemonFallback (problem 4)", () => {
  it("explains offline + inaccessible, and stays silent for unset/home", () => {
    expect(describeHomeDaemonFallback("offline", "atlas")).toMatch(/@atlas.*offline/);
    expect(describeHomeDaemonFallback("inaccessible", "atlas")).toMatch(/@atlas.*accessible/);
    expect(describeHomeDaemonFallback("unset", "atlas")).toBeNull();
    expect(describeHomeDaemonFallback("home", "atlas")).toBeNull();
  });
});

describe("applyHomeDaemonRouting (problem 4 — relay orchestrator)", () => {
  it("pins the home daemon (online + accessible) and fires onPinned", async () => {
    const onPinned = vi.fn();
    const onFallback = vi.fn();
    const pinned = await applyHomeDaemonRouting({
      homeDaemonId: "daemon_home",
      cyboSlug: "atlas",
      getOnlineWorkspaceDaemonIds: async () => new Set(["daemon_home"]),
      isAccessible: async () => true,
      onPinned,
      onFallback,
    });
    expect(pinned).toBe("daemon_home");
    expect(onPinned).toHaveBeenCalledWith("daemon_home");
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("falls back with an offline reason + message when the home daemon is offline", async () => {
    const onFallback = vi.fn();
    const pinned = await applyHomeDaemonRouting({
      homeDaemonId: "daemon_home",
      cyboSlug: "atlas",
      getOnlineWorkspaceDaemonIds: async () => new Set(["daemon_other"]),
      isAccessible: async () => true,
      onFallback,
    });
    expect(pinned).toBeNull();
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback.mock.calls[0][0]).toBe("offline");
    expect(onFallback.mock.calls[0][1]).toMatch(/offline/);
  });

  it("falls back (inaccessible) without probing access of any non-home daemon", async () => {
    const isAccessible = vi.fn(async () => false);
    const onFallback = vi.fn();
    const pinned = await applyHomeDaemonRouting({
      homeDaemonId: "daemon_home",
      cyboSlug: "atlas",
      getOnlineWorkspaceDaemonIds: async () => new Set(["daemon_home"]),
      isAccessible,
      onFallback,
    });
    expect(pinned).toBeNull();
    expect(isAccessible).toHaveBeenCalledTimes(1);
    expect(isAccessible).toHaveBeenCalledWith("daemon_home");
    expect(onFallback.mock.calls[0][0]).toBe("inaccessible");
  });

  it("falls back to null + onError (not onFallback) when a probe throws", async () => {
    const onError = vi.fn();
    const onFallback = vi.fn();
    const pinned = await applyHomeDaemonRouting({
      homeDaemonId: "daemon_home",
      cyboSlug: "atlas",
      getOnlineWorkspaceDaemonIds: async () => {
        throw new Error("db down");
      },
      isAccessible: async () => true,
      onFallback,
      onError,
    });
    expect(pinned).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("returns null (no probes, no callbacks) when the home daemon is unset", async () => {
    const getOnline = vi.fn(async () => new Set<string>());
    const onPinned = vi.fn();
    const onFallback = vi.fn();
    const pinned = await applyHomeDaemonRouting({
      homeDaemonId: null,
      cyboSlug: "atlas",
      getOnlineWorkspaceDaemonIds: getOnline,
      isAccessible: async () => true,
      onPinned,
      onFallback,
    });
    expect(pinned).toBeNull();
    expect(getOnline).not.toHaveBeenCalled();
    expect(onPinned).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });
});

// Interactive agent-session / "Start chat" gap (home-daemon routing for the
// INTERACTIVE path). The relay #1035 only honored a cybo's home daemon when the
// caller pinned NO daemon, but the Agents/DM "Start chat" UI ALWAYS sends an
// incidental daemonId (the shown/effective daemon). shouldApplyHomeRoutingForSpawn
// is the gate that lets home routing run anyway (and override that incidental
// daemon), opting out ONLY for an explicit pinDaemon pick.
describe("shouldApplyHomeRoutingForSpawn (interactive agent-session gap)", () => {
  it("runs home routing when the caller did NOT explicitly pin a daemon", () => {
    // The interactive "Start chat" case: an incidental shown daemonId is present
    // on the wire, but it is not a deliberate pick (pinDaemon is absent ⇒ false).
    expect(shouldApplyHomeRoutingForSpawn({ explicitDaemonPin: false })).toBe(true);
  });

  it("skips home routing only when the caller explicitly pins a daemon", () => {
    expect(shouldApplyHomeRoutingForSpawn({ explicitDaemonPin: true })).toBe(false);
  });
});

// End-to-end of the relay's spawn decision for the INTERACTIVE path: an incidental
// daemonId (the shown/effective daemon) is on the wire, yet a homed cybo whose home
// is online + accessible must still re-home there (the bug: it previously landed on
// the sponsor daemon). These compose the gate + the async orchestrator exactly as
// the relay handler does.
describe("interactive spawn re-homes a homed cybo despite an incidental daemonId", () => {
  // Mirror the relay: compute the gate, then (if it passes) run applyHomeDaemonRouting;
  // the returned id (or null = keep the caller's incidental daemon) is what the
  // forward is pinned to.
  async function decideForward(opts: {
    incidentalDaemonId: string; // the shown/effective daemon the UI sent
    explicitDaemonPin: boolean;
    homeDaemonId: string | null;
    online: ReadonlySet<string>;
    accessible: (id: string) => boolean;
  }): Promise<string> {
    let target = opts.incidentalDaemonId;
    if (shouldApplyHomeRoutingForSpawn({ explicitDaemonPin: opts.explicitDaemonPin })) {
      const pinned = await applyHomeDaemonRouting({
        homeDaemonId: opts.homeDaemonId,
        cyboSlug: "apex",
        getOnlineWorkspaceDaemonIds: async () => opts.online,
        isAccessible: async (id) => opts.accessible(id),
      });
      if (pinned) target = pinned;
    }
    return target;
  }

  it("forwards to the HOME daemon (not the incidental shown daemon) when home is online + accessible", async () => {
    const target = await decideForward({
      incidentalDaemonId: "daemon_sponsor",
      explicitDaemonPin: false,
      homeDaemonId: "daemon_home",
      online: new Set(["daemon_home", "daemon_sponsor"]),
      accessible: () => true,
    });
    expect(target).toBe("daemon_home");
  });

  it("falls back to the incidental sponsor daemon when home is OFFLINE (no hard fail)", async () => {
    const target = await decideForward({
      incidentalDaemonId: "daemon_sponsor",
      explicitDaemonPin: false,
      homeDaemonId: "daemon_home",
      online: new Set(["daemon_sponsor"]),
      accessible: () => true,
    });
    expect(target).toBe("daemon_sponsor");
  });

  it("falls back to the incidental sponsor daemon when home is online but INACCESSIBLE", async () => {
    const target = await decideForward({
      incidentalDaemonId: "daemon_sponsor",
      explicitDaemonPin: false,
      homeDaemonId: "daemon_home",
      online: new Set(["daemon_home", "daemon_sponsor"]),
      accessible: (id) => id !== "daemon_home",
    });
    expect(target).toBe("daemon_sponsor");
  });

  it("keeps the incidental daemon UNCHANGED when the cybo has NO home (null)", async () => {
    const target = await decideForward({
      incidentalDaemonId: "daemon_sponsor",
      explicitDaemonPin: false,
      homeDaemonId: null,
      online: new Set(["daemon_home", "daemon_sponsor"]),
      accessible: () => true,
    });
    expect(target).toBe("daemon_sponsor");
  });

  it("honors an EXPLICIT pin: an online home does NOT override a deliberate daemon choice", async () => {
    const target = await decideForward({
      incidentalDaemonId: "daemon_sponsor",
      explicitDaemonPin: true,
      homeDaemonId: "daemon_home",
      online: new Set(["daemon_home", "daemon_sponsor"]),
      accessible: () => true,
    });
    expect(target).toBe("daemon_sponsor");
  });
});
