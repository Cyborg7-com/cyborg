// Augment the daemon's PATH at startup so a GUI-launched desktop app (Cyborg.app from
// the Dock/Finder, or Cyborg.exe from the Windows Start menu/desktop) can find
// user-installed CLIs — cybo, pi, npm.
//
// macOS/Linux: a process launched from the GUI inherits only the MINIMAL PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), which excludes /opt/homebrew/bin (Homebrew on
// Apple Silicon) and the npm global bin. So `cybo`/`pi`/`npm` are unreachable even
// when installed → detectPiCli reports "not installed", `npm i -g` fails, and a
// provider:"pi" cybo spawn (PI_COMMAND ?? "pi") ENOENTs. A daemon started from a
// terminal has the full PATH, which is why the bug is GUI-only.
//
// Windows: a GUI-launched Electron daemon inherits the PATH from explorer.exe, which
// often does NOT include the per-user package-manager global-bin dirs (`%APPDATA%\npm`
// for npm, `%LOCALAPPDATA%\pnpm` / `%PNPM_HOME%` for pnpm). A user who ran
// `npm i -g @cyborg7/cybo` or `pnpm add -g @cyborg7/cybo` then sees "Cybo runtime not
// found" even though the shims exist on disk. Same class of bug, different dirs.
//
// Fix: once at boot, merge the user's real PATH sources + well-known package-manager
// bin dirs into process.env.PATH. Idempotent (already-present dirs are not re-added; a
// terminal-launched daemon is unchanged) and best-effort (a failed probe just falls
// back to the well-known dirs).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "pino";

const execFileAsync = promisify(execFile);

// Sentinel so we can pick our PATH line out of any rc-file banner noise the
// interactive login shell may print before it.
const PATH_SENTINEL = "__CYBORG7_DAEMON_PATH__";

// PATH entries are joined with ";" on Windows and ":" everywhere else. We derive this
// from the (injectable) platform instead of importing node:path's `delimiter`, which
// reflects the HOST platform — so a "win32" test on a posix CI box still gets ";".
function pathDelimiterFor(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

// Bin dirs where Homebrew / MacPorts / npm-global / common toolchains install user
// CLIs. Merged as a fallback IN ADDITION to the login-shell PATH so detection works
// even if the shell probe fails or the user's rc files don't export these.
function wellKnownBinDirs(home: string): string[] {
  return [
    "/opt/homebrew/bin", // Homebrew (Apple Silicon) — cybo/pi/npm live here
    "/opt/homebrew/sbin",
    "/usr/local/bin", // Homebrew (Intel) / common
    "/usr/local/sbin",
    "/opt/local/bin", // MacPorts
    `${home}/.npm-global/bin`, // common `npm config set prefix` location
    `${home}/.local/bin`,
  ];
}

// Per-user package-manager global-bin dirs on Windows, where `npm i -g` / `pnpm add -g`
// drop the `cybo`/`pi` shims. Unlike the macOS dirs (which are stable absolute paths we
// add unconditionally), these are env-derived and may point nowhere, so the caller
// existence-checks each one before adding it. Env is injectable for tests.
function wellKnownWindowsBinDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = [];

  // pnpm global bin: PNPM_HOME if the user set it, else the default %LOCALAPPDATA%\pnpm.
  // Only build the default when LOCALAPPDATA is set — `join("", "pnpm")` would yield the
  // RELATIVE "pnpm", which (existence-checked against the daemon's cwd) is a search-path
  // hijack risk. A missing env var must yield "" (skipped), never a relative path.
  const pnpmHome = env.PNPM_HOME || (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "pnpm") : "");
  if (pnpmHome) dirs.push(pnpmHome);

  // npm global (Windows default): %APPDATA%\npm — the bin shims live directly here. Same
  // rule: only construct it when APPDATA is set, so an unset env var never leaks the
  // relative "npm" into PATH.
  const npmGlobal = env.APPDATA ? join(env.APPDATA, "npm") : "";
  if (npmGlobal) dirs.push(npmGlobal);

  return dirs;
}

// Capture the user's login-shell PATH (where their package manager appended its bin
// dirs in .zshrc/.zprofile/etc.). GUI apps never run the login shell, so we do it
// once. `-lic` = login + interactive + command, so rc files that set PATH are sourced.
async function defaultLoginShellPath(logger: Logger): Promise<string[]> {
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const { stdout } = await execFileAsync(shell, ["-lic", `echo "${PATH_SENTINEL}:$PATH"`], {
      timeout: 3000,
    });
    const line = stdout.split("\n").find((l) => l.startsWith(`${PATH_SENTINEL}:`));
    if (!line) return [];
    return line
      .slice(PATH_SENTINEL.length + 1)
      .trim()
      .split(":")
      .filter(Boolean);
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), shell },
      "augment-path: login-shell PATH probe failed; using well-known dirs only",
    );
    return [];
  }
}

// Best-effort `npm config get prefix` on Windows — the npm global prefix dir holds the
// bin shims directly (no `bin` subdir like posix). `npm` is `npm.cmd`, so we spawn via
// the shell. Any failure (no npm on PATH, timeout, junk output) just yields null; this
// must never throw. Returns null on non-existent / empty output.
async function defaultNpmPrefixDir(logger: Logger): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("npm", ["config", "get", "prefix"], {
      timeout: 3000,
      shell: true, // npm is npm.cmd on Windows
    });
    const prefix = stdout.trim();
    return prefix && prefix !== "undefined" ? prefix : null;
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "augment-path: npm prefix probe failed; skipping npm-prefix dir",
    );
    return null;
  }
}

export interface AugmentDaemonPathOptions {
  // Injectable for tests. Defaults to probing the real login shell (macOS/Linux only).
  probeLoginShellPath?: (logger: Logger) => Promise<string[]>;
  // Injectable for tests. Defaults to spawning `npm config get prefix` (Windows only).
  // Return null to skip the npm-prefix dir (tests pass this to avoid a real spawn).
  probeNpmPrefix?: (logger: Logger) => Promise<string | null>;
  // Injectable for tests. Defaults to checking the real filesystem. Used to decide
  // which env-derived Windows bin dirs actually exist before adding them.
  dirExists?: (dir: string) => boolean;
  platform?: NodeJS.Platform; // defaults to process.platform
  homeDir?: string; // defaults to os.homedir()
  env?: NodeJS.ProcessEnv; // defaults to process.env (for the Windows bin dirs)
}

export interface AugmentDaemonPathResult {
  changed: boolean;
  added: string[];
  path: string;
}

// Gather the candidate bin dirs to merge into PATH for the current platform. macOS/Linux
// adds the login-shell PATH + stable well-known dirs (no existence check, by design).
// Windows adds the env-derived package-manager dirs + the npm prefix, each existence-
// checked because those paths may point nowhere.
async function gatherCandidateDirs(
  logger: Logger,
  options: AugmentDaemonPathOptions,
): Promise<string[]> {
  const platform = options.platform ?? process.platform;

  if (platform === "win32") {
    const env = options.env ?? process.env;
    const dirExists = options.dirExists ?? existsSync;
    const probeNpmPrefix = options.probeNpmPrefix ?? defaultNpmPrefixDir;

    const npmPrefix = await probeNpmPrefix(logger);
    const candidates = [...wellKnownWindowsBinDirs(env)];
    if (npmPrefix) candidates.push(npmPrefix);

    // Only add dirs that are non-empty AND exist on disk — an env var pointing at a
    // missing path must never poison PATH.
    return candidates.filter((dir) => dir.length > 0 && dirExists(dir));
  }

  const home = options.homeDir ?? homedir();
  const probe = options.probeLoginShellPath ?? defaultLoginShellPath;
  return [...(await probe(logger)), ...wellKnownBinDirs(home)];
}

// Merge well-known + probed bin dirs into process.env.PATH (new dirs prepended so a
// freshly-installed cybo/pi wins). Returns what changed (for logging/tests).
export async function augmentDaemonPath(
  logger: Logger,
  options: AugmentDaemonPathOptions = {},
): Promise<AugmentDaemonPathResult> {
  const platform = options.platform ?? process.platform;
  const delim = pathDelimiterFor(platform);

  const current = (process.env.PATH ?? "").split(delim).filter(Boolean);
  const seen = new Set(current);

  const candidates = await gatherCandidateDirs(logger, options);
  const added: string[] = [];
  for (const dir of candidates) {
    if (!seen.has(dir)) {
      seen.add(dir);
      added.push(dir);
    }
  }

  if (added.length === 0) {
    logger.info(
      { pathDirCount: current.length },
      "augment-path: PATH already includes all known CLI dirs; no change",
    );
    return { changed: false, added: [], path: process.env.PATH ?? "" };
  }

  const next = [...added, ...current].join(delim);
  process.env.PATH = next;
  logger.info(
    { added },
    platform === "win32"
      ? "augment-path: augmented daemon PATH for GUI launch (Windows npm/pnpm globals)"
      : "augment-path: augmented daemon PATH for GUI launch (Homebrew/npm-global)",
  );
  return { changed: true, added, path: next };
}
