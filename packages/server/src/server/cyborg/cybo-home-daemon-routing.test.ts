import { describe, expect, it, vi } from "vitest";
import {
  applyHomeDaemonRouting,
  describeHomeDaemonFallback,
  resolveSpawnDaemon,
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
