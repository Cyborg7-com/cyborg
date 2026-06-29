// PtyHostLauncher — connect-or-start probe + version-skew handshake
// (internal docs-2.3).
//
// On daemon boot:
//   1. TRY to connect() to $PASEO_HOME/pty-host.sock.
//   2. If reachable → say hello, inspect the host's wire-version:
//        • compatible → REUSE the running host (the restart case: live ptys
//          survived); listTerminals() seeds the client's proxies.
//        • incompatible → DRAIN the host (read its list, request shutdown so the
//          old ptys end as #750 history) and respawn a fresh host. This turns
//          "daemon binary changed mid-flight" into a clean fallback, not a hang.
//   3. If ECONNREFUSED/ENOENT → spawn a fresh host and poll the socket until it
//      is ready, then hello + listTerminals.
//
// HOST SPAWN — escaping the systemd cgroup (internal docs, LIVE-validated):
// `detached:true` only escapes the process GROUP, NOT the systemd CGROUP. On a
// systemd box the daemon runs inside `/system.slice/cyborg7-daemon.service`; a
// bare detached child lands in the SAME cgroup, and `systemctl restart` with the
// default `KillMode=control-group` SIGKILLs the whole cgroup — reaping the host
// and every pty it owns. So persistence FAILS under systemd despite detached.
// The surgical fix: on Linux-under-systemd launch ONLY the host in its own
// transient `systemd-run --user --scope` unit, which lives OUTSIDE the service
// cgroup, so a restart reaps the daemon's other children normally but leaves the
// host alone. Fallback chain (degrade, never crash):
//   systemd-run --user --scope  →  bare detached+stdio:ignore+unref (macOS, and
//   non-systemd / no-user-manager Linux; on a systemd box without a usable user
// scope, persistence then requires KillMode=process on the unit — internal docs).

import { connect, type Socket } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { ensurePtyHostBaseDir, resolvePtyHostSocketPath } from "./pty-host-paths.js";
import { PtyHostTerminalManager } from "./pty-host-client.js";
import { reapOrphanPtyHosts } from "./pty-host-reaper.js";
import {
  FrameDecoder,
  encodeFrame,
  isPtyHostResponse,
  PTY_HOST_WIRE_VERSION,
  type PtyHostHelloResult,
  type PtyHostRequest,
  type PtyHostTerminalInfo,
  type PtyHostToClientMessage,
} from "./pty-host-protocol.js";

const CONNECT_TIMEOUT_MS = 2000;
const STARTUP_DEADLINE_MS = 10000;
const STARTUP_POLL_INTERVAL_MS = 100;
const HANDSHAKE_TIMEOUT_MS = 3000;
// How long we wait for `systemd-run --user --scope` to PROVE the scope registered
// before declaring success. With `--scope`, a successful systemd-run stays alive as
// the scope's foreground process for the host's whole lifetime; a FAILURE (no user
// bus, ENOENT, denied) exits almost immediately. So "still alive after this window"
// is a reliable success signal — and an early exit lets us fall back to bare-detached
// FAST instead of waiting out the 10s socket deadline (the silent-stall bug).
const SCOPE_REGISTER_PROBE_MS = 500;

export interface PtyHostLauncherOptions {
  baseDir?: string;
  socketPath?: string;
  // Override the host entry module (tests point at a real built host or a stub).
  hostEntry?: string;
  // Test seam: spawn a host without a child process (e.g. an in-process host).
  // Returns once the socket is listening. When omitted the launcher spawns a
  // detached node child running pty-host-process.ts.
  spawnHost?: (socketPath: string) => Promise<void> | void;
  // Test seam: override the systemd-user-scope probe so a test can assert which
  // spawn path the launcher chooses without a real systemd manager. When omitted
  // the real detectSystemdUserScope() is used.
  detectSystemd?: () => boolean;
  // Test/diagnostic counters.
  onSpawn?: () => void;
  // Logger for the orphan-reap diagnostics (bootstrap passes its child logger).
  logger?: Logger;
  // On launch we reap EMPTY orphan pty-hosts left by a prior daemon (#860). This
  // seam lets tests stub the reap (assert it ran with the right live pid) without a
  // real `ps`/kill. Receives the live host's pid (from hello) so the reaper never
  // touches the host we just connected to. When omitted, the real reaper runs
  // fire-and-forget so boot is never blocked by the process scan.
  reapOrphans?: (livePid: number | undefined) => void | Promise<void>;
  // Called with the spawn path actually taken ("systemd-scope" | "detached").
  // Defaults to a log; tests assert on it.
  onSpawnStrategy?: (strategy: PtyHostSpawnStrategy) => void;
}

export interface PtyHostLaunchResult {
  manager: PtyHostTerminalManager;
  // True when an already-running host was reused (the restart/survival case).
  reused: boolean;
  // True when a version-incompatible host was drained + a fresh one respawned.
  respawnedForVersionSkew: boolean;
}

function resolveHostEntry(options: PtyHostLauncherOptions): string {
  if (options.hostEntry) return options.hostEntry;
  // Resolve a sibling module URL; works for both .ts (tsx) and built .js.
  const url = import.meta.url.endsWith(".ts")
    ? new URL("./pty-host-process.ts", import.meta.url)
    : new URL("./pty-host-process.js", import.meta.url);
  return fileURLToPath(url);
}

// Resolve the exec argv needed to run a .ts host entry under the same TS loader
// the daemon uses, matching Paseo's worker bootstrap (worker-terminal-manager.ts).
function resolveHostExecArgv(hostEntry: string): string[] {
  if (!hostEntry.endsWith(".ts")) return [];
  const loaderUrl = new URL("../../terminal/terminal-ts-loader.mjs", import.meta.url).href;
  const importSource = [
    'import { register } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    `register(${JSON.stringify(loaderUrl)}, pathToFileURL("./"));`,
  ].join(" ");
  return [
    "--experimental-strip-types",
    "--import",
    `data:text/javascript,${encodeURIComponent(importSource)}`,
  ];
}

function tryConnect(socketPath: string, timeoutMs: number): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    // Null the resolver on first settle so the connect/error/timeout race fulfils
    // exactly once (mirrors terminal.ts waitForProcessExit's settle-once pattern).
    let pendingResolve: ((value: Socket | null) => void) | null = resolve;
    const settle = (value: Socket | null): void => {
      if (!pendingResolve) return;
      const fn = pendingResolve;
      pendingResolve = null;
      clearTimeout(timer);
      if (value === null) socket.destroy();
      fn(value);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    socket.once("connect", () => settle(socket));
    socket.once("error", () => settle(null));
  });
}

// Send one request on a raw socket and await its response, accumulating any
// async events into `events` so a hello-then-list handshake doesn't lose the
// host's pushed frames. Used only during the launcher handshake, before the
// PtyHostTerminalManager takes over the socket's data listener.
function handshakeRequest(
  socket: Socket,
  decoder: FrameDecoder,
  input: Omit<PtyHostRequest, "requestId">,
): Promise<unknown> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`pty-host handshake timed out: ${input.type}`));
    }, HANDSHAKE_TIMEOUT_MS);
    const onData = (chunk: string): void => {
      let frames: unknown[];
      try {
        frames = decoder.feed(chunk);
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error("bad handshake frame"));
        return;
      }
      for (const frame of frames) {
        const message = frame as PtyHostToClientMessage;
        if (isPtyHostResponse(message) && message.requestId === requestId) {
          cleanup();
          if (message.ok) resolve(message.result);
          else reject(new Error(message.error));
          return;
        }
      }
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    function cleanup(): void {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    }
    socket.setEncoding("utf8");
    socket.on("data", onData);
    socket.on("error", onError);
    socket.write(encodeFrame({ ...input, requestId } as PtyHostRequest));
  });
}

// Stable, idempotent transient-unit name. A second launch while one host already
// runs makes systemd-run no-op-fail on the duplicate unit; the launcher's
// connect-or-start probe means we only ever reach spawn when no host answers, and
// `--collect` GCs the dead unit so the name is reusable. Same input → same name.
const PTY_HOST_SCOPE_UNIT = "cyborg7-pty-host";

// How the host child was launched, for diagnostics / the test seam.
export type PtyHostSpawnStrategy = "systemd-scope" | "detached";

// Resolve a per-user runtime dir for `systemd-run --user` / `systemctl --user`.
// Prefer the inherited XDG_RUNTIME_DIR, but DERIVE `/run/user/<uid>` (the standard
// path, where the user bus lives at `$XDG_RUNTIME_DIR/bus`) when it's unset —
// because a SYSTEM service (the headless-daemon deployment: /etc/systemd/system,
// system.slice) gets NO XDG_RUNTIME_DIR in its env, which made the scope escape
// silently fall back to bare-detached → the host stayed in the daemon's cgroup and
// died on every `systemctl restart` (internal docs system-service gap). Returns null
// only when neither is usable (so the caller falls back to bare-detached). Self-
// healing: no manual unit edit (KillMode=process) needed once the user manager is
// reachable (linger on).
export function resolveUserRuntimeDir(): string | null {
  return resolveUserRuntimeDirFrom({
    envValue: process.env.XDG_RUNTIME_DIR,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    exists: existsSync,
  });
}

// Pure core of resolveUserRuntimeDir, with the env/uid/existsSync inputs injected so
// the ROOT case (uid 0, no `/run/user/0`) and the non-root case can be tested
// deterministically on any box. A ROOT daemon falls through to null → the caller
// degrades to bare-detached and the launcher warns to ship KillMode=process; there is
// no per-user manager to reach, so this is correct, not a regression (internal docs).
export function resolveUserRuntimeDirFrom(deps: {
  envValue: string | undefined;
  uid: number | null;
  exists: (path: string) => boolean;
}): string | null {
  if (deps.envValue) return deps.envValue;
  if (deps.uid === null) return null; // non-POSIX (Windows) — never reached on linux anyway
  const derived = `/run/user/${deps.uid}`;
  return deps.exists(derived) ? derived : null;
}

// Detect a usable `systemd-run --user` surface: Linux + systemd-run on PATH + a
// reachable per-user manager. Probes the user bus WITH the resolved runtime dir in
// env (so a system service whose own env lacks XDG_RUNTIME_DIR still reaches it).
// Probed defensively — any failure → false → bare-detached fallback.
function detectSystemdUserScope(): boolean {
  if (process.platform !== "linux") return false;
  const runtimeDir = resolveUserRuntimeDir();
  if (!runtimeDir) return false;
  try {
    const which = spawnSync("systemd-run", ["--version"], { stdio: "ignore" });
    if (which.status !== 0) return false;
  } catch {
    // systemd-run not on PATH / not executable → no scope path.
    return false;
  }
  try {
    // `is-system-running` returns non-zero in degraded states but still answers
    // when the user manager is reachable; a thrown error / missing bus means no
    // user manager (the SSH-session-without-linger case) → fall back. Pass the
    // resolved XDG_RUNTIME_DIR so the probe finds the user bus even when our own
    // env (system service) doesn't carry it.
    const ping = spawnSync("systemctl", ["--user", "is-system-running"], {
      stdio: "ignore",
      env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir },
    });
    // status null = spawn failed (ENOENT); anything else means systemctl --user
    // reached the user bus (running/degraded/starting all return a value).
    return ping.status !== null;
  } catch {
    // systemctl missing / user bus unreachable → no usable user scope → fall back.
    return false;
  }
}

// Best-effort linger so the per-user systemd manager outlives the login/SSH
// session that started the daemon — otherwise the user scope (and the host in it)
// dies when that session ends. Idempotent: a no-op if linger is already on, and a
// hard failure here is non-fatal (we just proceed; the scope still helps for the
// life of the current session, and a non-systemd box no-ops below).
//
// Runs BEFORE the systemd-user-scope detection gate (the caller, `spawnHost`): on a
// FRESH box `loginctl enable-linger` is what CREATES `/run/user/<uid>` and starts the
// per-user manager — the very things detectSystemdUserScope() probes for. If linger
// only ran AFTER detection passed, a first boot without linger could never bootstrap
// the user manager and would be stuck on bare-detached forever (the chicken-and-egg
// gap). Platform-guarded to linux so it's a clean no-op on macOS / Windows.
function ensureLingerBestEffort(): void {
  if (process.platform !== "linux") return;
  try {
    const user = process.env.USER ?? process.env.LOGNAME;
    if (!user) return;
    spawnSync("loginctl", ["enable-linger", user], { stdio: "ignore" });
  } catch {
    // intentional: linger is an availability hardening, not a correctness
    // requirement. If loginctl is absent or denied we still launch the scope.
  }
}

// The hardened systemd drop-in operators MUST ship when the daemon runs as a SYSTEM
// service WITHOUT a usable per-user manager — the canonical case being a ROOT daemon
// (uid 0), where `/run/user/0` does not exist and there is no `systemd --user`
// instance, so the `--user --scope` cgroup escape is unavailable and the host stays
// in the service cgroup. `KillMode=process` makes `systemctl restart` signal ONLY the
// main daemon process, leaving the detached pty-host (and its ptys) alive — the
// linger-independent restart-survival guard (internal docs §3). Trade-off: other
// daemon children also survive a restart, so the daemon reaps its own agent backends
// on shutdown (agent-backend-reaper.ts) — the pty-host is excluded from that reap.
export const RECOMMENDED_PTY_HOST_KILL_MODE = "process";

// Pure builder for the drop-in body — emitted in the fallback warning (below) and
// available for an install/doctor path to write to
// `/etc/systemd/system/cyborg7-daemon.service.d/10-pty-host.conf`.
// TODO(internal docs): wire a `cyborg daemon doctor`/install step that writes this
// drop-in + `systemctl daemon-reload` automatically for the root/system-service case;
// today we only surface it as an actionable warning at spawn time.
export function buildKillModeDropIn(): string {
  return ["[Service]", `KillMode=${RECOMMENDED_PTY_HOST_KILL_MODE}`, ""].join("\n");
}

// The `systemd-run --user --scope` argv that launches the host in its own
// transient unit. Pure (no side effects) so a test can assert the exact recipe
// — `--user --scope` (user cgroup, outside the service slice), `--collect` (GC
// the unit so the stable name is reusable), and the stable `--unit` name.
//
// The host's socket path is passed as a trailing ARGV (not only the env) so it shows
// up in the host's `ps` command line — the orphan reaper scopes its kill set to THIS
// daemon's PASEO_HOME by matching that path, so a second daemon never reaps another
// daemon's idle persistence host. The host reads the socket from env first, argv as a
// visible-in-ps mirror (pty-host-process.ts standalone entry).
export function buildSystemdRunArgs(hostEntry: string, socketPath: string): string[] {
  const execArgv = resolveHostExecArgv(hostEntry);
  return [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    "--unit",
    PTY_HOST_SCOPE_UNIT,
    "--",
    process.execPath,
    ...execArgv,
    hostEntry,
    socketPath,
  ];
}

// Pure builder for the env the scope spawn (and the bare-detached spawn) hand the
// host. Extracted so a test can assert XDG_RUNTIME_DIR is injected when resolvable
// WITHOUT spawning a real process. The resolved runtime dir is the system-service
// self-heal: a SYSTEM service has no XDG_RUNTIME_DIR of its own, so without injecting
// the derived `/run/user/<uid>` the `systemd-run --user` launch can't reach the user
// bus and the host never escapes the cgroup (internal docs — the bug this fixes).
export function buildHostSpawnEnv(input: {
  baseDir: string;
  socketPath: string;
  runtimeDir: string | null;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(input.runtimeDir ? { XDG_RUNTIME_DIR: input.runtimeDir } : {}),
    PASEO_HOME: input.baseDir,
    CYBORG7_PTY_HOST_SOCKET: input.socketPath,
  };
}

// Launch the host inside a transient `--user --scope` unit so it lives OUTSIDE the
// daemon's service cgroup and survives `systemctl restart` (internal docs). Resolves
// true ONLY when the scope is observed to have registered, false to let the caller
// fall back FAST to bare-detached.
//
// Failure detection (the silent-stall fix): the previous version returned `true`
// unconditionally, so a scope that failed to register (e.g. user bus unreachable)
// was indistinguishable from success — the caller then sat on the 10s socket
// deadline before bootstrap fell back to the in-process worker (no persistence + a
// 10s boot stall). With `--scope`, systemd-run runs the host as the scope's
// FOREGROUND process and stays alive for its lifetime; a registration failure exits
// almost immediately. So: still alive after SCOPE_REGISTER_PROBE_MS ⇒ registered ⇒
// true; an early `exit`/`error` ⇒ failed ⇒ false.
async function spawnHostViaSystemdScope(
  hostEntry: string,
  socketPath: string,
  baseDir: string,
): Promise<boolean> {
  // `systemd-run --user` needs XDG_RUNTIME_DIR to find the per-user manager. A SYSTEM
  // service has none in its own env, so inject the resolved (derived) runtime dir —
  // the same one detectSystemdUserScope() probed with.
  const runtimeDir = resolveUserRuntimeDir();
  const child = spawn("systemd-run", buildSystemdRunArgs(hostEntry, socketPath), {
    // Detach + ignore stdio so the launching daemon neither pins nor pipes the
    // scope; the host talks only over its socket (the IPC-suicide trap, internal docs).
    detached: true,
    stdio: "ignore",
    env: buildHostSpawnEnv({ baseDir, socketPath, runtimeDir }),
  });
  return await new Promise<boolean>((resolve) => {
    // Settle-once via nulling the resolver (mirrors tryConnect above), so the
    // timer/error/exit race fulfils the promise exactly once.
    let pendingResolve: ((registered: boolean) => void) | null = resolve;
    const finish = (registered: boolean): void => {
      if (!pendingResolve) return;
      const fn = pendingResolve;
      pendingResolve = null;
      clearTimeout(timer);
      child.off("error", onFailure);
      child.off("exit", onFailure);
      // On success, unref so the daemon's event loop is not pinned by the child
      // handle (the host outlives us via the scope). On failure the child is already
      // gone; the caller falls back to bare-detached.
      if (registered) child.unref();
      fn(registered);
    };
    // ENOENT (systemd-run vanished) or an early scope-registration exit ⇒ failure.
    const onFailure = (): void => finish(false);
    child.once("error", onFailure);
    child.once("exit", onFailure);
    const timer = setTimeout(() => finish(true), SCOPE_REGISTER_PROBE_MS);
    // Don't let the probe timer pin the event loop during a normal boot.
    timer.unref?.();
  });
}

// Bare-detached spawn: correct on macOS (no cgroups) and on non-systemd Linux.
// `detached:true` escapes the process group; without a systemd cgroup that is
// sufficient. Under systemd it is NOT (see internal docs) — guarded by the caller,
// and the launcher emits the KillMode=process drop-in warning when this path is taken
// on linux (the root / no-user-manager case).
function spawnHostDetached(hostEntry: string, socketPath: string, baseDir: string): void {
  const execArgv = resolveHostExecArgv(hostEntry);
  // socketPath trails the argv (visible in `ps`) so the orphan reaper can scope to
  // this daemon's PASEO_HOME; the host still reads it from env first.
  const child = spawn(process.execPath, [...execArgv, hostEntry, socketPath], {
    // detached → new session/group via setsid; survives daemon group signals.
    detached: true,
    // stdio ignore → no inherited fds tying it to the parent; the host writes to
    // its own socket, never to a parent pipe (the IPC-suicide trap, internal docs).
    stdio: "ignore",
    env: buildHostSpawnEnv({ baseDir, socketPath, runtimeDir: null }),
  });
  // Drop the child without waiting — "the host must outlive the short-lived
  // client that launched it" (internal docs). unref() so the daemon's event
  // loop is not pinned by the child handle.
  child.unref();
}

// Injectable spawners — the real implementations by default, overridden in tests
// so the strategy chooser can be asserted without spawning real processes.
export interface SpawnHostDeps {
  detectSystemd: () => boolean;
  // May be sync (test stubs) or async (the real scope spawn, which probes the scope
  // registered before resolving) — the chooser awaits it either way.
  spawnViaScope: (
    hostEntry: string,
    socketPath: string,
    baseDir: string,
  ) => boolean | Promise<boolean>;
  spawnDetached: (hostEntry: string, socketPath: string, baseDir: string) => void;
  ensureLinger: () => void;
}

const defaultSpawnHostDeps: SpawnHostDeps = {
  detectSystemd: detectSystemdUserScope,
  spawnViaScope: spawnHostViaSystemdScope,
  spawnDetached: spawnHostDetached,
  ensureLinger: ensureLingerBestEffort,
};

// Choose the spawn path: systemd user scope when available (Linux + systemd),
// else bare detached. Returns which path was taken so the caller can log it.
// `deps.detectSystemd` is the seam tests drive (mock `process.platform` + a
// `systemd-run`-present probe); the spawners are injectable so no real child is
// launched during the chooser test.
//
// `ensureLinger` runs BEFORE the detection gate: on a fresh box, enabling linger is
// what creates `/run/user/<uid>` + the per-user manager that detectSystemdUserScope()
// needs, so running it only after detection passed would deadlock the first boot
// (the chicken-and-egg gap). The real ensureLinger no-ops off-linux, so this is free
// on macOS / non-systemd.
export async function spawnHost(
  hostEntry: string,
  socketPath: string,
  baseDir: string,
  deps: SpawnHostDeps = defaultSpawnHostDeps,
): Promise<PtyHostSpawnStrategy> {
  deps.ensureLinger();
  if (deps.detectSystemd()) {
    if (await deps.spawnViaScope(hostEntry, socketPath, baseDir)) {
      return "systemd-scope";
    }
  }
  deps.spawnDetached(hostEntry, socketPath, baseDir);
  return "detached";
}

// Log which spawn path was taken. The load-bearing case is detached-on-linux: there
// the service cgroup WILL SIGKILL the host on `systemctl restart` (the root /
// no-user-manager case where the `--user --scope` escape was unavailable), so we WARN
// with the exact `KillMode=process` drop-in operators must ship (internal docs §3)
// — the linger-independent restart-survival guard. Other paths are informational.
function reportSpawnStrategy(strategy: PtyHostSpawnStrategy, logger?: Logger): void {
  if (strategy === "systemd-scope") {
    const msg =
      "[pty-host] spawned host via systemd-scope strategy " +
      "(transient user scope escapes the service cgroup; survives systemctl restart)";
    if (logger) logger.info(msg);
    else console.info(msg);
    return;
  }
  if (process.platform !== "linux") {
    const msg =
      "[pty-host] spawned host via detached strategy (no cgroups; survives daemon restart)";
    if (logger) logger.info(msg);
    else console.info(msg);
    return;
  }
  const warning =
    "[pty-host] spawned host via bare-detached fallback — no usable `systemd --user` scope " +
    "(e.g. a root daemon with no /run/user/<uid>). Under systemd the service cgroup will " +
    "SIGKILL this host on `systemctl restart`, dropping all live terminals. To survive a " +
    "restart in this configuration, ship the hardened drop-in to " +
    "/etc/systemd/system/cyborg7-daemon.service.d/10-pty-host.conf:\n" +
    buildKillModeDropIn() +
    "then `systemctl daemon-reload` (internal docs §3).";
  if (logger) logger.warn(warning);
  else console.warn(warning);
}

// Poll the socket until the freshly-spawned host is listening (bounded), so we
// never attach mid-boot (internal docs readiness probe).
async function waitForSocket(socketPath: string, deadlineMs: number): Promise<Socket> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const socket = await tryConnect(socketPath, CONNECT_TIMEOUT_MS);
    if (socket) return socket;
    if (Date.now() >= deadline) {
      throw new Error("pty-host did not become ready before the deadline");
    }
    await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_INTERVAL_MS));
  }
}

async function helloAndList(
  socket: Socket,
): Promise<{ hello: PtyHostHelloResult; terminals: PtyHostTerminalInfo[] }> {
  const decoder = new FrameDecoder();
  const hello = (await handshakeRequest(socket, decoder, { type: "hello" })) as PtyHostHelloResult;
  const terminals = (await handshakeRequest(socket, decoder, {
    type: "listTerminals",
  })) as PtyHostTerminalInfo[];
  return { hello, terminals };
}

// Bootstrap entry: launch (connect-or-start + version handshake) and return just
// the connected manager. bootstrap awaits this behind CYBORG7_PTY_HOST and uses
// the result as the daemon's TerminalManager.
export async function launchPtyHostTerminalManager(
  options: PtyHostLauncherOptions = {},
): Promise<PtyHostTerminalManager> {
  const result = await launchPtyHost(options);
  return result.manager;
}

export async function launchPtyHost(
  options: PtyHostLauncherOptions = {},
): Promise<PtyHostLaunchResult> {
  const baseDir = ensurePtyHostBaseDir(options.baseDir);
  const socketPath = options.socketPath ?? resolvePtyHostSocketPath(options.baseDir ?? baseDir);
  const hostEntry = resolveHostEntry(options);

  const startFreshHost = async (): Promise<Socket> => {
    options.onSpawn?.();
    if (options.spawnHost) {
      await options.spawnHost(socketPath);
    } else {
      // Clear a stale sock so the new host can bind; the host also unlinks, but
      // doing it here avoids a connect to a dead sock during the poll.
      if (existsSync(socketPath)) {
        try {
          unlinkSync(socketPath);
        } catch {
          // intentional: the host re-unlinks before binding; a failure here is
          // harmless and surfaces as a real bind error if the path is truly stuck.
        }
      }
      const strategy = await spawnHost(
        hostEntry,
        socketPath,
        baseDir,
        options.detectSystemd
          ? { ...defaultSpawnHostDeps, detectSystemd: options.detectSystemd }
          : defaultSpawnHostDeps,
      );
      if (options.onSpawnStrategy) {
        options.onSpawnStrategy(strategy);
      } else {
        reportSpawnStrategy(strategy, options.logger);
      }
    }
    return waitForSocket(socketPath, STARTUP_DEADLINE_MS);
  };

  // Reap EMPTY orphan pty-hosts left by a prior daemon (#860). Runs on every launch
  // path with the LIVE host's pid (from hello) so the reaper never touches the host
  // we just connected to, nor any host serving live ptys. Fire-and-forget by
  // default: the `ps` scan must not delay the daemon's terminal manager coming up.
  const reapEmptyOrphans = (livePid: number | undefined): void => {
    if (options.reapOrphans) {
      // intentional: best-effort fire-and-forget orphan reap — must not delay/fail daemon startup.
      void Promise.resolve(options.reapOrphans(livePid)).catch(() => undefined);
      return;
    }
    const logger = options.logger;
    if (!logger) return; // No logger (in-process tests) → skip the real reaper.
    // Scope the reap to THIS daemon's PASEO_HOME (the host's socket path appears in
    // its `ps` command line) so we never reap a SECOND daemon's idle persistence host
    // — those live under a different PASEO_HOME / socket path.
    void reapOrphanPtyHosts(logger, { livePid, homeMarker: socketPath }).catch((err: unknown) => {
      logger.warn({ err }, "pty-host orphan reap failed");
    });
  };

  const finalize = (
    result: PtyHostLaunchResult,
    livePid: number | undefined,
  ): PtyHostLaunchResult => {
    reapEmptyOrphans(livePid);
    return result;
  };

  // 1. Connect-or-start probe.
  const existing = await tryConnect(socketPath, CONNECT_TIMEOUT_MS);
  if (existing) {
    // 2. Version-skew handshake on the reused host.
    let hello: PtyHostHelloResult;
    let terminals: PtyHostTerminalInfo[];
    try {
      ({ hello, terminals } = await helloAndList(existing));
    } catch {
      // A host that won't complete the handshake is unusable — treat it as
      // absent, respawn fresh.
      existing.destroy();
      const socket = await startFreshHost();
      const fresh = await helloAndList(socket);
      return finalize(
        {
          manager: new PtyHostTerminalManager({ socket, initialTerminals: fresh.terminals }),
          reused: false,
          respawnedForVersionSkew: false,
        },
        fresh.hello.pid,
      );
    }

    if (hello.wireVersion === PTY_HOST_WIRE_VERSION) {
      // Compatible → reuse; live ptys survived, seed proxies from the list.
      return finalize(
        {
          manager: new PtyHostTerminalManager({ socket: existing, initialTerminals: terminals }),
          reused: true,
          respawnedForVersionSkew: false,
        },
        hello.pid,
      );
    }

    // Incompatible → drain (the daemon has the list/history) + shutdown the old
    // host, then respawn a fresh one (internal docs). The drained ptys end as
    // #750 daemon_restart history on the next boot scan.
    try {
      await handshakeRequest(existing, new FrameDecoder(), { type: "shutdown" });
    } catch {
      // intentional: a host that won't honor shutdown is being respawned anyway —
      // the fresh host unlinks the stale sock before binding.
    }
    existing.destroy();
    const socket = await startFreshHost();
    const fresh = await helloAndList(socket);
    return finalize(
      {
        manager: new PtyHostTerminalManager({ socket, initialTerminals: fresh.terminals }),
        reused: false,
        respawnedForVersionSkew: true,
      },
      fresh.hello.pid,
    );
  }

  // 3. No host → spawn fresh, wait for ready, hello + list (empty on a fresh host).
  const socket = await startFreshHost();
  const fresh = await helloAndList(socket);
  return finalize(
    {
      manager: new PtyHostTerminalManager({ socket, initialTerminals: fresh.terminals }),
      reused: false,
      respawnedForVersionSkew: false,
    },
    fresh.hello.pid,
  );
}
