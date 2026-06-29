// PtyHostReaper — reap EMPTY orphan pty-host processes on daemon start (#860).
//
// THE LEAK: the pty-host is detached ON PURPOSE so live terminals survive a
// daemon restart (internal docs). The contract is "one host per daemon-home, bound
// to the stable socket ($PASEO_HOME/pty-host.sock); on connect-or-start the daemon
// REUSES the surviving host". A host with ZERO live ptys is supposed to self-exit
// after the 5min idle grace (pty-host-process.ts DEFAULT_IDLE_SHUTDOWN_MS). When
// that self-exit fails to fire (the box was asleep, the timer was unref'd and the
// loop drained, the host lost its socket but kept running), the empty host lingers
// as an orphan (reparented to init/launchd, PPID 1). Across daemon restarts these
// pile up — the issue observed 3+, including an 18h+ orphan.
//
// THE INVARIANT (the whole point of pty-host persistence): a host that is SERVING
// LIVE PTYS MUST NEVER be reaped. We detect "serving live ptys" structurally: a
// host's ptys are its CHILD PROCESSES (node-pty spawns the shell as a child of the
// host). So an orphan with zero child processes has zero live ptys and is safe to
// reap; an orphan with ANY child is presumed to be serving a pty and is left
// alone. We ALSO never touch the host the daemon just connected to (its pid comes
// back from the hello handshake) — that is the live, in-use host by definition.
//
// Cyborg-owned (cyborg/, hooked from the EXTENDED launcher). Does not modify
// Paseo's agent/ engine. POSIX-only — Windows has no detached pty-host.

import type { Logger } from "pino";

import { terminateWithTreeKill } from "../../utils/tree-kill.js";
import {
  PTY_HOST_EXCLUDE_TOKEN,
  snapshotProcesses,
  type ProcessEntry,
} from "./agent-backend-reaper.js";

const GRACEFUL_TIMEOUT_MS = 2_000;
const FORCE_TIMEOUT_MS = 1_000;

// A pty-host process is identified by the host entry token in its command line —
// the same token the agent-backend reaper uses to EXCLUDE the host from its kill
// set. Matching is substring on the lower-cased command.
function isPtyHostCommand(command: string): boolean {
  return command.toLowerCase().includes(PTY_HOST_EXCLUDE_TOKEN);
}

export interface IdentifyOrphanPtyHostsInput {
  /**
   * The pid of the host the daemon just connected to (from the hello handshake).
   * That host is live + in-use by definition and is NEVER a reap candidate, even
   * if a snapshot race makes it look child-less. Omit when no host was connected.
   */
  readonly livePid?: number;
  /**
   * A substring identifying THIS daemon's PASEO_HOME — the host's socket path, which
   * the launcher now passes as a trailing argv so it shows up in the `ps` command
   * line. When set, ONLY hosts whose command line contains this marker are reap
   * candidates, so a second daemon on the same machine never reaps another daemon's
   * idle persistence host (each lives under a different PASEO_HOME / socket path).
   * Omit to consider every machine pty-host (legacy, machine-wide behavior).
   */
  readonly homeMarker?: string;
}

/**
 * Pick the EMPTY orphan pty-host processes from a process snapshot. A candidate
 * must be ALL of:
 *   • a pty-host process (command contains the host entry token), and
 *   • orphaned (reparented to init/launchd, PPID 1) — a host with a live non-init
 *     parent belongs to a running daemon and must not be touched, and
 *   • NOT the host we just connected to (livePid), and
 *   • childless — zero child processes ⇒ zero live ptys (node-pty shells are
 *     children of the host). ANY child ⇒ presumed serving a live pty ⇒ SPARED.
 *
 * This is the load-bearing safety property of #860: a host serving live ptys is
 * never returned, so terminal persistence is preserved.
 */
export function identifyOrphanPtyHosts(
  processes: readonly ProcessEntry[],
  input: IdentifyOrphanPtyHostsInput = {},
): number[] {
  const { livePid, homeMarker } = input;
  // Which pids have at least one child? Those hosts are serving live ptys.
  const hasChild = new Set<number>();
  for (const entry of processes) {
    hasChild.add(entry.ppid);
  }

  const victims: number[] = [];
  for (const entry of processes) {
    if (entry.pid <= 1) continue;
    if (entry.ppid !== 1) continue;
    if (livePid !== undefined && entry.pid === livePid) continue;
    if (!isPtyHostCommand(entry.command)) continue;
    // Scope to THIS daemon's PASEO_HOME: a host whose command line does not carry
    // our socket-path marker belongs to a DIFFERENT daemon-home — never our orphan.
    if (homeMarker !== undefined && !entry.command.includes(homeMarker)) continue;
    // The single most important guard: a host with ANY child process is presumed
    // to be serving a live pty — NEVER reap it.
    if (hasChild.has(entry.pid)) continue;
    victims.push(entry.pid);
  }
  return victims;
}

async function killPid(pid: number, logger: Logger): Promise<void> {
  const target = {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill(signal?: NodeJS.Signals | number): boolean {
      try {
        return process.kill(pid, signal);
      } catch {
        return false;
      }
    },
  };
  try {
    await terminateWithTreeKill(target, {
      gracefulTimeoutMs: GRACEFUL_TIMEOUT_MS,
      forceTimeoutMs: FORCE_TIMEOUT_MS,
      onForceSignal: () => {
        logger.warn({ pid }, "Empty orphan pty-host did not exit after SIGTERM; sending SIGKILL");
      },
    });
  } catch (err) {
    logger.warn({ err, pid }, "Failed to kill empty orphan pty-host");
  }
}

/**
 * On daemon START: find EMPTY (childless) orphan pty-host processes left by a prior
 * daemon's life — hosts that should have self-exited at the 5min idle grace but
 * didn't — and kill them, so empty hosts do not accumulate across restarts (#860).
 * NEVER reaps a host serving live ptys (any child) nor the host the daemon just
 * connected to (livePid). No-op on Windows.
 */
export async function reapOrphanPtyHosts(
  logger: Logger,
  deps: {
    livePid?: number;
    // See IdentifyOrphanPtyHostsInput.homeMarker — scopes the reap to this daemon's
    // PASEO_HOME so a second daemon never reaps another daemon's idle host.
    homeMarker?: string;
    snapshot?: () => Promise<ProcessEntry[]>;
    kill?: (pid: number) => Promise<void>;
  } = {},
): Promise<number[]> {
  if (process.platform === "win32") {
    return [];
  }
  const snapshot = deps.snapshot ?? (() => snapshotProcesses());
  const kill = deps.kill ?? ((pid: number) => killPid(pid, logger));

  let processes: ProcessEntry[];
  try {
    processes = await snapshot();
  } catch (err) {
    logger.warn({ err }, "Could not snapshot processes to reap empty orphan pty-hosts");
    return [];
  }

  const victims = identifyOrphanPtyHosts(processes, {
    livePid: deps.livePid,
    homeMarker: deps.homeMarker,
  });
  if (victims.length === 0) {
    return [];
  }
  logger.warn(
    { count: victims.length, pids: victims, livePid: deps.livePid },
    "Reaping empty orphan pty-host processes left by a prior daemon (zero live ptys)",
  );
  await Promise.all(victims.map((pid) => kill(pid)));
  return victims;
}
