// Windows-only: kill the detached PtyHost before an auto-update uninstall.
//
// WHY THIS EXISTS — "Failed to uninstall old application files .: 2"
// PtyHost terminal-persistence (CLAUDE.md: DEFAULT ON, opt out with
// CYBORG7_PTY_HOST=0) spawns a long-lived host via
// `spawn(process.execPath, …, { detached: true, stdio: "ignore" }); child.unref()`
// (server/cyborg/pty-host-launcher.ts spawnHostDetached). On a packaged Windows
// app `process.execPath` is `Cyborg.exe`, so the host is a SESSION-DETACHED
// sibling — NOT in the daemon's process tree. The daemon's
// `taskkill /pid <daemonPid> /t /f` (daemon-manager.ts forceKillProcessTree)
// therefore cannot reach it, and on shutdown the daemon deliberately does NOT
// kill it (it `detachAll()`s the socket to keep ptys alive across a restart). So
// after `stopDesktopManagedDaemonIfNeeded()` the host is STILL ALIVE.
//
// node-pty is `asarUnpack`'d, so the live host holds an OS file handle on
// `…/app.asar.unpacked/node_modules/node-pty/build/Release/*.node` (+ ConPTY /
// winpty helpers) inside the install dir. If it survives into the NSIS uninstall,
// the uninstaller can't delete those files and exits with code 2 — the update
// aborts and never relaunches.
//
// FIX (Windows only — macOS/Linux do an in-place-free Squirrel/AppImage swap and
// the surviving host is fine there): BEFORE `quitAndInstall`, ask the host to
// shut down gracefully over its socket (so node-pty unloads the `.node` and
// releases the handle cleanly), then, if it is still alive, force-kill it BY PID
// with the same `taskkill /pid <pid> /t /f` primitive the daemon uses.
//
// PID-TARGETED ONLY: we must NOT run a blanket `taskkill /IM Cyborg.exe` from
// inside the running app — that would kill THIS main process before it can call
// quitAndInstall. The image-name catch-all lives ONLY in installer.nsh, where the
// killer is `Cyborg-Setup-*.exe` / `Un_*.exe`, never `Cyborg.exe`.

import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import log from "electron-log/main";

// Mirror server/cyborg/pty-host-paths.ts WITHOUT importing the server package
// (desktop-cyborg has no server dep and there is no live launcher instance in the
// main process). The launcher binds the socket at
// `join(<host base dir>, "pty-host.sock")`, where the base dir is the daemon's
// PASEO_HOME. We resolve the SAME path the daemon was started with.
const PTY_HOST_SOCKET_NAME = "pty-host.sock";
const PTY_HOST_SOCKET_ENV = "CYBORG7_PTY_HOST_SOCKET";
// Matches CYBORG7_HOME_DEFAULT in daemon-manager.ts (getCyborg7Home), which sets
// process.env.PASEO_HOME on first use, so by the time we run on the install path
// PASEO_HOME is already populated; the literal default is a belt fallback.
const CYBORG7_HOME_DEFAULT = path.join(homedir(), ".cyborg7");

// Budget: a quick connect, a short wait for the host to honor the graceful
// shutdown frame, then a PID-targeted taskkill fallback. Kept well under the
// quit watchdog so it never blocks the install handoff.
const CONNECT_TIMEOUT_MS = 1000;
const HELLO_TIMEOUT_MS = 1000;
const GRACEFUL_EXIT_WAIT_MS = 1500;
const GRACEFUL_POLL_MS = 100;
const TASKKILL_TIMEOUT_MS = 1500;
// After a force taskkill, poll that the pid is actually gone (the OS tears the
// process down asynchronously) and then settle briefly so Windows releases the
// handle on the unpacked node-pty .node BEFORE quitAndInstall starts the uninstall
// — otherwise the uninstaller can still see the locked file and fail with code 2.
const POST_KILL_GONE_WAIT_MS = 1500;
const POST_KILL_POLL_MS = 100;
const POST_KILL_SETTLE_MS = 700;
// Bound the wait for the graceful {type:"shutdown"} frame to flush before we close
// the socket, so a stuck/backed-up socket can't hang the install handoff.
const SHUTDOWN_FLUSH_TIMEOUT_MS = 500;

function resolvePtyHostSocketPath(): string {
  const fromEnv = process.env[PTY_HOST_SOCKET_ENV];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const home =
    process.env.PASEO_HOME && process.env.PASEO_HOME.length > 0
      ? process.env.PASEO_HOME
      : CYBORG7_HOME_DEFAULT;
  return path.join(home, PTY_HOST_SOCKET_NAME);
}

// Newline-delimited JSON framing — the wire protocol from
// server/cyborg/pty-host-protocol.ts (encodeFrame/FrameDecoder), inlined so the
// desktop bundle stays free of a server import. One JSON object per line.
function encodeFrame(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

function tryConnect(socketPath: string, timeoutMs: number): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    let settled = false;
    const settle = (value: Socket | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (value === null) socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    socket.once("connect", () => settle(socket));
    socket.once("error", () => settle(null));
  });
}

// Read the host's pid from its `hello` response so the taskkill fallback can be
// PID-targeted. Returns null on any framing/timeout error (the graceful shutdown
// + the NSIS image-name backstop still cover us).
function readHostPid(socket: Socket, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const settle = (value: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.length > 0) {
          try {
            const frame = JSON.parse(line) as {
              type?: string;
              ok?: boolean;
              result?: { pid?: number };
            };
            // The launcher's `hello` resolves to the PtyHostHelloResult directly;
            // on the wire that is a {type:"response", ok:true, result:{…pid}}.
            if (frame.type === "response" && frame.ok === true) {
              const pid = frame.result?.pid;
              settle(typeof pid === "number" && pid > 0 ? pid : null);
              return;
            }
          } catch {
            // Not a complete/valid frame yet — keep reading until the timeout.
          }
        }
        index = buffer.indexOf("\n");
      }
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    socket.on("data", onData);
    socket.write(encodeFrame({ type: "hello", requestId: "desktop-install-hello" }));
  });
}

// PID-targeted force kill of the host process TREE — the SAME primitive the
// daemon uses (daemon-manager.ts forceKillProcessTree win32 branch). Best-effort:
// resolve on close OR error (a failed kill is covered by the NSIS backstop).
function taskkillTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, TASKKILL_TIMEOUT_MS);
    timer.unref();
    child.on("close", finish);
    child.on("error", finish);
  });
}

// Is the pid still alive? `process.kill(pid, 0)` throws ESRCH when it is gone.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

// Write the graceful {type:"shutdown"} frame and FLUSH it before closing the
// socket. The old code wrote then `socket.destroy()`d immediately — destroy()
// drops any data still in the OS send buffer, so a kernel-buffered frame could be
// thrown away and the host would never receive its clean-unload request. Here we
// wait for the write callback (data accepted into the buffer), then `socket.end()`
// to send a FIN and flush, and resolve on close/end — all bounded by a timeout so
// a wedged socket can never block the install handoff. Best-effort: never throws.
function writeShutdownFrameAndDrain(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(settle, SHUTDOWN_FLUSH_TIMEOUT_MS);
    timer.unref();
    socket.once("close", settle);
    socket.once("error", settle);
    try {
      // end(data, cb): writes the frame, sends FIN, and fires cb once the data is
      // flushed to the kernel — strictly more graceful than write()+destroy().
      socket.end(encodeFrame({ type: "shutdown", requestId: "desktop-install-shutdown" }), () => {
        settle();
      });
    } catch {
      // socket may already be tearing down as the host exits.
      settle();
    }
  });
}

// Poll until the pid is gone (bounded), then settle briefly so the OS releases the
// unpacked node-pty .node handle before the uninstall runs. Windows tears a killed
// process down asynchronously, so taskkill returning does NOT mean the handle is
// free yet — this closes that gap (the NSIS path already has its own Sleep).
// Returns whether the pid was CONFIRMED gone, so the caller can decide whether it
// is safe to proceed to quitAndInstall (the host must not be alive when the NSIS
// uninstall starts — it locks the unpacked node-pty binaries → code 2).
async function waitForPidGoneAndSettle(pid: number): Promise<boolean> {
  const deadline = Date.now() + POST_KILL_GONE_WAIT_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) break;
    await sleep(POST_KILL_POLL_MS);
  }
  const gone = !isAlive(pid);
  if (gone) {
    log.info("[pty-host] host pid gone after taskkill", { pid });
  } else {
    log.warn("[pty-host] host pid still present after taskkill — settling anyway", { pid });
  }
  await sleep(POST_KILL_SETTLE_MS);
  return gone;
}

// Result of stopPtyHostForInstall, so the install path can GATE quitAndInstall on a
// confirmed-dead host (FIX B). A live host into the NSIS uninstall = code 2.
export interface StopPtyHostResult {
  // The host pid we learned from the hello handshake, or null if no host was
  // reachable / the pid could not be read. null ⇒ nothing left to confirm.
  hostPid: number | null;
  // True when, at return, the host is known to be gone (no host was running, OR it
  // exited gracefully, OR a force-kill was confirmed). False ⇒ a host pid is (or
  // may still be) alive and the caller should confirm before quitAndInstall.
  confirmedGone: boolean;
}

// Bounded "is this pid finally gone?" confirmation for the install path. The caller
// runs this AFTER stopPtyHostForInstall when that returned confirmedGone:false, to
// avoid calling quitAndInstall while the detached host is still dying. Re-issues a
// PID-targeted force kill each round (cheap, idempotent) and polls. Hard-bounded by
// `budgetMs` so it can never hang the quit. Returns true once the pid is gone.
export async function ensurePtyHostPidGone(pid: number, budgetMs: number): Promise<boolean> {
  if (process.platform !== "win32") return true;
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      log.info("[pty-host] host pid confirmed gone before install", { pid });
      return true;
    }
    // Re-issue the kill — the first taskkill may have raced the host's own teardown
    // or hit a transient failure; another /t /f is harmless if it is already dying.
    await taskkillTree(pid);
    await sleep(POST_KILL_POLL_MS);
  }
  const gone = !isAlive(pid);
  if (!gone) {
    log.warn("[pty-host] host pid STILL alive after confirmation budget — proceeding anyway", {
      pid,
      budgetMs,
    });
  }
  return gone;
}

// Stop the detached PtyHost before quitAndInstall. WINDOWS ONLY — a no-op on
// every other platform, so macOS/Linux behavior is byte-unchanged. Never throws:
// the install handoff must proceed regardless, and the NSIS macro is the backstop
// if this couldn't reach the host. Returns a StopPtyHostResult so the caller can
// GATE quitAndInstall on a confirmed-dead host (FIX B) — a host that is still alive
// when the NSIS uninstall starts locks the unpacked node-pty binaries and fails the
// uninstall with code 2.
export async function stopPtyHostForInstall(): Promise<StopPtyHostResult> {
  if (process.platform !== "win32") return { hostPid: null, confirmedGone: true };

  const socketPath = resolvePtyHostSocketPath();
  let socket: Socket | null = null;
  try {
    socket = await tryConnect(socketPath, CONNECT_TIMEOUT_MS);
    if (!socket) {
      // No host listening (terminal persistence off, or it already exited) →
      // nothing to do. The NSIS image-name kill still backstops a stray Cyborg.exe.
      log.info("[pty-host] no host socket reachable before install — skipping host stop");
      return { hostPid: null, confirmedGone: true };
    }

    // Learn the host pid first (for the PID-targeted fallback), then ask it to
    // shut down gracefully so node-pty unloads its native .node and releases the
    // file handle on the unpacked binary cleanly. Write+FLUSH the frame (and FIN
    // the socket) before closing, so the clean-unload request is never dropped
    // from the OS send buffer by an immediate destroy().
    const pid = await readHostPid(socket, HELLO_TIMEOUT_MS);
    await writeShutdownFrameAndDrain(socket);
    socket = null; // end() above already closed it.
    log.info("[pty-host] requested graceful shutdown before install", { pid });

    if (pid === null) {
      // Couldn't read the pid → we can't PID-kill safely (image-name kill from
      // inside the app would take down THIS process). Give the graceful frame a
      // moment; the NSIS taskkill /IM Cyborg.exe backstop covers the rest. We can't
      // confirm a specific pid is gone, so report confirmedGone:false — but with a
      // null pid the caller has nothing to gate on and falls back to the NSIS macro.
      await sleep(GRACEFUL_EXIT_WAIT_MS);
      return { hostPid: null, confirmedGone: false };
    }

    // Poll for the graceful exit; force-kill BY PID only if it didn't honor it.
    const deadline = Date.now() + GRACEFUL_EXIT_WAIT_MS;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) {
        log.info("[pty-host] host exited gracefully before install", { pid });
        return { hostPid: pid, confirmedGone: true };
      }
      await sleep(GRACEFUL_POLL_MS);
    }
    log.warn("[pty-host] host did not honor graceful shutdown — force killing by pid", { pid });
    await taskkillTree(pid);
    // Force kill returned, but Windows tears the process down asynchronously and
    // only THEN releases the unpacked-.node handle. Poll the pid is actually gone
    // and settle briefly so the uninstall doesn't race the still-held file lock.
    const gone = await waitForPidGoneAndSettle(pid);
    return { hostPid: pid, confirmedGone: gone };
  } catch (err) {
    // Never block the install handoff on a host-stop failure — the NSIS backstop
    // (taskkill /F /T /IM Cyborg.exe in customInit) is the safety net.
    log.warn("[pty-host] stopPtyHostForInstall failed (continuing to install)", { err });
    return { hostPid: null, confirmedGone: false };
  } finally {
    if (socket) socket.destroy();
  }
}

// Learn the pid of the ACTIVE pty-host — the one bound to the current
// $PASEO_HOME/pty-host.sock — by connecting and reading its hello, WITHOUT shutting
// it down. Used by the Windows orphan reaper (FIX D) to know which host is the live,
// in-use one so it is NEVER reaped. Returns null when no host is reachable or the
// pid can't be read (then the reaper simply spares nothing extra — see its own
// childless/ownership guards). Never throws. WINDOWS ONLY; null elsewhere.
export async function readActiveHostPid(): Promise<number | null> {
  if (process.platform !== "win32") return null;
  const socketPath = resolvePtyHostSocketPath();
  let socket: Socket | null = null;
  try {
    socket = await tryConnect(socketPath, CONNECT_TIMEOUT_MS);
    if (!socket) return null;
    return await readHostPid(socket, HELLO_TIMEOUT_MS);
  } catch {
    return null;
  } finally {
    if (socket) socket.destroy();
  }
}
