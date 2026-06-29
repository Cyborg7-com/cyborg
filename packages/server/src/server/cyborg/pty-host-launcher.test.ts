// PtyHostLauncher — connect-or-start probe + version-skew handshake
// (internal docs-2.3).
//
//   • first boot spawns a host;
//   • second boot (sock present) REUSES it (no second spawn);
//   • a stale/refused sock respawns.
//
// We drive the launcher's spawnHost test seam to bring up a REAL in-process host
// (so listTerminals/version are genuine), and count spawns via onSpawn.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPtyHost, type PtyHostHandle } from "./pty-host-process.js";
import {
  launchPtyHost,
  spawnHost as chooseSpawnHostStrategy,
  buildSystemdRunArgs,
  buildHostSpawnEnv,
  resolveUserRuntimeDir,
  resolveUserRuntimeDirFrom,
  type SpawnHostDeps,
} from "./pty-host-launcher.js";
import type { PtyHostTerminalManager } from "./pty-host-client.js";

// The user-runtime-dir resolver is the system-service self-heal (internal docs): a
// SYSTEM service has no XDG_RUNTIME_DIR in its env, so the scope escape used to fall
// back to bare-detached and the host died on every daemon restart. The resolver now
// prefers the inherited value but derives /run/user/<uid> when unset.
describe("resolveUserRuntimeDir — system-service XDG_RUNTIME_DIR self-heal", () => {
  const original = process.env.XDG_RUNTIME_DIR;
  afterEach(() => {
    if (original === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = original;
  });

  it("prefers the inherited XDG_RUNTIME_DIR when present", () => {
    process.env.XDG_RUNTIME_DIR = "/run/user/1234";
    expect(resolveUserRuntimeDir()).toBe("/run/user/1234");
  });

  it("when unset, derives ONLY the standard /run/user/<uid> path or null — never a bogus value", () => {
    // Deterministic on every platform: macOS (no /run/user) → null → caller falls
    // back to bare-detached; Linux with a per-user runtime dir → exactly
    // /run/user/<uid>. It must never return anything else (e.g. a stale env value).
    delete process.env.XDG_RUNTIME_DIR;
    const resolved = resolveUserRuntimeDir();
    expect(resolved === null || /^\/run\/user\/\d+$/.test(resolved)).toBe(true);
  });
});

// The injectable core lets us pin the ROOT case (uid 0 with no /run/user/0) and the
// non-root case deterministically, regardless of the box the test runs on.
describe("resolveUserRuntimeDirFrom — root vs non-root derivation", () => {
  it("root daemon (uid 0) with no /run/user/0 → null (degrade to bare-detached + KillMode=process)", () => {
    expect(
      resolveUserRuntimeDirFrom({ envValue: undefined, uid: 0, exists: () => false }),
    ).toBeNull();
  });

  it("non-root with a present /run/user/<uid> → that exact derived path", () => {
    expect(resolveUserRuntimeDirFrom({ envValue: undefined, uid: 1000, exists: () => true })).toBe(
      "/run/user/1000",
    );
  });

  it("an inherited XDG_RUNTIME_DIR always wins, even for root", () => {
    expect(
      resolveUserRuntimeDirFrom({ envValue: "/run/user/0", uid: 0, exists: () => false }),
    ).toBe("/run/user/0");
  });
});

// The scope spawn used to launch `systemd-run --user` WITHOUT XDG_RUNTIME_DIR, so a
// SYSTEM service (no XDG_RUNTIME_DIR of its own) passed DETECTION but the real launch
// couldn't reach the user bus. buildHostSpawnEnv is the pure env the real spawn now
// uses; assert the derived runtime dir is injected when resolvable, omitted when not.
describe("buildHostSpawnEnv — XDG_RUNTIME_DIR injection for the real scope spawn", () => {
  const original = process.env.XDG_RUNTIME_DIR;
  afterEach(() => {
    if (original === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = original;
  });

  it("injects the resolved XDG_RUNTIME_DIR (+ PASEO_HOME + socket) when resolvable", () => {
    delete process.env.XDG_RUNTIME_DIR;
    const env = buildHostSpawnEnv({
      baseDir: "/home/me/.paseo",
      socketPath: "/home/me/.paseo/pty-host.sock",
      runtimeDir: "/run/user/1000",
    });
    expect(env.XDG_RUNTIME_DIR).toBe("/run/user/1000");
    expect(env.PASEO_HOME).toBe("/home/me/.paseo");
    expect(env.CYBORG7_PTY_HOST_SOCKET).toBe("/home/me/.paseo/pty-host.sock");
  });

  it("does NOT inject XDG_RUNTIME_DIR when not resolvable (null) — bare-detached case", () => {
    delete process.env.XDG_RUNTIME_DIR;
    const env = buildHostSpawnEnv({
      baseDir: "/base",
      socketPath: "/base/pty-host.sock",
      runtimeDir: null,
    });
    expect(env.XDG_RUNTIME_DIR).toBeUndefined();
    expect(env.PASEO_HOME).toBe("/base");
  });
});

// Spawn-path chooser: assert systemd-run (--user --scope) is used when systemd is
// detected, and bare-detached otherwise. Drives the injectable seam so no real
// process is spawned (internal docs — the cgroup-escape fix).
describe("pty-host launcher — spawn-path selection (systemd cgroup escape)", () => {
  function makeDeps(detected: boolean) {
    const calls = { scope: 0, detached: 0, linger: 0 };
    const deps: SpawnHostDeps = {
      detectSystemd: () => detected,
      spawnViaScope: () => {
        calls.scope += 1;
        return true;
      },
      spawnDetached: () => {
        calls.detached += 1;
      },
      ensureLinger: () => {
        calls.linger += 1;
      },
    };
    return { deps, calls };
  }

  it("chooses the systemd-run user scope when systemd is detected", async () => {
    const { deps, calls } = makeDeps(true);
    const strategy = await chooseSpawnHostStrategy("/host.js", "/sock", "/base", deps);
    expect(strategy).toBe("systemd-scope");
    expect(calls.scope).toBe(1);
    expect(calls.detached).toBe(0);
    // Linger is ensured before launching the scope.
    expect(calls.linger).toBe(1);
  });

  it("falls back to bare-detached when systemd is NOT detected (macOS / non-systemd)", async () => {
    const { deps, calls } = makeDeps(false);
    const strategy = await chooseSpawnHostStrategy("/host.js", "/sock", "/base", deps);
    expect(strategy).toBe("detached");
    expect(calls.detached).toBe(1);
    expect(calls.scope).toBe(0);
    // Linger is attempted BEFORE detection (chicken-and-egg fix): on a fresh box,
    // enabling linger is what creates the /run/user/<uid> + per-user manager that
    // detection probes for, so a first boot can self-heal. The REAL ensureLinger
    // no-ops off-linux, so this is free on macOS / non-systemd.
    expect(calls.linger).toBe(1);
  });

  it("degrades to detached when systemd-run launch reports unavailable", async () => {
    const { calls } = makeDeps(true);
    const deps: SpawnHostDeps = {
      detectSystemd: () => true,
      spawnViaScope: () => false, // systemd-run could not register the scope
      spawnDetached: () => {
        calls.detached += 1;
      },
      ensureLinger: () => {
        calls.linger += 1;
      },
    };
    const strategy = await chooseSpawnHostStrategy("/host.js", "/sock", "/base", deps);
    expect(strategy).toBe("detached");
    expect(calls.detached).toBe(1);
  });

  it("awaits an ASYNC scope spawn that resolves false and falls back fast", async () => {
    // The real spawnViaScope is async (it probes that the scope registered before
    // resolving). A scope that fails to register resolves false → fall back to
    // detached without waiting out the socket deadline.
    const calls = { scope: 0, detached: 0 };
    const deps: SpawnHostDeps = {
      detectSystemd: () => true,
      spawnViaScope: async () => {
        calls.scope += 1;
        return false;
      },
      spawnDetached: () => {
        calls.detached += 1;
      },
      ensureLinger: () => undefined,
    };
    const strategy = await chooseSpawnHostStrategy("/host.js", "/sock", "/base", deps);
    expect(strategy).toBe("detached");
    expect(calls.scope).toBe(1);
    expect(calls.detached).toBe(1);
  });

  it("builds a stable, idempotent --user --scope --collect --unit recipe", () => {
    const args = buildSystemdRunArgs("/path/to/host.js", "/base/pty-host.sock");
    expect(args.slice(0, 3)).toEqual(["--user", "--scope", "--quiet"]);
    expect(args).toContain("--collect");
    // Stable unit name → a second launch reconnects (idempotent), never collides.
    const unitIdx = args.indexOf("--unit");
    expect(args[unitIdx + 1]).toBe("cyborg7-pty-host");
    // The host entry + socket path are passed after the `--` separator. The socket
    // path trails so it shows up in the host's `ps` line for the reaper's home scope.
    expect(args).toContain("--");
    expect(args[args.length - 1]).toBe("/base/pty-host.sock");
    expect(args[args.length - 2]).toBe("/path/to/host.js");
  });
});

describe("pty-host launcher — connect-or-start", () => {
  const dirs: string[] = [];
  const hosts: PtyHostHandle[] = [];
  const managers: PtyHostTerminalManager[] = [];

  afterEach(async () => {
    for (const m of managers.splice(0)) m.detachAll();
    for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "spawns on first boot, then REUSES the running host on second boot",
    async () => {
      const baseDir = mkdtempSync(join(tmpdir(), "pty-launch-"));
      dirs.push(baseDir);
      const socketPath = join(baseDir, "pty-host.sock");

      let spawnCount = 0;
      const spawnHost = async (sock: string): Promise<void> => {
        const host = await startPtyHost({ baseDir, socketPath: sock });
        hosts.push(host);
      };

      // First boot: no host → spawn one.
      const first = await launchPtyHost({
        baseDir,
        socketPath,
        spawnHost,
        onSpawn: () => {
          spawnCount += 1;
        },
      });
      managers.push(first.manager);
      expect(first.reused).toBe(false);
      expect(spawnCount).toBe(1);

      // Detach the first manager (a "daemon restart") but leave the host running.
      first.manager.detachAll();

      // Second boot: the sock is present + the host answers hello → REUSE.
      const second = await launchPtyHost({
        baseDir,
        socketPath,
        spawnHost,
        onSpawn: () => {
          spawnCount += 1;
        },
      });
      managers.push(second.manager);
      expect(second.reused).toBe(true);
      expect(spawnCount).toBe(1); // no second spawn
    },
    20000,
  );

  it.skipIf(process.platform === "win32")(
    "respawns when the sock is stale/refused",
    async () => {
      const baseDir = mkdtempSync(join(tmpdir(), "pty-launch-"));
      dirs.push(baseDir);
      const socketPath = join(baseDir, "pty-host.sock");
      // A leftover regular file at the sock path → connect() refuses → respawn.
      writeFileSync(socketPath, "stale");

      let spawnCount = 0;
      const result = await launchPtyHost({
        baseDir,
        socketPath,
        spawnHost: async (sock) => {
          const host = await startPtyHost({ baseDir, socketPath: sock });
          hosts.push(host);
        },
        onSpawn: () => {
          spawnCount += 1;
        },
      });
      managers.push(result.manager);
      expect(result.reused).toBe(false);
      expect(spawnCount).toBe(1);
      // The freshly spawned host owns no ptys yet.
      expect(result.manager.listTerminals()).toHaveLength(0);
    },
    20000,
  );

  it.skipIf(process.platform === "win32")(
    "runs the empty-orphan reap with the live host's pid on launch (#860)",
    async () => {
      const baseDir = mkdtempSync(join(tmpdir(), "pty-launch-"));
      dirs.push(baseDir);
      const socketPath = join(baseDir, "pty-host.sock");

      const reapCalls: Array<number | undefined> = [];

      const result = await launchPtyHost({
        baseDir,
        socketPath,
        spawnHost: async (sock) => {
          const host = await startPtyHost({ baseDir, socketPath: sock });
          hosts.push(host);
        },
        reapOrphans: (livePid) => {
          reapCalls.push(livePid);
        },
      });
      managers.push(result.manager);

      // The reaper ran exactly once, with the pid of the host we connected to — so
      // it can spare the live host while reaping any empty orphans. The in-process
      // test host runs in THIS process, so its hello.pid == process.pid.
      expect(reapCalls).toHaveLength(1);
      expect(reapCalls[0]).toBe(process.pid);
    },
    20000,
  );
});
