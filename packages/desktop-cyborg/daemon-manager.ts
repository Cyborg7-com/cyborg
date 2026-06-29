import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, ipcMain, powerMonitor } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import log from "electron-log/main";
import { resolvePaseoHome, spawnProcess } from "./desktop-utils.js";
import { isTrustedAppOrigin } from "./trusted-origin.js";
import {
  createNodeEntrypointInvocation,
  resolveDaemonRunnerEntrypoint,
} from "./daemon-runtime-paths.js";
import { decideDaemonClaim } from "./daemon-claim-decision.js";
import { createClipboardCommandHandlers } from "./desktop-clipboard.js";
import {
  ensureDaemonPortFree,
  type PortOwner,
  resolveDaemonListenPort,
} from "./daemon-port-guard.js";

const CYBORG7_HOME_DEFAULT = "~/.cyborg7";
const DAEMON_LOG_FILENAME = "daemon.log";
const STARTUP_POLL_INTERVAL_MS = 200;
const STARTUP_POLL_MAX_ATTEMPTS = 150;
const DETACHED_STARTUP_GRACE_MS = 1200;
const STARTUP_OUTPUT_CAPTURE_LIMIT_CHARS = 64 * 1024;

type DaemonState = "starting" | "running" | "stopped" | "errored";

export interface CyborgDaemonStatus {
  serverId: string;
  status: DaemonState;
  listen: string | null;
  pid: number | null;
  home: string;
  version: string | null;
  desktopManaged: boolean;
  error: string | null;
}

interface StartupOutputCapture {
  text: string;
  truncated: boolean;
}

function getCyborg7Home(): string {
  if (!process.env.PASEO_HOME) {
    process.env.PASEO_HOME = CYBORG7_HOME_DEFAULT;
  }
  return resolvePaseoHome(process.env);
}

function logFilePath(): string {
  return path.join(getCyborg7Home(), DAEMON_LOG_FILENAME);
}

// The embedded daemon only connects to the Cyborg relay when CYBORG_RELAY_URL is
// set (server/bootstrap.ts), and registers under a user when $PASEO_HOME/daemon-owner
// exists. The desktop persists both here so the daemon (re)connects to the cloud
// relay as the logged-in user on every start. See claim_desktop_daemon below.
function daemonOwnerFilePath(): string {
  return path.join(getCyborg7Home(), "daemon-owner");
}

function relayUrlFilePath(): string {
  return path.join(getCyborg7Home(), "cyborg-relay-url");
}

// Validate a renderer-supplied relay URL before persisting it as the spawned
// daemon's CYBORG_RELAY_URL. A compromised renderer must not be able to point the
// daemon (and its auth/token flow) at an attacker-controlled relay: require a
// WebSocket scheme, and only allow insecure ws:// for loopback (local dev).
function isAcceptableRelayUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "wss:") return true;
  if (url.protocol === "ws:") {
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  }
  return false;
}

function readTrimmedFile(filePath: string): string {
  try {
    return readFileSync(filePath, "utf-8").trim();
  } catch {
    return "";
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "EPERM") {
      return true;
    }
    return false;
  }
}

// On Windows, process.kill(pid) terminates ONLY that pid — not the processes it
// spawned. The embedded daemon runs as a second `Cyborg.exe` (ELECTRON_RUN_AS_NODE)
// and itself spawns a server child (also `Cyborg.exe`), so a lone process.kill
// leaves that grandchild alive; the NSIS updater then sees a running `Cyborg.exe`
// and loops forever on "Cyborg cannot be closed". taskkill /T kills the whole tree
// by pid so nothing survives into the install.
//
// On POSIX a lone SIGKILL of the daemon pid is NOT enough either (the old comment
// here was wrong): the daemon forks a server WORKER, and when we hard-kill just the
// supervisor pid the worker is RE-PARENTED to init and keeps running — a zombie that
// still holds the cloud-relay slot. The daemon is spawned with `detached: true`,
// which makes it a process-GROUP LEADER whose pgid equals its pid, so we send the
// signal to the whole group with a NEGATIVE pid (`process.kill(-pid)`): that reaps
// the supervisor AND its worker in one shot.
//
// The group kill is the ONLY place we use a negative pid, and it is heavily gated
// because a misdirected `-pid` can signal an UNRELATED process group (#840
// regression: a stale/reused supervisor pid from a manual upgrade made the group
// kill fire on the wrong group, and the teardown/respawn handoff failed):
//   1. pid > 1 — a negative sign on a tiny/edge pid (0, 1) is dangerous (0 = our
//      own group, 1 = init's group).
//   2. lockNamesDesktopManagedPid(pid) — re-read paseo.pid right now so we only
//      ever group-signal a daemon WE manage whose lock still names this exact pid.
// If either gate fails (or the group signal throws, e.g. the group is already gone
// → ESRCH), we fall back to the lone pid so we still tear down what we can without
// risking an unrelated group.
function forceKillProcessTree(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (process.platform === "win32") {
      // Async spawn (not spawnSync) so the Electron main process isn't blocked
      // while taskkill walks the tree — stopDaemon also runs on normal restarts,
      // not just shutdown, where a synchronous stall would freeze the UI. Resolve
      // on close OR error: a failure is best-effort (the one-click installer also
      // force-closes by exe name).
      const child = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
      return;
    }
    // Group kill only when guarded (pid > 1) AND gated (the lock still names this
    // exact desktop-managed pid). Negative pid → signal the whole process group
    // (supervisor + forked worker) so no zombie worker is orphaned.
    if (pid > 1 && lockNamesDesktopManagedPid(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
        resolve();
        return;
      } catch {
        // The group may already be gone, or the daemon was not a group leader.
        // Fall through to the lone-pid fallback below.
      }
    }
    // Lone-pid fallback: the pid is unsafe to group-signal (edge pid, or the lock
    // no longer names it), or the group signal threw. Kill just this pid.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    resolve();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Look up the process LISTENING on 127.0.0.1:<port> using `lsof`, then resolve its
// full command line via `ps` so we can verify it's OUR daemon before killing it.
// macOS-compatible (`lsof -nP -iTCP:<port> -sTCP:LISTEN`). Returns null when the
// port is free or the host has no lsof. Windows has no detached-orphan port-squat
// problem here (the embedded daemon is reaped by taskkill /T on stop), so we skip.
function lookupPortOwner(port: number): Promise<PortOwner | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  return new Promise<PortOwner | null>((resolve) => {
    const lsof = spawn("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"], {
      windowsHide: true,
    });
    let out = "";
    lsof.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    lsof.on("error", () => resolve(null));
    lsof.on("close", () => {
      const pid = parseLsofListenerPid(out);
      if (pid === null) {
        resolve(null);
        return;
      }
      resolveProcessCommand(pid).then((command) => resolve({ pid, command }));
    });
  });
}

// `lsof -F` emits one field per line, prefixed by a type char: `p<pid>` opens each
// process record. Return the first pid (the listener on that port).
function parseLsofListenerPid(lsofOutput: string): number | null {
  for (const line of lsofOutput.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number.parseInt(line.slice(1), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  }
  return null;
}

// Resolve a pid's full command line (`ps -o command=`) so the port guard can match
// it against our daemon entrypoint markers. Empty string on any failure (then the
// guard treats it as foreign and refuses to kill — the safe default).
function resolveProcessCommand(pid: number): Promise<string> {
  return new Promise<string>((resolve) => {
    const ps = spawn("ps", ["-p", String(pid), "-o", "command="], { windowsHide: true });
    let out = "";
    ps.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    ps.on("error", () => resolve(""));
    ps.on("close", () => resolve(out.trim()));
  });
}

function sigkillPid(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    resolve();
  });
}

// Before spawning, make sure the daemon's configured listen port isn't squatted by
// a stale orphan that the lock-based reaper missed (the root cause of the macOS
// dead-daemon EADDRINUSE crash-loop). Throws a CLEAR error if the port can't be
// freed, so the manager surfaces it instead of letting the worker crash-loop.
async function freeListenPortBeforeSpawn(): Promise<void> {
  const home = getCyborg7Home();
  const port = resolveDaemonListenPort({ env: process.env, paseoHome: home });
  const result = await ensureDaemonPortFree(port, {
    lookupPortOwner,
    killPid: sigkillPid,
    sleep,
    log: (message, details) => logDaemonLifecycle(message, details),
  });

  if (result.status === "skipped-foreign") {
    throw new Error(
      `Daemon listen port 127.0.0.1:${port} is held by another process (pid ${result.pid}: ${result.command}). ` +
        `Quit it — or run Cyborg with a different PASEO_LISTEN/PORT — then restart.`,
    );
  }
  if (result.status === "stuck") {
    throw new Error(
      `Could not free daemon listen port 127.0.0.1:${port}: pid ${result.pid} (${result.command}) is still listening after SIGKILL. ` +
        `Restart the machine or kill it manually (kill -9 ${result.pid}), then restart Cyborg.`,
    );
  }
}

function tailFile(filePath: string, lines = 50): string {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.split("\n").filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function createStartupOutputCapture(): StartupOutputCapture {
  return { text: "", truncated: false };
}

function appendStartupOutput(capture: StartupOutputCapture, chunk: Buffer): StartupOutputCapture {
  const nextText = capture.text + chunk.toString();
  if (nextText.length <= STARTUP_OUTPUT_CAPTURE_LIMIT_CHARS) {
    return { text: nextText, truncated: capture.truncated };
  }
  return {
    text: nextText.slice(-STARTUP_OUTPUT_CAPTURE_LIMIT_CHARS),
    truncated: true,
  };
}

function formatStartupOutput(capture: StartupOutputCapture): string {
  if (!capture.truncated) return capture.text;
  return `[output truncated to the last ${STARTUP_OUTPUT_CAPTURE_LIMIT_CHARS} chars]\n${capture.text}`;
}

function logDaemonLifecycle(message: string, details?: Record<string, unknown>): void {
  log.info("[cyborg7 daemon]", message, { pid: process.pid, ...details });
}

function resolveAppVersion(): string {
  if (app.isPackaged) return app.getVersion();

  try {
    const packageJsonPath = path.join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
    // Fall through
  }

  return app.getVersion();
}

export function isDesktopManagedDaemonRunningSync(): boolean {
  try {
    const raw = readFileSync(path.join(getCyborg7Home(), "paseo.pid"), "utf-8");
    const lock = JSON.parse(raw) as { pid?: unknown; desktopManaged?: unknown };
    if (lock.desktopManaged !== true) return false;
    if (typeof lock.pid !== "number" || !Number.isInteger(lock.pid)) return false;
    return isProcessRunning(lock.pid);
  } catch {
    return false;
  }
}

// The daemon persists its stable identity to `$PASEO_HOME/server-id` (see
// packages/server/src/server/server-id.ts), NOT to the pid lock. Read it from
// there — otherwise serverId is always empty and pollForRunningDaemon spins the
// full 30s timeout waiting for an id the lock never carries.
function readServerId(home: string): string {
  try {
    return readFileSync(path.join(home, "server-id"), "utf-8").trim();
  } catch {
    return "";
  }
}

async function resolveStatus(): Promise<CyborgDaemonStatus> {
  const home = getCyborg7Home();

  try {
    const pidFile = path.join(home, "paseo.pid");
    // Async read: resolveStatus runs in the startup poll (up to
    // STARTUP_POLL_MAX_ATTEMPTS iterations); a sync read there would block the
    // Electron main process on every tick (issue #186).
    const raw = await readFile(pidFile, "utf-8");
    const lock = JSON.parse(raw) as {
      pid?: number;
      listen?: string;
      serverId?: string;
      version?: string;
      desktopManaged?: boolean;
    };

    if (typeof lock.pid !== "number" || !isProcessRunning(lock.pid)) {
      return {
        serverId: "",
        status: "stopped",
        listen: null,
        pid: null,
        home,
        version: null,
        desktopManaged: false,
        error: null,
      };
    }

    // A live process holds this home's pid lock — but is it OURS? The lock is
    // only ours if it carries desktopManaged:true (set via PASEO_DESKTOP_MANAGED
    // at spawn). A foreign occupant (a `pnpm dev:cyborg` server that shared this
    // home, or a stray Paseo) writes a lock WITHOUT that flag.
    //
    // We can neither report "running" (that's the bug that left the desktop
    // daemon silently unspawned) NOR just spawn our own: the server's
    // acquirePidLock() rejects any live existing paseo.pid, so the child would
    // immediately exit with a lock error and the daemon still wouldn't come up.
    // Surface a non-startable ERROR naming the squatter so the user (or the UI
    // tab) resolves the conflict instead.
    if (lock.desktopManaged !== true) {
      const where = typeof lock.listen === "string" ? ` on ${lock.listen}` : "";
      return {
        serverId: "",
        status: "errored",
        listen: typeof lock.listen === "string" ? lock.listen : null,
        pid: lock.pid,
        home,
        version: null,
        desktopManaged: false,
        error: `Another process (pid ${lock.pid}${where}) owns Cyborg's daemon home (${home}). Quit it — or run dev with CYBORG_HOME=~/.cyborg7-dev — then restart Cyborg.`,
      };
    }

    return {
      serverId:
        typeof lock.serverId === "string" && lock.serverId.length > 0
          ? lock.serverId
          : readServerId(home),
      status: "running",
      listen: typeof lock.listen === "string" ? lock.listen : null,
      pid: lock.pid,
      home,
      version: typeof lock.version === "string" ? lock.version : null,
      desktopManaged: lock.desktopManaged === true,
      error: null,
    };
  } catch {
    return {
      serverId: "",
      status: "stopped",
      listen: null,
      pid: null,
      home,
      version: null,
      desktopManaged: false,
      error: null,
    };
  }
}

function buildStartupFailureError(
  result: { code: number | null; signal: string | null; error?: Error },
  stdout: StartupOutputCapture,
  stderr: StartupOutputCapture,
): Error {
  const reason = result.error
    ? result.error.message
    : `exit code ${result.code ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}`;
  const parts = [`Daemon failed to start: ${reason}`];
  const formattedStderr = formatStartupOutput(stderr).trim();
  const formattedStdout = formatStartupOutput(stdout).trim();
  if (formattedStderr) parts.push(`stderr:\n${formattedStderr}`);
  if (formattedStdout) parts.push(`stdout:\n${formattedStdout}`);
  const logs = tailFile(logFilePath(), 15);
  if (logs) parts.push(`Recent logs (${logFilePath()}):\n${logs}`);
  return new Error(parts.join("\n\n"));
}

async function pollForRunningDaemon(): Promise<CyborgDaemonStatus> {
  async function poll(attempt: number): Promise<CyborgDaemonStatus> {
    if (attempt >= STARTUP_POLL_MAX_ATTEMPTS) return resolveStatus();
    const status = await resolveStatus();
    if (attempt === 0 || attempt === STARTUP_POLL_MAX_ATTEMPTS - 1 || attempt % 10 === 9) {
      logDaemonLifecycle("polling daemon status after detached start", {
        attempt: attempt + 1,
        status: status.status,
        pid: status.pid,
        listen: status.listen,
        serverId: status.serverId || null,
      });
    }
    if (status.status === "running" && status.serverId && status.listen) return status;
    await sleep(STARTUP_POLL_INTERVAL_MS);
    return poll(attempt + 1);
  }
  return poll(0);
}

function normalizeVersion(version: string | null): string | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, "");
}

function shouldRestartForVersion(current: CyborgDaemonStatus): boolean {
  if (!current.desktopManaged) return false;
  const appVersion = normalizeVersion(resolveAppVersion());
  const daemonVersion = normalizeVersion(current.version);
  return Boolean(appVersion && daemonVersion && appVersion !== daemonVersion);
}

async function startDaemon(): Promise<CyborgDaemonStatus> {
  const current = await resolveStatus();
  logDaemonLifecycle("initial status check before start", {
    status: current.status,
    pid: current.pid,
    listen: current.listen,
    serverId: current.serverId || null,
    error: current.error,
    desktopManaged: current.desktopManaged,
  });

  if (current.status === "running") {
    if (shouldRestartForVersion(current)) {
      logDaemonLifecycle("daemon version mismatch, restarting", {
        appVersion: normalizeVersion(resolveAppVersion()),
        daemonVersion: normalizeVersion(current.version),
      });
      await stopDaemon();
    } else {
      return current;
    }
  }

  // A live foreign process owns this home's lock (resolveStatus → "errored").
  // Spawning would just hit the server's acquirePidLock and exit, so don't try —
  // return the error so the conflict is surfaced and the user/UI can resolve it.
  if (current.status === "errored") {
    logDaemonLifecycle("foreign process owns daemon home — not spawning", {
      pid: current.pid,
      listen: current.listen,
      error: current.error,
    });
    return current;
  }

  // Before spawning, reap any worker orphaned by a prior teardown where the
  // supervisor died but its forked worker survived (the residual #851 left). An
  // orphaned worker still holds the cloud-relay slot, so respawning without
  // reaping it would stack two workers across a version-mismatch restart.
  reapOrphanedWorker();

  // Free the configured listen port before spawning. A stale orphaned daemon (one
  // not recorded in the current paseo.pid lock, so missed by reapOrphanedWorker)
  // can still be LISTENING on it and ignore SIGTERM — the new worker would then
  // crash-loop on EADDRINUSE forever and the relay would see the daemon as dead.
  // SIGKILL only OUR daemons; throw a clear error if a foreign process holds it.
  await freeListenPortBeforeSpawn();

  const daemonRunner = resolveDaemonRunnerEntrypoint();
  const invocation = createNodeEntrypointInvocation({
    entrypoint: daemonRunner,
    argvMode: "node-script",
    args: [],
    baseEnv: process.env,
  });

  logDaemonLifecycle("starting detached daemon", {
    appIsPackaged: app.isPackaged,
    daemonRunnerEntry: daemonRunner.entryPath,
    command: invocation.command,
    args: invocation.args,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  });

  const envOverlay: Record<string, string> = {
    PASEO_DESKTOP_MANAGED: "1",
    PASEO_HOME: getCyborg7Home(),
  };
  const relayUrl = readTrimmedFile(relayUrlFilePath());
  if (relayUrl) envOverlay.CYBORG_RELAY_URL = relayUrl;
  // FIX A (Windows auto-update lock): forward the external native dir the main
  // process relocated node-pty/better-sqlite3 into, so the daemon (and the
  // pty-host it spawns, which inherits the daemon's env) loads those .node images
  // from OUTSIDE the install dir. Already in process.env via baseEnv; set
  // explicitly so propagation never depends on the invocation env filter.
  const nativeDir = process.env.CYBORG7_NATIVE_DIR;
  if (nativeDir) envOverlay.CYBORG7_NATIVE_DIR = nativeDir;

  const child: ChildProcess = spawnProcess(invocation.command, invocation.args, {
    detached: true,
    envMode: "internal",
    env: invocation.env,
    envOverlay,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = createStartupOutputCapture();
  let stderr = createStartupOutputCapture();
  child.stdout!.on("data", (data: Buffer) => {
    stdout = appendStartupOutput(stdout, data);
  });
  child.stderr!.on("data", (data: Buffer) => {
    stderr = appendStartupOutput(stderr, data);
  });

  logDaemonLifecycle("detached spawn returned", {
    childPid: child.pid ?? null,
    spawnfile: child.spawnfile,
  });

  child.unref();

  type GraceResult =
    | { exitedEarly: false }
    | { exitedEarly: true; code: number | null; signal: string | null; error?: Error };

  const result = await new Promise<GraceResult>((resolve) => {
    let settled = false;
    const finish = (value: GraceResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => finish({ exitedEarly: false }), DETACHED_STARTUP_GRACE_MS);

    child.once("error", (error) => {
      clearTimeout(timer);
      finish({ exitedEarly: true, code: null, signal: null, error });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      finish({ exitedEarly: true, code, signal });
    });
  });

  logDaemonLifecycle("detached startup grace period completed", {
    childPid: child.pid ?? null,
    exitedEarly: result.exitedEarly,
    stdout: formatStartupOutput(stdout).slice(0, 2000),
    stderr: formatStartupOutput(stderr).slice(0, 2000),
    ...(result.exitedEarly
      ? { exitCode: result.code, signal: result.signal, error: result.error?.message ?? null }
      : {}),
  });

  if (result.exitedEarly) {
    throw buildStartupFailureError(result, stdout, stderr);
  }

  return pollForRunningDaemon();
}

// Does paseo.pid currently name THIS pid as our desktop-managed daemon? Re-read
// right before a hard kill so a stale lock or a reused PID can never make us
// SIGKILL an unrelated process.
function lockNamesDesktopManagedPid(pid: number): boolean {
  try {
    const raw = readFileSync(path.join(getCyborg7Home(), "paseo.pid"), "utf-8");
    const lock = JSON.parse(raw) as { pid?: unknown; desktopManaged?: unknown };
    return lock.desktopManaged === true && lock.pid === pid;
  } catch {
    return false;
  }
}

// The supervisor pid recorded in our desktop-managed lock, or null when the lock
// is absent / foreign / malformed. The supervisor (scripts/supervisor.ts) owns
// paseo.pid; it forks the worker into its OWN process group (spawned detached →
// pgid == supervisor pid), so this pid doubles as the group id used for reaping.
function recordedDesktopManagedSupervisorPid(): number | null {
  try {
    const raw = readFileSync(path.join(getCyborg7Home(), "paseo.pid"), "utf-8");
    const lock = JSON.parse(raw) as { pid?: unknown; desktopManaged?: unknown };
    if (lock.desktopManaged !== true) return null;
    if (typeof lock.pid !== "number" || !Number.isInteger(lock.pid) || lock.pid <= 1) return null;
    return lock.pid;
  } catch {
    return null;
  }
}

// Reap an ORPHANED worker before a respawn (the residual #851 left). #851 made
// forceKillProcessTree group-kill the supervisor+worker, but its
// lockNamesDesktopManagedPid guard SKIPS the hard kill when the supervisor has
// ALREADY exited (resolveStatus then reports "stopped" and the pid is lost) while
// the forked worker lives on, reparented to init and still holding the cloud-relay
// slot. Across a version-mismatch restart that orphan would stack under the new
// daemon. So right before we spawn, detect that case and group-kill the orphan.
//
// Detection (no full process scan): our lock still records the supervisor pid +
// desktopManaged even after the supervisor died (the file persists). If that
// supervisor process is GONE but its process GROUP still has live members
// (process.kill(-pid, 0) succeeds), the survivor is the orphaned worker — reap the
// group. Heavily gated, same posture as #851's group kill (the negative pid is the
// only risky primitive here):
//   • the lock is desktop-managed and names a real pid (> 1),
//   • the SUPERVISOR is actually dead (a live supervisor is the normal stop path's
//     job — never touch it here), and
//   • the group still has members (otherwise there's nothing to reap).
// If the supervisor's pid was reused by an unrelated live process we bail (it's
// not dead), so we never group-signal a stranger.
function reapOrphanedWorker(): void {
  if (process.platform === "win32") return; // no POSIX process groups
  const pid = recordedDesktopManagedSupervisorPid();
  if (pid === null) return;
  // A live supervisor is NOT an orphan — leave it to the normal stop path.
  if (isProcessRunning(pid)) return;
  // Supervisor dead: does its group still have a survivor (the orphaned worker)?
  let groupAlive = false;
  try {
    process.kill(-pid, 0);
    groupAlive = true;
  } catch (err) {
    // ESRCH → the group is empty (no orphan); EPERM → members exist but we can't
    // signal them (still an orphan worth attempting to reap).
    if (typeof err === "object" && err !== null && "code" in err && err.code === "EPERM") {
      groupAlive = true;
    }
  }
  if (!groupAlive) return;
  logDaemonLifecycle("reaping orphaned daemon worker before respawn", { supervisorPid: pid });
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group raced to empty between the probe and the kill — nothing to do.
  }
}

async function stopDaemon(): Promise<CyborgDaemonStatus> {
  const status = await resolveStatus();
  if (status.status !== "running" || !status.pid) return status;

  // Only ever kill a daemon WE manage. A daemon the user started manually has no
  // desktopManaged lock, so the app must not kill it; and a stale paseo.pid whose
  // PID has been reused by an unrelated process must not be killed either.
  if (!status.desktopManaged) {
    logDaemonLifecycle("refusing to stop a non-desktop-managed daemon", { pid: status.pid });
    return status;
  }

  logDaemonLifecycle("stopping daemon", { pid: status.pid });

  // Windows has no POSIX signals: process.kill(pid, "SIGTERM") is a TerminateProcess
  // of the SUPERVISOR pid ONLY — it does NOT cascade to the forked worker. If we took
  // the POSIX SIGTERM-then-wait path on win32, the supervisor would die, the wait loop
  // would see it gone, and the gated forceKillProcessTree below would be SKIPPED
  // (isProcessRunning(status.pid) is now false) — orphaning the worker. That orphaned
  // worker (and any pty-host child) keeps the native .node images packaged UNDER
  // $INSTDIR memory-mapped (better_sqlite3.node, node-pty's conpty.node), which is
  // exactly what fails the auto-update uninstall with "Failed to uninstall old
  // application files .: 2". So on Windows reap the WHOLE tree by pid UP FRONT —
  // taskkill /pid <supervisor> /t /f, via forceKillProcessTree — while the PPID
  // linkage is still intact, instead of orphaning the worker. Gate on the lock still
  // naming this exact desktop-managed pid so a reused pid is never tree-killed (same
  // safety posture as the POSIX hard kill below).
  if (process.platform === "win32") {
    if (lockNamesDesktopManagedPid(status.pid)) {
      await forceKillProcessTree(status.pid);
      await sleep(200);
    }
    return resolveStatus();
  }

  try {
    // Graceful SIGTERM to the LONE supervisor pid on every platform — NOT the
    // process group. A clean SIGTERM lets the supervisor shut down and reap its OWN
    // forked worker, so nothing is orphaned into a zombie holding the relay slot;
    // the group kill is unnecessary on this common path. It is also unsafe here:
    // this graceful path runs on every version-mismatch restart, where the recorded
    // supervisor pid may be stale or reused (the #840 regression — a negative-pid
    // SIGTERM then signalled an unrelated group and the respawn handoff failed). We
    // escalate to the gated group SIGKILL in forceKillProcessTree below only after a
    // graceful SIGTERM fails to bring the supervisor down (the only path that
    // actually orphans the worker). win32 never reaches this POSIX block — it is
    // handled by the unconditional taskkill /T tree-kill above.
    process.kill(status.pid, "SIGTERM");
    // Wait out the WORKER's own graceful-shutdown budget before escalating. The
    // supervisor forwards SIGTERM to its forked worker (scripts/supervisor.ts),
    // and the worker's force-exit timer is 10s (daemon-worker.ts beginShutdown).
    // The old 5s grace (50×100ms) SIGKILLed the supervisor before the worker
    // finished — so the worker was mid-teardown when its parent died and could
    // orphan (reparent to init) holding the cloud-relay slot. Wait past the
    // worker's 10s (here 13s) so a CLEAN teardown wins on the common path; only a
    // genuinely-stuck worker reaches the gated group SIGKILL below.
    for (let i = 0; i < 130; i++) {
      await sleep(100);
      if (!isProcessRunning(status.pid)) break;
    }
    // Re-verify the lock still names our pid before the hard kill: if the process
    // exited and its PID was reused, that PID may now belong to something else.
    if (isProcessRunning(status.pid) && lockNamesDesktopManagedPid(status.pid)) {
      await forceKillProcessTree(status.pid);
      await sleep(200);
    }
  } catch {
    // Process already gone
  }

  return resolveStatus();
}

async function restartDaemon(): Promise<CyborgDaemonStatus> {
  await stopDaemon();
  return startDaemon();
}

function getDaemonLogs(): { logPath: string; contents: string } {
  const logPath = logFilePath();
  return {
    logPath,
    contents: tailFile(logPath, 100),
  };
}

// Bind the embedded daemon to the logged-in user + cloud relay. The UI calls this
// after login with the user id and the relay WS URL (derived from the server it
// connected to). We persist both and restart the daemon only when something
// changed, so it (re)connects to the cloud relay as that user. Subsequent app
// launches read the persisted files at spawn and connect immediately. A stale or
// foreign claim self-heals (see decideDaemonClaim) instead of silently no-op-ing.
async function claimDesktopDaemon(args?: Record<string, unknown>): Promise<CyborgDaemonStatus> {
  const ownerId = typeof args?.ownerId === "string" ? args.ownerId.trim() : "";
  const relayUrl = typeof args?.relayUrl === "string" ? args.relayUrl.trim() : "";
  if (!ownerId || !relayUrl) {
    throw new Error("claim_desktop_daemon requires ownerId and relayUrl");
  }
  if (!isAcceptableRelayUrl(relayUrl)) {
    throw new Error(`claim_desktop_daemon rejected an invalid relay URL: ${relayUrl}`);
  }
  const currentOwner = readTrimmedFile(daemonOwnerFilePath());
  const currentRelay = readTrimmedFile(relayUrlFilePath());
  const decision = decideDaemonClaim(currentOwner, currentRelay, ownerId, relayUrl);

  if (decision.action === "defer") {
    // A different user is actively running this device's daemon on the same Cyborg
    // relay — respect first-claim (the relay is the owner-of-record).
    logDaemonLifecycle(`claim deferred — ${decision.reason}`, {
      currentOwner,
      attemptedBy: ownerId,
    });
    return resolveStatus();
  }
  if (decision.action === "noop") {
    return resolveStatus();
  }

  writeFileSync(daemonOwnerFilePath(), `${ownerId}\n`, { mode: 0o600 });
  writeFileSync(relayUrlFilePath(), `${relayUrl}\n`, { mode: 0o600 });
  logDaemonLifecycle(
    decision.healed
      ? "auto-healed stale/foreign daemon claim — rebound to logged-in user + cloud relay"
      : "claimed by user, restarting to connect to cloud relay",
    {
      ownerId,
      relayUrl,
      previousOwner: currentOwner || null,
      previousRelay: currentRelay || null,
    },
  );
  return restartDaemon();
}

export type DesktopCommandHandler = (args?: Record<string, unknown>) => unknown | Promise<unknown>;

export function createDaemonCommandHandlers(): Record<string, DesktopCommandHandler> {
  return {
    desktop_get_runtime_info: () => ({
      appVersion: resolveAppVersion(),
    }),
    desktop_daemon_status: () => resolveStatus(),
    start_desktop_daemon: () => startDaemon(),
    stop_desktop_daemon: () => stopDaemon(),
    restart_desktop_daemon: () => restartDaemon(),
    claim_desktop_daemon: (args) => claimDesktopDaemon(args),
    desktop_daemon_logs: () => getDaemonLogs(),
    desktop_get_system_idle_time: () => powerMonitor.getSystemIdleTime() * 1000,
  };
}

export async function startDesktopDaemon(): Promise<CyborgDaemonStatus> {
  return startDaemon();
}

export function registerDaemonManager(): void {
  // Daemon-control commands plus the native clipboard command — both flow through
  // the single trusted-origin-guarded `cyborg7:invoke` channel (one dispatch point,
  // one preload surface). Clipboard logic stays in its own module.
  const handlers: Record<string, DesktopCommandHandler> = {
    ...createDaemonCommandHandlers(),
    ...createClipboardCommandHandlers(),
  };

  ipcMain.handle(
    "cyborg7:invoke",
    async (event, command: string, args?: Record<string, unknown>) => {
      // Daemon-control commands (start/stop/claim/logs) may only be driven by the
      // app's own renderer frame — exact scheme+host match via the shared helper
      // (issue #241), defence-in-depth alongside the will-navigate guard.
      if (!isTrustedAppOrigin(event.senderFrame?.url ?? "")) {
        throw new Error("desktop command rejected: untrusted sender frame");
      }
      const handler = handlers[command];
      if (!handler) {
        throw new Error(`Unknown desktop command: ${command}`);
      }
      return await handler(args);
    },
  );
}

export async function stopDesktopManagedDaemonIfNeeded(): Promise<boolean> {
  if (!isDesktopManagedDaemonRunningSync()) return false;
  await stopDaemon();
  return true;
}
