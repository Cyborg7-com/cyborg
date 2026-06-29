// Free the daemon's configured listen port before spawning a new worker.
//
// ROOT CAUSE this guards against (macOS dead-daemon retro): an ORPHANED
// cyborg/paseo daemon from a previous run can keep LISTENING on the daemon's TCP
// port (e.g. 127.0.0.1:6767) long after its app session ended, and can survive
// graceful SIGTERM. When a fresh daemon worker then tries to bind the same port it
// dies with `EADDRINUSE` (errno -48); the upstream supervisor treats exit code 1
// as a crash and respawns the worker FOREVER. The relay therefore sees the daemon
// as "dead" because it never listens stably.
//
// `reapOrphanedWorker` (PR #853) only reaps the pid recorded in the CURRENT
// paseo.pid lock. A stale orphan from many restarts ago is NOT in that lock, so it
// is missed and keeps squatting the port. This guard closes that gap: it looks up
// whatever process is LISTENING on the configured port, and — only if that process
// is provably one of OURS (its executable/command path matches our daemon
// entrypoint) — SIGKILLs it (SIGTERM is useless; the orphan provably ignores it)
// and waits until the port is free. It NEVER kills an unrelated app that merely
// happens to use the port.

import { readFileSync } from "node:fs";
import path from "node:path";

// Substrings that identify a process as OUR daemon (supervisor / worker / the
// node-entrypoint runner / the packaged Electron helper running as node). Matched
// case-insensitively against the listening process's full command line. Kept
// deliberately specific so we never SIGKILL an unrelated app squatting the port.
export const CYBORG_DAEMON_COMMAND_MARKERS: readonly string[] = [
  "supervisor-entrypoint",
  "daemon-entrypoint-runner",
  "daemon-worker",
  "node-entrypoint-runner",
  "@getpaseo/server",
  "paseo",
  "cyborg",
];

const DEFAULT_DAEMON_PORT = 6780;
export const PORT_FREE_POLL_INTERVAL_MS = 150;
export const PORT_FREE_MAX_ATTEMPTS = 40; // ~6s bound

export interface PortOwner {
  pid: number;
  command: string;
}

export interface PortGuardDeps {
  // Returns the process LISTENING on 127.0.0.1:<port>, or null if the port is
  // free. Implemented with `lsof` on the host; injected here so it can be mocked.
  lookupPortOwner: (port: number) => Promise<PortOwner | null>;
  // SIGKILL a pid. Best-effort; resolves once the signal is delivered (or fails).
  killPid: (pid: number) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  log: (message: string, details?: Record<string, unknown>) => void;
}

// Is this listening process one of OUR daemon processes? Match the recorded
// command/executable path against our entrypoint markers so we NEVER kill an
// unrelated app that merely binds the same port.
export function isOurDaemonCommand(command: string): boolean {
  if (!command) return false;
  const haystack = command.toLowerCase();
  return CYBORG_DAEMON_COMMAND_MARKERS.some((marker) => haystack.includes(marker.toLowerCase()));
}

// Extract the configured listen TCP port the daemon will bind. Returns null when
// the daemon listens on a unix socket (no TCP port to free) or when nothing
// resolvable is found.
export function parseListenPort(listen: string | undefined | null): number | null {
  if (!listen) return null;
  const trimmed = listen.trim();
  if (!trimmed) return null;
  // Unix socket forms have no TCP port to free.
  if (trimmed.startsWith("/") || trimmed.startsWith("unix:")) return null;
  // host:port — take the last colon-segment so IPv6 hosts don't confuse it.
  const lastColon = trimmed.lastIndexOf(":");
  const portPart = lastColon === -1 ? trimmed : trimmed.slice(lastColon + 1);
  const port = Number.parseInt(portPart, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return port;
}

interface ResolveListenPortInput {
  env: NodeJS.ProcessEnv;
  paseoHome: string;
}

// Resolve the port the about-to-spawn daemon will bind, mirroring the server's
// resolveListenAddress() order (config.ts) WITHOUT hardcoding 6767/6780:
// PASEO_LISTEN → PORT → persisted config.json daemon.listen → existing paseo.pid
// lock's listen → DEFAULT_PORT.
export function resolveDaemonListenPort(input: ResolveListenPortInput): number {
  const { env, paseoHome } = input;

  const fromEnvListen = parseListenPort(env.PASEO_LISTEN);
  if (fromEnvListen !== null) return fromEnvListen;

  const fromEnvPort = parseListenPort(env.PORT);
  if (fromEnvPort !== null) return fromEnvPort;

  const configPort = parseListenPort(readListenFromConfig(paseoHome));
  if (configPort !== null) return configPort;

  const lockPort = parseListenPort(readListenFromPidLock(paseoHome));
  if (lockPort !== null) return lockPort;

  return DEFAULT_DAEMON_PORT;
}

function readListenFromConfig(paseoHome: string): string | null {
  try {
    const raw = readFileSync(path.join(paseoHome, "config.json"), "utf-8");
    const parsed = JSON.parse(raw) as { daemon?: { listen?: unknown } };
    const listen = parsed.daemon?.listen;
    return typeof listen === "string" ? listen : null;
  } catch {
    return null;
  }
}

function readListenFromPidLock(paseoHome: string): string | null {
  try {
    const raw = readFileSync(path.join(paseoHome, "paseo.pid"), "utf-8");
    const parsed = JSON.parse(raw) as { listen?: unknown };
    return typeof parsed.listen === "string" ? parsed.listen : null;
  } catch {
    return null;
  }
}

export type FreePortResult =
  | { status: "free" } // nothing was listening, or we freed it
  | { status: "freed"; killedPid: number }
  | { status: "skipped-foreign"; pid: number; command: string }
  | { status: "stuck"; pid: number; command: string };

// Ensure 127.0.0.1:<port> is free before spawning. If OUR orphaned daemon squats
// it, SIGKILL it and wait until the port frees. If a FOREIGN process holds it, do
// NOT kill — report so the caller surfaces a clear error instead of crash-looping.
export async function ensureDaemonPortFree(
  port: number,
  deps: PortGuardDeps,
): Promise<FreePortResult> {
  const owner = await deps.lookupPortOwner(port);
  if (!owner) {
    return { status: "free" };
  }

  if (!isOurDaemonCommand(owner.command)) {
    deps.log("listen port held by a FOREIGN process — refusing to kill", {
      port,
      pid: owner.pid,
      command: owner.command,
    });
    return { status: "skipped-foreign", pid: owner.pid, command: owner.command };
  }

  deps.log("orphaned cyborg daemon squatting listen port — SIGKILL", {
    port,
    pid: owner.pid,
    command: owner.command,
  });
  await deps.killPid(owner.pid);

  for (let attempt = 0; attempt < PORT_FREE_MAX_ATTEMPTS; attempt++) {
    await deps.sleep(PORT_FREE_POLL_INTERVAL_MS);
    const stillOwner = await deps.lookupPortOwner(port);
    if (!stillOwner) {
      deps.log("listen port freed after killing orphan", { port, killedPid: owner.pid });
      return { status: "freed", killedPid: owner.pid };
    }
    // A respawned worker (different pid) may grab the port between our kill and the
    // re-check while the orphan's supervisor crash-loops. Keep killing OUR daemons
    // until the port frees or we exhaust the bound.
    if (stillOwner.pid !== owner.pid && isOurDaemonCommand(stillOwner.command)) {
      deps.log("listen port re-grabbed by another orphaned cyborg daemon — SIGKILL", {
        port,
        pid: stillOwner.pid,
        command: stillOwner.command,
      });
      await deps.killPid(stillOwner.pid);
    }
  }

  const finalOwner = (await deps.lookupPortOwner(port)) ?? owner;
  return { status: "stuck", pid: finalOwner.pid, command: finalOwner.command };
}
