// Windows-only: reap ORPHANED detached pty-host processes on app START (FIX D).
//
// WHY THIS EXISTS — "Failed to uninstall old application files .: 2"
// Terminal persistence spawns a long-lived, session-detached pty-host as a SECOND
// `Cyborg.exe` (server/cyborg/pty-host-launcher.ts spawnHostDetached uses
// process.execPath, which is Cyborg.exe on a packaged Windows build). The host
// loads node-pty's asarUnpack'd native binaries (`…/node-pty/build/Release/*.node`
// + the ConPTY helpers conpty.dll / OpenConsole.exe) from INSIDE the install dir
// and holds OS file handles on them. If a previous run crashed and left a STRAY
// host running — one whose owning daemon/app is gone and that the current daemon
// will NOT reconnect to — that stray host keeps those install-dir files locked. At
// the next auto-update the NSIS uninstaller can't delete them and fails with code 2.
//
// The existing reapers don't cover this on Windows:
//   • daemon-manager.ts reapOrphanedWorker → POSIX-only (process groups).
//   • server/cyborg/pty-host-reaper.ts reapOrphanPtyHosts → no-op on win32 (it is
//     PPID-1 / `ps`-oriented for Linux/macOS).
// So a crash-orphaned host lingers until the failed update surfaces it. FIX D
// closes that gap: on app startup (Windows), proactively detect + kill any stray
// detached pty-host that is NOT the active, in-use host, so an orphan from a prior
// run is cleared well before any future update.
//
// THE LOAD-BEARING SAFETY INVARIANT (same as the Linux reaper): a host that is
// SERVING LIVE PTYS must NEVER be reaped — terminal persistence depends on the next
// daemon reconnecting to a surviving host. We honor that two ways:
//   1. We NEVER touch the ACTIVE host — the one bound to the current
//      $PASEO_HOME/pty-host.sock, whose pid we learn over the socket hello
//      (readActiveHostPid). That is the live, in-use host by definition.
//   2. Of the REMAINING pty-hosts, we reap ONLY the CHILDLESS ones. A pty's shell
//      is a CHILD of its host (node-pty spawns it), so a host with any child is
//      presumed to be serving a live pty and is SPARED; a childless host has zero
//      live ptys and is safe to reap.
// Conservative by construction: when in doubt (no snapshot, unknown active pid, a
// host with children) we do NOTHING.
//
// PID-TARGETED, IMAGE-SCOPED: like pty-host-shutdown.ts this module inlines its
// process enumeration rather than importing the server package (the desktop bundle
// stays server-free). It never runs a blanket `taskkill /IM Cyborg.exe` (that would
// kill the running app + the active host); every kill is a PID-targeted
// `taskkill /pid <pid> /t /f` against a confirmed orphan.

import { spawn } from "node:child_process";
import log from "electron-log/main";
import { readActiveHostPid } from "./pty-host-shutdown.js";

// The pty-host is identified by the host entry module name in its command line —
// the SAME token the server's agent-backend reaper uses to EXCLUDE the host from
// its kill set (PTY_HOST_EXCLUDE_TOKEN). On a packaged Windows build the host runs
// `Cyborg.exe …\pty-host-process.js`, so this substring is present. Lower-cased
// match so casing in the path can't dodge it.
const PTY_HOST_COMMAND_TOKEN = "pty-host-process";

// Budget for the WMI/CIM process snapshot. Startup must not stall on it.
const SNAPSHOT_TIMEOUT_MS = 5000;
const TASKKILL_TIMEOUT_MS = 1500;

// One process as seen by the snapshot: pid, parent pid, and full command line.
export interface WindowsProcessEntry {
  pid: number;
  ppid: number;
  command: string;
}

export interface IdentifyOrphanPtyHostsInput {
  readonly processes: readonly WindowsProcessEntry[];
  // The pid of the ACTIVE host (bound to the current socket), learned over the
  // hello handshake. NEVER a reap candidate. undefined when no host answered the
  // socket — then there is no in-use host to protect, but the childless guard still
  // applies so a host serving ptys (with children) is spared regardless.
  readonly activeHostPid?: number;
}

function isPtyHostCommand(command: string): boolean {
  return command.toLowerCase().includes(PTY_HOST_COMMAND_TOKEN);
}

/**
 * Pick the ORPHANED, EMPTY pty-host processes from a Windows process snapshot. A
 * reap candidate must be ALL of:
 *   • a pty-host process (command contains the host entry token), and
 *   • NOT the active host (activeHostPid), and
 *   • childless — zero child processes ⇒ zero live ptys (node-pty shells are
 *     children of the host). ANY child ⇒ presumed serving a live pty ⇒ SPARED.
 *
 * Mirrors server/cyborg/pty-host-reaper.ts identifyOrphanPtyHosts, minus the POSIX
 * PPID-1 test (Windows does not reparent a detached child to pid 1; the active-host
 * + childless guards are what make a reap safe here). Pure + exported for unit tests.
 */
export function identifyOrphanPtyHosts(input: IdentifyOrphanPtyHostsInput): number[] {
  const { processes, activeHostPid } = input;
  // Which pids have at least one child? Those hosts are serving live ptys.
  const hasChild = new Set<number>();
  for (const entry of processes) {
    hasChild.add(entry.ppid);
  }

  const victims: number[] = [];
  for (const entry of processes) {
    if (entry.pid <= 0) continue;
    if (activeHostPid !== undefined && entry.pid === activeHostPid) continue;
    if (!isPtyHostCommand(entry.command)) continue;
    // The single most important guard: a host with ANY child process is presumed
    // to be serving a live pty — NEVER reap it (terminal persistence).
    if (hasChild.has(entry.pid)) continue;
    victims.push(entry.pid);
  }
  return victims;
}

// Snapshot every process as {pid, ppid, command} via PowerShell + CIM. We use
// Get-CimInstance Win32_Process (NOT the deprecated/removed `wmic`, which is gone on
// recent Windows 11 builds) and emit one tab-separated row per process so a path
// with spaces in the CommandLine never breaks parsing of pid/ppid. Returns [] on any
// failure / timeout — the reaper then no-ops, which is the safe default.
function snapshotWindowsProcesses(): Promise<WindowsProcessEntry[]> {
  return new Promise((resolve) => {
    // CommandLine can be $null for some system processes — coalesce to "" so the
    // row always has 3 tab-separated fields. ProcessId/ParentProcessId are ints.
    const script =
      "Get-CimInstance Win32_Process | ForEach-Object { " +
      '"$($_.ProcessId)`t$($_.ParentProcessId)`t$([string]$_.CommandLine)" }';
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
    });
    let out = "";
    let settled = false;
    const settle = (value: WindowsProcessEntry[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // already gone
      }
      resolve(value);
    };
    const timer = setTimeout(() => settle([]), SNAPSHOT_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", () => settle([]));
    child.on("close", () => settle(parseCimProcessOutput(out)));
  });
}

// Parse the tab-separated `pid\tppid\tcommand` rows the CIM snapshot emits. Tolerant
// of blank lines and rows missing a command. Exported for unit tests.
export function parseCimProcessOutput(stdout: string): WindowsProcessEntry[] {
  const entries: WindowsProcessEntry[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    // Only drop genuinely blank lines — do NOT trim the line as a whole, or a
    // trailing tab that delimits an EMPTY command field (`pid\tppid\t`) would be
    // eaten and the row mis-parsed as having two fields. The command field is taken
    // verbatim from after the second tab.
    if (rawLine.trim().length === 0) continue;
    const line = rawLine.replace(/\r$/, "");
    // Split into exactly 3 fields so a CommandLine containing tabs stays intact.
    const firstTab = line.indexOf("\t");
    if (firstTab === -1) continue;
    const secondTab = line.indexOf("\t", firstTab + 1);
    if (secondTab === -1) continue;
    const pid = Number.parseInt(line.slice(0, firstTab), 10);
    const ppid = Number.parseInt(line.slice(firstTab + 1, secondTab), 10);
    const command = line.slice(secondTab + 1);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    entries.push({ pid, ppid, command });
  }
  return entries;
}

// PID-targeted force kill of a confirmed orphan host process TREE — the SAME
// primitive the daemon + the install-path host stop use (taskkill /pid <pid> /t /f).
// Best-effort: resolves on close OR error. Never throws.
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

// On app START (Windows): detect + kill any STRAY detached pty-host left by a prior
// run — one that is NOT the active host and is serving no live ptys — so a
// crash-orphaned host can't keep the unpacked node-pty binaries locked into a future
// auto-update (code 2). No-op on macOS/Linux (the server's POSIX reaper handles
// those, and the swap there is in-place-free). Never throws; best-effort. Returns
// the pids it killed (for logging/tests).
export async function reapOrphanPtyHostsOnStart(): Promise<number[]> {
  if (process.platform !== "win32") return [];
  try {
    // Learn the active host pid FIRST so it is excluded from the kill set even if a
    // snapshot race makes it look childless. null ⇒ no host bound to the current
    // socket; the childless guard still protects any host serving live ptys.
    const activeHostPid = (await readActiveHostPid()) ?? undefined;
    const processes = await snapshotWindowsProcesses();
    if (processes.length === 0) return [];

    const victims = identifyOrphanPtyHosts({ processes, activeHostPid });
    if (victims.length === 0) return [];

    log.warn("[pty-host] reaping orphan pty-host(s) on start (no live owner, zero ptys)", {
      pids: victims,
      activeHostPid: activeHostPid ?? null,
    });
    await Promise.all(victims.map((pid) => taskkillTree(pid)));
    return victims;
  } catch (err) {
    log.warn("[pty-host] orphan reap on start failed (continuing)", { err });
    return [];
  }
}
