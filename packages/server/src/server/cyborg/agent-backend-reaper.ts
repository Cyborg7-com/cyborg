// AgentBackendReaper — kill the daemon's child agent-backend processes on daemon
// death, and reap pre-existing orphans on daemon start.
//
// THE LEAK (knowledge: #840/#851/#855 reaped the daemon + freed the port, but NOT
// its child agent backends): some providers spawn a long-lived helper PROCESS per
// session/agent:
//   • OpenCode  → `opencode serve --port N`   (providers/opencode/server-manager.ts)
//   • Codex     → `codex app-server`           (providers/codex-app-server-agent.ts)
// Both are spawned `detached: true` on POSIX, which makes each its OWN
// process-group leader. That has two consequences when the daemon dies:
//   1. The desktop's group-kill (`process.kill(-supervisorPid)`, #851) signals the
//      SUPERVISOR's group only — a detached backend is in a DIFFERENT group, so it
//      survives.
//   2. A hard daemon death (SIGKILL / crash → process.exit) never runs the
//      provider's `process.on("exit"/"SIGTERM")` cleanup, so nothing tree-kills the
//      backend.
// The backend then reparents to launchd/init (PPID 1) and lives forever. On the
// owner's Mac a day of daemon crashes left ~375 orphaned `opencode serve` (~5 GB).
//
// Unlike the pty-host (which is detached ON PURPOSE so live terminals SURVIVE a
// daemon restart — internal docs), agent backends have NO persistence contract:
// when the daemon that owns the agent session dies, the backend is dead weight and
// MUST be reaped. So this reaper is carefully scoped to agent backends and NEVER
// touches the pty-host.
//
// Cyborg-owned (this file lives in cyborg/, hooked from the EXTENDED bootstrap
// stop/start paths). It does not modify Paseo's agent/ engine.

import type { Logger } from "pino";

import { execCommand } from "../../utils/spawn.js";
import { terminateWithTreeKill } from "../../utils/tree-kill.js";
import type { AuditSink } from "./audit-sink.js";

// #995: optional re-route of a reaper kill onto the Logs-tab audit stream. The
// reaper is daemon-global, so the caller (bootstrap) supplies the workspaceId the
// event is scoped to. Omitting it keeps the reaper byte-identical (pino-only).
export interface ReaperAuditContext {
  sink: AuditSink;
  workspaceId: string;
  daemonId?: string | null;
}

function emitReaperKill(
  audit: ReaperAuditContext | undefined,
  kind: string,
  victims: number[],
): void {
  if (!audit || victims.length === 0) return;
  audit.sink.emit({
    kind,
    category: "daemon_operation",
    level: "warn",
    workspaceId: audit.workspaceId,
    daemonId: audit.daemonId ?? null,
    source: "reaper",
    message: `Reaped ${victims.length} agent-backend process(es)`,
    payload: { count: victims.length, pids: victims },
  });
}

const GRACEFUL_TIMEOUT_MS = 2_000;
const FORCE_TIMEOUT_MS = 1_000;

// A backend is identified by BOTH a binary token AND a subcommand token in its
// command line — the pair is specific enough that we will not match an unrelated
// user process (a bare `opencode` TUI, or an editor that merely has "codex" in a
// path). Matching is substring on the lower-cased command, order-independent.
interface AgentBackendMarker {
  /** Human-readable id for logs/tests. */
  readonly id: string;
  /** Tokens that must ALL appear in the command line (case-insensitive). */
  readonly tokens: readonly string[];
}

export const AGENT_BACKEND_MARKERS: readonly AgentBackendMarker[] = [
  // `opencode serve --port N` — the OpenCode server manager's shared backend.
  { id: "opencode-serve", tokens: ["opencode", "serve"] },
  // `codex app-server` — the Codex app-server provider's backend.
  { id: "codex-app-server", tokens: ["codex", "app-server"] },
];

// The pty-host process is detached ON PURPOSE and MUST survive daemon death. Any
// command line containing this token is excluded from the kill set, no matter what
// else it matches. This is the single most important safety invariant of the
// reaper, asserted directly in the unit tests.
export const PTY_HOST_EXCLUDE_TOKEN = "pty-host-process";

export interface ProcessEntry {
  pid: number;
  ppid: number;
  command: string;
}

function isPtyHost(command: string): boolean {
  return command.toLowerCase().includes(PTY_HOST_EXCLUDE_TOKEN);
}

export function matchAgentBackendMarker(command: string): AgentBackendMarker | null {
  if (isPtyHost(command)) {
    return null;
  }
  const lower = command.toLowerCase();
  for (const marker of AGENT_BACKEND_MARKERS) {
    if (marker.tokens.every((token) => lower.includes(token))) {
      return marker;
    }
  }
  return null;
}

/**
 * Pick the ORPHANED agent-backend processes from a process snapshot. An orphan is
 * a backend whose parent is gone (reparented to init/launchd, PPID 1). We only
 * reap orphans at start time: a backend with a live, non-init parent may belong to
 * another running daemon on the same machine, so we must not touch it.
 *
 * The pty-host is NEVER returned (matchAgentBackendMarker excludes it), even if it
 * somehow shows PPID 1 — its survival is the whole point of pty-host persistence.
 */
export function identifyOrphanedAgentBackends(processes: readonly ProcessEntry[]): number[] {
  const victims: number[] = [];
  for (const entry of processes) {
    if (entry.ppid !== 1) {
      continue;
    }
    if (entry.pid <= 1) {
      continue;
    }
    if (matchAgentBackendMarker(entry.command)) {
      victims.push(entry.pid);
    }
  }
  return victims;
}

/**
 * Pick the agent-backend processes that descend (directly or transitively) from a
 * given root pid — used at shutdown to kill THIS daemon's own backends before the
 * daemon exits, so they never get the chance to orphan. The pty-host is excluded
 * even though it descends from the daemon, so terminal persistence is preserved.
 */
export function identifyDescendantAgentBackends(
  processes: readonly ProcessEntry[],
  rootPid: number,
): number[] {
  const childrenByParent = new Map<number, ProcessEntry[]>();
  for (const entry of processes) {
    const siblings = childrenByParent.get(entry.ppid);
    if (siblings) {
      siblings.push(entry);
    } else {
      childrenByParent.set(entry.ppid, [entry]);
    }
  }

  const victims: number[] = [];
  const seen = new Set<number>();
  const stack: number[] = [rootPid];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const child of childrenByParent.get(current) ?? []) {
      if (child.pid <= 1 || seen.has(child.pid)) {
        continue;
      }
      // Do NOT descend INTO the pty-host subtree, and never kill it: its child
      // ptys must survive too. matchAgentBackendMarker already excludes the host
      // itself; skipping the descent keeps any helper it spawned alive as well.
      if (isPtyHost(child.command)) {
        continue;
      }
      stack.push(child.pid);
      if (matchAgentBackendMarker(child.command)) {
        victims.push(child.pid);
      }
    }
  }
  return victims;
}

// Snapshot every process as {pid, ppid, command}. POSIX-only (`ps -axo ...`);
// Windows agent backends are reaped by the desktop's `taskkill /T` tree kill and
// the providers' own exit handlers, so we no-op there.
export async function snapshotProcesses(
  exec: typeof execCommand = execCommand,
): Promise<ProcessEntry[]> {
  if (process.platform === "win32") {
    return [];
  }
  // `ps -axww -o pid=,ppid=,command=` — `-ww` disables column truncation so the
  // full command line (with `serve`/`app-server` and `--port N`) is visible for
  // marker matching. Empty headers (`=`) keep the output value-only.
  const { stdout } = await exec("ps", ["-axww", "-o", "pid=,ppid=,command="], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 10_000,
  });
  return parsePsOutput(stdout);
}

export function parsePsOutput(stdout: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const command = match[3];
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || command.length === 0) {
      continue;
    }
    entries.push({ pid, ppid, command });
  }
  return entries;
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
        logger.warn({ pid }, "Agent backend did not exit after SIGTERM; sending SIGKILL");
      },
    });
  } catch (err) {
    logger.warn({ err, pid }, "Failed to tree-kill agent backend");
  }
}

/**
 * On daemon START: find agent-backend processes that orphaned from a prior daemon
 * death (PPID 1) and tree-kill them, so a fresh daemon does not sit on top of
 * yesterday's zombies. Conservative: only PPID-1 backends matching a known marker,
 * never the pty-host. No-op on Windows.
 */
export async function reapOrphanedAgentBackends(
  logger: Logger,
  deps?: {
    snapshot?: () => Promise<ProcessEntry[]>;
    kill?: (pid: number) => Promise<void>;
    audit?: ReaperAuditContext;
  },
): Promise<number[]> {
  if (process.platform === "win32") {
    return [];
  }
  const snapshot = deps?.snapshot ?? (() => snapshotProcesses());
  const kill = deps?.kill ?? ((pid: number) => killPid(pid, logger));

  let processes: ProcessEntry[];
  try {
    processes = await snapshot();
  } catch (err) {
    logger.warn({ err }, "Could not snapshot processes to reap orphaned agent backends");
    return [];
  }

  const victims = identifyOrphanedAgentBackends(processes);
  if (victims.length === 0) {
    return [];
  }
  logger.warn(
    { count: victims.length, pids: victims },
    "Reaping orphaned agent-backend processes left by a prior daemon death",
  );
  emitReaperKill(deps?.audit, "reaper.orphaned_backends", victims);
  await Promise.all(victims.map((pid) => kill(pid)));
  return victims;
}

/**
 * On daemon SHUTDOWN: tree-kill THIS daemon's own agent-backend descendants before
 * the process exits, so a hard death cannot orphan them. The pty-host (and its pty
 * children) are excluded so terminal persistence holds. No-op on Windows.
 */
export async function killOwnAgentBackends(
  logger: Logger,
  deps?: {
    rootPid?: number;
    snapshot?: () => Promise<ProcessEntry[]>;
    kill?: (pid: number) => Promise<void>;
    audit?: ReaperAuditContext;
  },
): Promise<number[]> {
  if (process.platform === "win32") {
    return [];
  }
  const rootPid = deps?.rootPid ?? process.pid;
  const snapshot = deps?.snapshot ?? (() => snapshotProcesses());
  const kill = deps?.kill ?? ((pid: number) => killPid(pid, logger));

  let processes: ProcessEntry[];
  try {
    processes = await snapshot();
  } catch (err) {
    logger.warn({ err }, "Could not snapshot processes to kill own agent backends");
    return [];
  }

  const victims = identifyDescendantAgentBackends(processes, rootPid);
  if (victims.length === 0) {
    return [];
  }
  logger.info(
    { count: victims.length, pids: victims, rootPid },
    "Terminating daemon-owned agent-backend processes on shutdown",
  );
  emitReaperKill(deps?.audit, "reaper.own_backends", victims);
  await Promise.all(victims.map((pid) => kill(pid)));
  return victims;
}
