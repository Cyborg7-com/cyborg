// Remote daemon self-update (#663) — the daemon-side launcher for #662's
// `cyborg daemon update` (atomic verify-and-rollback).
//
// THE restart problem: `cyborg daemon update` STOPS and RESTARTS this very
// daemon. If we ran it as a CHILD of the daemon and awaited it, the update would
// kill its own parent mid-await (the WS is already gone). So the update MUST be
// launched DETACHED (its own process group, stdio ignored, unref'd) so it
// outlives the daemon it's restarting — and the handler returns
// "accepted/restarting" immediately rather than awaiting a result on a socket
// that's about to drop. The new version surfaces via the next heartbeat.

import { spawn, spawnSync } from "node:child_process";

export const DAEMON_UPDATE_COMMAND = "cyborg daemon update";

export interface DaemonSelfUpdateResult {
  ok: boolean;
  // True once the detached self-update launched and the daemon is restarting.
  restarting?: boolean;
  error?: string;
  // Manual fallback command when the self-update couldn't even launch (e.g. the
  // `cyborg` binary isn't on the daemon host's PATH).
  command?: string;
}

export interface DaemonSelfUpdateDeps {
  // Resolve the `cyborg` CLI binary on the daemon host (null = not found).
  resolveCyborgBin: () => string | null;
  // Launch the self-update DETACHED so it survives the daemon restart.
  launchDetached: (bin: string) => void;
}

export function runDaemonSelfUpdate(deps: DaemonSelfUpdateDeps): DaemonSelfUpdateResult {
  let bin: string | null;
  try {
    bin = deps.resolveCyborgBin();
  } catch {
    bin = null;
  }
  if (!bin) {
    return {
      ok: false,
      error: "Couldn't find the `cyborg` CLI on this daemon's host to self-update.",
      command: DAEMON_UPDATE_COMMAND,
    };
  }
  try {
    deps.launchDetached(bin);
    return { ok: true, restarting: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      command: DAEMON_UPDATE_COMMAND,
    };
  }
}

// ── Real default deps ───────────────────────────────────────────────────────

function defaultResolveCyborgBin(): string | null {
  // `cyborg` should be on PATH (the daemon was started through it). Resolve it
  // synchronously so we can fail fast with the manual-command fallback when it
  // isn't, instead of a detached spawn silently ENOENT-ing into the void.
  const which = process.platform === "win32" ? "where" : "which";
  try {
    const r = spawnSync(which, ["cyborg"], { encoding: "utf-8", timeout: 4000 });
    if (r.status === 0) {
      const first = (r.stdout ?? "").split(/\r?\n/).find((l) => l.trim().length > 0);
      if (first) return first.trim();
    }
  } catch {
    // fall through
  }
  return null;
}

function defaultLaunchDetached(bin: string): void {
  const child = spawn(bin, ["daemon", "update"], {
    detached: true,
    stdio: "ignore",
    // Resolve the .cmd shim on Windows.
    shell: process.platform === "win32",
  });
  // A late ENOENT (binary vanished between resolve and spawn) lands here, not as
  // a throw — swallow it; resolveCyborgBin already gated the common case.
  child.on("error", () => undefined);
  child.unref();
}

export const defaultDaemonSelfUpdateDeps: DaemonSelfUpdateDeps = {
  resolveCyborgBin: defaultResolveCyborgBin,
  launchDetached: defaultLaunchDetached,
};

// `npm view @getpaseo/cli@latest version` — the daemon CLI package #662 ships.
// Read-only; powers the "update available" verdict and the outdated aggregate.
export async function latestDaemonVersion(
  exec: (cmd: string, args: string[]) => Promise<{ stdout: string }>,
): Promise<{ ok: boolean; latest: string | null; error: string | null }> {
  try {
    const { stdout } = await exec("npm", ["view", "@getpaseo/cli@latest", "version"]);
    const latest = stdout.trim() || null;
    return latest
      ? { ok: true, latest, error: null }
      : { ok: false, latest: null, error: "npm returned no version" };
  } catch (err) {
    return { ok: false, latest: null, error: err instanceof Error ? err.message : String(err) };
  }
}
