import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import log from "electron-log/main";

const RESOLVE_TIMEOUT_MS = 10_000;

function getSystemShell(): string {
  const shell = process.env.SHELL;
  if (shell) return shell;

  try {
    const info = userInfo();
    if (info.shell && info.shell !== "/bin/false") return info.shell;
  } catch {
    // intentional: fail open to the platform default shell below.
  }

  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

interface ShellInvocation {
  shell: string;
  shellArgs: string[];
  command: string;
  regex: RegExp;
  env: NodeJS.ProcessEnv;
}

// Build the shell command that prints the login env as marker-delimited JSON.
// Shared by the sync (first-launch) and async (background-refresh) resolvers.
function buildShellInvocation(): ShellInvocation {
  const mark = randomUUID().replace(/-/g, "").slice(0, 12);
  const regex = new RegExp(mark + "({.*})" + mark);
  const shell = getSystemShell();
  const name = basename(shell);

  let command: string;
  let shellArgs: string[];
  if (/^(?:pwsh|powershell)(?:-preview)?$/.test(name)) {
    command = `& '${process.execPath}' -p '''${mark}'' + JSON.stringify(process.env) + ''${mark}'''`;
    shellArgs = ["-Login", "-Command"];
  } else if (name === "nu") {
    command = `^'${process.execPath}' -p '"${mark}" + JSON.stringify(process.env) + "${mark}"'`;
    shellArgs = ["-i", "-l", "-c"];
  } else if (name === "xonsh") {
    command = `import os, json; print("${mark}", json.dumps(dict(os.environ)), "${mark}")`;
    shellArgs = ["-i", "-l", "-c"];
  } else {
    command = `'${process.execPath}' -p '"${mark}" + JSON.stringify(process.env) + "${mark}"'`;
    shellArgs = name === "tcsh" || name === "csh" ? ["-ic"] : ["-i", "-l", "-c"];
  }

  const shellEnv = { ...process.env };
  delete shellEnv.PASEO_NODE_ENV;
  delete shellEnv.PASEO_DESKTOP_MANAGED;
  delete shellEnv.PASEO_SUPERVISED;

  return {
    shell,
    shellArgs,
    command,
    regex,
    env: { ...shellEnv, ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1" },
  };
}

// Operational daemon toggles that must NEVER be inherited from the user's login
// shell. The capture exists to portage the user's INTERACTIVE environment (PATH,
// locale, tool config) so the daemon finds binaries and behaves like the user's
// terminal — NOT to let a stray shell/launchctl value override a daemon runtime
// default. These are daemon-owned knobs (each has an in-code default); a cached
// value here SHADOWS that default on every launch and survives reboot, because
// this file persists to ~/.cyborg7/login-shell-env.json and re-injects it.
//
// THE INCIDENT this guards against: a one-off `launchctl setenv CYBORG7_PTY_HOST 0`
// (a debug probe) got captured here and re-injected into the daemon on EVERY
// launch — silently forcing the inherited in-process terminal manager instead of
// the detached PtyHost, so live terminals died on every daemon restart. It
// survived reboot, launchd unset, and a cold relaunch because the value lived in
// THIS cache, not in launchd/.env/the bundle. Stripping the operational toggles
// here makes the cache structurally unable to brick the daemon's terminal
// lifecycle — for us AND for any user who ever exports one of these.
//
// NOTE: config a user/deployer may legitimately set in their shell (secrets, URLs,
// allowlists — CYBORG7_JWT_SECRET, CYBORG7_DEV_URL, *_ALLOWLIST, …) is deliberately
// NOT stripped; only behavioral toggles with daemon-side defaults are.
const NON_INHERITABLE_DAEMON_ENV = [
  "CYBORG7_PTY_HOST",
  "CYBORG7_PERSIST_TERMINALS",
  "CYBORG7_PTY_HOST_SOCKET",
] as const;

// Parse the marker-delimited JSON, then restore the Electron vars we set for the
// probe, drop XDG_RUNTIME_DIR (per-session, not portable to the daemon), and strip
// the operational daemon toggles that must not leak in from the login shell.
// Exported for tests (the strip behavior is the #pty-host-persistence guard).
export function parseShellEnv(stdout: string, regex: RegExp): Record<string, string> | undefined {
  const match = regex.exec(stdout);
  if (!match?.[1]) return undefined;
  try {
    const env = JSON.parse(match[1]) as Record<string, string>;
    const savedRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
    const savedNoAttach = process.env.ELECTRON_NO_ATTACH_CONSOLE;
    if (savedRunAsNode) env.ELECTRON_RUN_AS_NODE = savedRunAsNode;
    else delete env.ELECTRON_RUN_AS_NODE;
    if (savedNoAttach) env.ELECTRON_NO_ATTACH_CONSOLE = savedNoAttach;
    else delete env.ELECTRON_NO_ATTACH_CONSOLE;
    delete env.XDG_RUNTIME_DIR;
    for (const key of NON_INHERITABLE_DAEMON_ENV) delete env[key];
    return env;
  } catch {
    return undefined;
  }
}

// Synchronous resolve — used ONLY on the first launch (no cache yet), so the
// one-time cost is paid once instead of blocking every launch.
function resolveShellEnv(): Record<string, string> | undefined {
  if (process.platform === "win32") return undefined;
  const inv = buildShellInvocation();
  const result = spawnSync(inv.shell, [...inv.shellArgs, inv.command], {
    encoding: "utf8",
    timeout: RESOLVE_TIMEOUT_MS,
    windowsHide: true,
    env: inv.env,
  });
  if (result.status !== 0 && result.status !== null) return undefined;
  if (!result.stdout) return undefined;
  return parseShellEnv(result.stdout, inv.regex);
}

// Async resolve — used for the background refresh so a slow shell rc never
// blocks the Electron main process.
function resolveShellEnvAsync(): Promise<Record<string, string> | undefined> {
  if (process.platform === "win32") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const inv = buildShellInvocation();
    let stdout = "";
    let settled = false;
    const done = (v: Record<string, string> | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    try {
      const child = spawn(inv.shell, [...inv.shellArgs, inv.command], {
        // Only capture stdout. A login rc that floods stderr would otherwise
        // fill the unread stderr pipe (~64KB) and hang the child until timeout.
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        env: inv.env,
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done(undefined);
      }, RESOLVE_TIMEOUT_MS);
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.on("error", () => {
        clearTimeout(timer);
        done(undefined);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done(code === 0 || code === null ? parseShellEnv(stdout, inv.regex) : undefined);
      });
    } catch {
      done(undefined);
    }
  });
}

function cacheFilePath(): string {
  return join(homedir(), ".cyborg7", "login-shell-env.json");
}

function readCachedEnv(): Record<string, string> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cacheFilePath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    // Defensive: a corrupt/tampered cache must not inject non-string values into
    // process.env. Keep only string-valued keys. ALSO strip the operational daemon
    // toggles here (not just on fresh capture) so an ALREADY-poisoned cache on disk
    // self-heals on the very next launch, without waiting for a successful
    // background refresh to overwrite it (the incident cache survived reboot).
    const stripped = new Set<string>(NON_INHERITABLE_DAEMON_ENV);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && !stripped.has(key)) env[key] = value;
    }
    return Object.keys(env).length > 0 ? env : undefined;
  } catch (err) {
    // A missing cache file is normal on first launch; ignore ENOENT. Anything
    // else (corrupt JSON, permission error) is worth a breadcrumb.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log.warn("[login-shell-env] failed to read cached env", err);
    }
  }
  return undefined;
}

function writeCachedEnv(env: Record<string, string>): void {
  try {
    mkdirSync(dirname(cacheFilePath()), { recursive: true });
    writeFileSync(cacheFilePath(), JSON.stringify(env), { mode: 0o600 });
  } catch (err) {
    // A failed write silently degrades PATH resolution on the next launch (every
    // start pays the synchronous shell resolve instead of using the cache), so
    // surface it. log.error bridges to Logfire via main.ts.
    log.error("[login-shell-env] failed to write cached env", err);
  }
}

// Apply the login shell's environment so spawned daemons inherit the user's real
// PATH etc. To avoid blocking app launch for up to RESOLVE_TIMEOUT_MS on EVERY
// start (issue #186), the resolved env is cached: a cached value is applied
// instantly and refreshed in the background for next time; only the first-ever
// launch pays the synchronous resolve.
export function inheritLoginShellEnv(): void {
  const cached = readCachedEnv();
  if (cached) {
    Object.assign(process.env, cached);
    // Refresh the cache for the next launch without blocking this one.
    void (async () => {
      try {
        const env = await resolveShellEnvAsync();
        if (env) writeCachedEnv(env);
      } catch {
        // Best-effort refresh; the applied cache stands.
      }
    })();
    return;
  }
  try {
    const env = resolveShellEnv();
    if (env) {
      Object.assign(process.env, env);
      writeCachedEnv(env);
    }
  } catch {
    // Keep inherited environment if shell lookup fails.
  }
}
