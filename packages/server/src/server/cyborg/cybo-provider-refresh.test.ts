import { homedir } from "node:os";
import { describe, it, expect, vi } from "vitest";
import {
  recheckProviders,
  reconcilePiSnapshotOnStatus,
  refreshPiSnapshotAfterInstall,
  reprobePiBeforeSpawn,
} from "./cybo-provider-refresh.js";

// A snapshot manager that starts with pi at `initial` status and flips pi to
// "available" the moment refreshSnapshotForCwd runs — modelling the real probe:
// after `npm i -g @cyborg7/cybo` links `pi`, a refresh re-probes and finds it.
function makeManager(initial: "available" | "unavailable") {
  let piStatus = initial;
  const refreshSnapshotForCwd = vi.fn(async () => {
    piStatus = "available";
  });
  const listProviders = vi.fn(async () => [
    { provider: "pi", status: piStatus, enabled: piStatus === "available" },
  ]);
  // The helpers only read .provider/.status; cast to the structural param type.
  const manager = { refreshSnapshotForCwd, listProviders } as unknown as Parameters<
    typeof reconcilePiSnapshotOnStatus
  >[0];
  return { manager, refreshSnapshotForCwd, listProviders };
}

const HOME_REFRESH = { cwd: homedir(), providers: ["pi"] };

describe("refreshPiSnapshotAfterInstall", () => {
  it("does NOT refresh after a failed install", async () => {
    const { manager, refreshSnapshotForCwd } = makeManager("unavailable");
    await refreshPiSnapshotAfterInstall(manager, { ok: false });
    expect(refreshSnapshotForCwd).not.toHaveBeenCalled();
  });

  it("does nothing when there is no snapshot manager", async () => {
    await expect(refreshPiSnapshotAfterInstall(null, { ok: true })).resolves.toBeUndefined();
  });

  // The gate: after a successful install the snapshot is refreshed, and a subsequent
  // cybo-spawn provider-check (listProviders) sees pi AVAILABLE — no restart.
  it("refreshes the home pi snapshot on success → the provider-check then sees pi available", async () => {
    const { manager, refreshSnapshotForCwd, listProviders } = makeManager("unavailable");

    // Spawn provider-check BEFORE the fix would block: pi unavailable.
    const before = await listProviders({ wait: true });
    expect(before.find((p) => p.provider === "pi")?.status).toBe("unavailable");

    await refreshPiSnapshotAfterInstall(manager, { ok: true });

    expect(refreshSnapshotForCwd).toHaveBeenCalledTimes(1);
    expect(refreshSnapshotForCwd).toHaveBeenCalledWith(HOME_REFRESH);

    // Spawn provider-check AFTER: pi available → cybo spawns without a restart.
    const after = await listProviders({ wait: true });
    expect(after.find((p) => p.provider === "pi")?.status).toBe("available");
  });

  it("never throws if the refresh rejects (best-effort, snapshot self-heals later)", async () => {
    const refreshSnapshotForCwd = vi.fn(async () => {
      throw new Error("probe failed");
    });
    const manager = { refreshSnapshotForCwd } as unknown as Parameters<
      typeof refreshPiSnapshotAfterInstall
    >[0];
    await expect(refreshPiSnapshotAfterInstall(manager, { ok: true })).resolves.toBeUndefined();
    expect(refreshSnapshotForCwd).toHaveBeenCalled();
  });
});

describe("reconcilePiSnapshotOnStatus (passive)", () => {
  it("does nothing when the CLI is not installed", async () => {
    const { manager, refreshSnapshotForCwd, listProviders } = makeManager("unavailable");
    await reconcilePiSnapshotOnStatus(manager, { installed: false });
    expect(listProviders).not.toHaveBeenCalled();
    expect(refreshSnapshotForCwd).not.toHaveBeenCalled();
  });

  it("refreshes when installed but the cached snapshot still says pi unavailable", async () => {
    const { manager, refreshSnapshotForCwd, listProviders } = makeManager("unavailable");
    await reconcilePiSnapshotOnStatus(manager, { installed: true });
    // Gating read is cached (no `wait`) — does not probe.
    expect(listProviders).toHaveBeenCalledWith({ providers: ["pi"] });
    expect(refreshSnapshotForCwd).toHaveBeenCalledWith(HOME_REFRESH);
  });

  it("does NOT refresh when installed and the snapshot already reports pi available (self-bounding)", async () => {
    const { manager, refreshSnapshotForCwd } = makeManager("available");
    await reconcilePiSnapshotOnStatus(manager, { installed: true });
    expect(refreshSnapshotForCwd).not.toHaveBeenCalled();
  });

  it("does nothing when there is no snapshot manager", async () => {
    await expect(reconcilePiSnapshotOnStatus(null, { installed: true })).resolves.toBeUndefined();
  });
});

describe("reprobePiBeforeSpawn (lazy re-probe at spawn time)", () => {
  it("does NOT refresh when pi is already available — returns the cached entry", async () => {
    const { manager, refreshSnapshotForCwd } = makeManager("available");
    const pi = await reprobePiBeforeSpawn(manager as never);
    expect(refreshSnapshotForCwd).not.toHaveBeenCalled();
    expect(pi?.status).toBe("available");
  });

  // THE bug this fixes: a settled "unavailable" was sticky (wait:true never
  // re-probes), so a pi installed after the last probe blocked spawns until a
  // daemon restart. The lazy re-probe refreshes once and sees it.
  it("refreshes once when the settled snapshot says unavailable → returns the healed entry", async () => {
    const { manager, refreshSnapshotForCwd } = makeManager("unavailable");
    const pi = await reprobePiBeforeSpawn(manager as never);
    expect(refreshSnapshotForCwd).toHaveBeenCalledTimes(1);
    expect(refreshSnapshotForCwd).toHaveBeenCalledWith(HOME_REFRESH);
    expect(pi?.status).toBe("available");
  });

  it("still returns unavailable when pi is genuinely missing (refresh doesn't help)", async () => {
    let calls = 0;
    const manager = {
      refreshSnapshotForCwd: vi.fn(async () => {
        calls += 1; // refresh runs, but the probe still finds nothing
      }),
      listProviders: vi.fn(async () => [{ provider: "pi", status: "unavailable", enabled: false }]),
    };
    const pi = await reprobePiBeforeSpawn(manager as never);
    expect(calls).toBe(1);
    expect(pi?.status).toBe("unavailable"); // caller rejects, as before
  });

  it("returns null (caller keeps current no-pi handling) when pi is absent from the registry", async () => {
    const manager = {
      refreshSnapshotForCwd: vi.fn(async () => {}),
      listProviders: vi.fn(async () => []),
    };
    const pi = await reprobePiBeforeSpawn(manager as never);
    expect(manager.refreshSnapshotForCwd).toHaveBeenCalledTimes(1);
    expect(pi).toBeNull();
  });

  // A pi whose models flip from an old set to a new set the moment refresh runs —
  // models the real scenario: the daemon probed pi at boot (only opencode-go
  // configured), then the user ran `cybo login` → anthropic, but the cached entry
  // still lists the boot-time models.
  function makeStaleModelsManager(before: string[], after: string[]) {
    let models = before;
    const refreshSnapshotForCwd = vi.fn(async () => {
      models = after;
    });
    const listProviders = vi.fn(async () => [
      { provider: "pi", status: "available", enabled: true, models: models.map((id) => ({ id })) },
    ]);
    return { manager: { refreshSnapshotForCwd, listProviders }, refreshSnapshotForCwd };
  }

  // THE second stale shape this fixes: pi is "available" (status not sticky) but
  // its cached models pre-date a `cybo login`. Without the backend hint the
  // re-probe returns the stale list and the per-backend gate wrongly refuses.
  it("refreshes once when the cybo's backend is missing from the cached models → returns the healed entry", async () => {
    const { manager, refreshSnapshotForCwd } = makeStaleModelsManager(
      ["opencode-go/glm-5.1"],
      ["opencode-go/glm-5.1", "anthropic/claude-opus-4-x"],
    );
    const pi = await reprobePiBeforeSpawn(manager as never, "anthropic");
    expect(refreshSnapshotForCwd).toHaveBeenCalledTimes(1);
    expect(refreshSnapshotForCwd).toHaveBeenCalledWith(HOME_REFRESH);
    // The healed list now carries the backend → the gate downstream allows it.
    expect((pi?.models ?? []).map((m: { id: string }) => m.id)).toContain(
      "anthropic/claude-opus-4-x",
    );
  });

  it("does NOT refresh when the cached models already cover the cybo's backend (self-bounding)", async () => {
    const { manager, refreshSnapshotForCwd } = makeStaleModelsManager(
      ["anthropic/claude-opus-4-x"],
      ["anthropic/claude-opus-4-x"],
    );
    const pi = await reprobePiBeforeSpawn(manager as never, "anthropic");
    expect(refreshSnapshotForCwd).not.toHaveBeenCalled();
    expect(pi?.status).toBe("available");
  });

  it("does NOT refresh on a backend gap when the models carry no backend prefix (binary-only runtime)", async () => {
    const { manager, refreshSnapshotForCwd } = makeStaleModelsManager(["glm-5.1"], ["glm-5.1"]);
    // findBackendGap returns null for prefix-less ids (binary verdict), so no refresh.
    await reprobePiBeforeSpawn(manager as never, "anthropic");
    expect(refreshSnapshotForCwd).not.toHaveBeenCalled();
  });
});

describe("recheckProviders ('Re-check providers' button RPC)", () => {
  it("returns [] when there is no snapshot manager", async () => {
    await expect(recheckProviders(null)).resolves.toEqual([]);
  });

  it("refreshes ALL providers for the home cwd and returns the settled statuses", async () => {
    let refreshed = false;
    const manager = {
      refreshSnapshotForCwd: vi.fn(async (opts: { cwd: string; providers?: string[] }) => {
        expect(opts.cwd).toBe(homedir());
        expect(opts.providers).toBeUndefined(); // full re-check, not pi-only
        refreshed = true;
      }),
      listProviders: vi.fn(async () => [
        { provider: "claude", status: "ready", enabled: true },
        { provider: "pi", status: refreshed ? "ready" : "unavailable", enabled: true },
      ]),
    };
    const result = await recheckProviders(manager as never);
    expect(manager.refreshSnapshotForCwd).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      { provider: "claude", status: "ready" },
      { provider: "pi", status: "ready" }, // healed by the refresh
    ]);
  });

  it("still answers with the current snapshot when the refresh fails", async () => {
    const manager = {
      refreshSnapshotForCwd: vi.fn(async () => {
        throw new Error("probe blew up");
      }),
      listProviders: vi.fn(async () => [{ provider: "pi", status: "unavailable", enabled: false }]),
    };
    const result = await recheckProviders(manager as never);
    expect(result).toEqual([{ provider: "pi", status: "unavailable" }]);
  });
});
