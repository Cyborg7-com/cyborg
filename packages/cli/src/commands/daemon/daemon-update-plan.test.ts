import { describe, it, expect, vi } from "vitest";
import { planAndRunUpdate, type UpdateDeps, type RollbackPoint } from "./daemon-update-plan.js";

function makeDeps(over: Partial<UpdateDeps> = {}): { deps: UpdateDeps; calls: string[] } {
  const calls: string[] = [];
  const point: RollbackPoint = { kind: "version", ref: "1.0.0" };
  const deps: UpdateDeps = {
    currentVersion: () => "1.0.0",
    latestVersion: async () => "1.1.0",
    backup: async () => {
      calls.push("backup");
      return point;
    },
    applyUpdate: async () => {
      calls.push("apply");
      return "1.1.0";
    },
    restart: async () => {
      calls.push("restart");
    },
    verifyOnline: async () => {
      calls.push("verify");
      return { online: true, version: "1.1.0" };
    },
    rollback: async () => {
      calls.push("rollback");
    },
    log: () => {},
    ...over,
  };
  return { deps, calls };
}

describe("planAndRunUpdate (#662)", () => {
  it("happy path: backup → apply → restart → verify → updated", async () => {
    const { deps, calls } = makeDeps();
    const out = await planAndRunUpdate(deps);
    expect(out).toEqual({ action: "updated", versionBefore: "1.0.0", versionAfter: "1.1.0" });
    expect(calls).toEqual(["backup", "apply", "restart", "verify"]);
  });

  it("short-circuits when already on the latest version (no restart, no mutation)", async () => {
    const { deps, calls } = makeDeps({ latestVersion: async () => "1.0.0" });
    const out = await planAndRunUpdate(deps);
    expect(out).toEqual({ action: "up-to-date", version: "1.0.0" });
    expect(calls).toEqual([]); // never touched the daemon
  });

  it("--force updates even when already latest", async () => {
    const { deps, calls } = makeDeps({
      latestVersion: async () => "1.0.0",
      applyUpdate: async () => {
        calls.push("apply");
        return "1.0.0"; // same version, forced
      },
    });
    const out = await planAndRunUpdate(deps, { force: true });
    expect(out.action).toBe("updated");
    expect(calls).toEqual(["backup", "apply", "restart", "verify"]);
  });

  it("treats a no-op install (version unchanged) as up-to-date — no restart", async () => {
    const { deps, calls } = makeDeps({
      latestVersion: async () => null, // can't resolve latest (source/offline)
      applyUpdate: async () => {
        calls.push("apply");
        return "1.0.0"; // git pull was a no-op
      },
    });
    const out = await planAndRunUpdate(deps);
    expect(out).toEqual({ action: "up-to-date", version: "1.0.0" });
    expect(calls).toEqual(["backup", "apply"]); // stopped before restart
  });

  it("rolls back when the new daemon does not come online", async () => {
    const rollback = vi.fn(async () => {});
    const { deps, calls } = makeDeps({
      verifyOnline: async () => {
        calls.push("verify");
        return { online: false, version: null };
      },
      rollback: async (p) => {
        calls.push("rollback");
        await rollback(p);
      },
    });
    const out = await planAndRunUpdate(deps, { verifyTimeoutMs: 10 });
    expect(out).toMatchObject({
      action: "rolled-back",
      versionBefore: "1.0.0",
      attemptedVersion: "1.1.0",
    });
    expect(rollback).toHaveBeenCalledWith({ kind: "version", ref: "1.0.0" });
    expect(calls).toEqual(["backup", "apply", "restart", "verify", "rollback"]);
  });

  it("propagates a rollback failure (fatal — needs manual intervention)", async () => {
    const { deps } = makeDeps({
      verifyOnline: async () => ({ online: false, version: null }),
      rollback: async () => {
        throw new Error("npm reinstall failed");
      },
    });
    await expect(planAndRunUpdate(deps)).rejects.toThrow("npm reinstall failed");
  });

  it("captures the rollback point BEFORE applying the update", async () => {
    const order: string[] = [];
    const { deps } = makeDeps({
      backup: async () => {
        order.push("backup");
        return { kind: "git", ref: "abc123" };
      },
      applyUpdate: async () => {
        order.push("apply");
        return "1.1.0";
      },
    });
    await planAndRunUpdate(deps);
    expect(order).toEqual(["backup", "apply"]);
  });
});
