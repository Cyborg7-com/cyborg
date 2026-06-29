// Running-daemon registry for multi-home commands (#665).
//
// stop/restart/status used to silently assume ~/.paseo, so running them against
// a daemon started in a custom --home stopped the WRONG (or an empty) daemon.
// Each started daemon records its home in a user-level registry; the commands
// read it to INFER the target home (or report ambiguity) instead of assuming.
//
// The registry is a hint, never the source of truth — every read prunes entries
// whose daemon isn't actually running (checked via the per-home pidfile), so a
// crash or `kill -9` can't leave a stale home steering a command.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function registryPath(env: NodeJS.ProcessEnv = process.env): string {
  // A fixed user-level location, independent of any single PASEO_HOME (those are
  // exactly what we're indexing). Overridable for tests.
  return env.CYBORG_DAEMON_REGISTRY ?? join(homedir(), ".cyborg", "daemons.json");
}

interface RegistryFile {
  homes: string[];
}

function read(path: string): RegistryFile {
  if (!existsSync(path)) return { homes: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    // Plain-object guard: typeof [] is also "object", so exclude arrays.
    if (
      raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      Array.isArray((raw as RegistryFile).homes)
    ) {
      const homes = (raw as RegistryFile).homes.filter((h): h is string => typeof h === "string");
      return { homes };
    }
  } catch {
    // Corrupt registry → treat as empty; the next write heals it.
  }
  return { homes: [] };
}

function write(path: string, file: RegistryFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // De-dupe and sort for a stable, readable file.
    const homes = Array.from(new Set(file.homes)).sort();
    writeFileSync(path, JSON.stringify({ homes }, null, 2), "utf8");
  } catch {
    // Best-effort — a registry write must never break start/stop.
  }
}

export function registerDaemonHome(home: string, env: NodeJS.ProcessEnv = process.env): void {
  const path = registryPath(env);
  const file = read(path);
  if (!file.homes.includes(home)) write(path, { homes: [...file.homes, home] });
}

export function unregisterDaemonHome(home: string, env: NodeJS.ProcessEnv = process.env): void {
  const path = registryPath(env);
  const file = read(path);
  if (file.homes.includes(home)) write(path, { homes: file.homes.filter((h) => h !== home) });
}

// All registered homes whose daemon is ACTUALLY running (dead entries pruned and
// removed from the file). `isRunning` is injected so the read/prune logic is
// testable without spawning daemons.
export function listRunningDaemonHomes(
  isRunning: (home: string) => boolean,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const path = registryPath(env);
  const file = read(path);
  const running: string[] = [];
  const stale: string[] = [];
  for (const home of file.homes) {
    if (isRunning(home)) running.push(home);
    else stale.push(home);
  }
  if (stale.length > 0) write(path, { homes: running });
  return running;
}

export interface TargetHomeResolution {
  // The home to operate on, or null when the caller must disambiguate.
  home: string | null;
  reason: "explicit" | "default-running" | "inferred" | "ambiguous" | "default-fallback";
  candidates: string[];
}

// Decide which home a no-/explicit-home command should act on. Pure — the caller
// passes the resolved facts.
//   - explicit --home always wins.
//   - else if the default home is running, use it (back-compat).
//   - else if exactly one OTHER daemon is running, infer it (the fix: don't act
//     on the empty default when the real daemon lives elsewhere).
//   - else if several are running, ambiguous → caller errors with the list.
//   - else nothing running → fall back to the default (commands then report
//     "not running at <default>" with a --home hint).
export function resolveTargetHome(input: {
  explicitHome?: string;
  defaultHome: string;
  runningHomes: string[];
}): TargetHomeResolution {
  const { explicitHome, defaultHome, runningHomes } = input;
  if (explicitHome) return { home: explicitHome, reason: "explicit", candidates: [] };
  if (runningHomes.includes(defaultHome)) {
    return { home: defaultHome, reason: "default-running", candidates: runningHomes };
  }
  const others = runningHomes.filter((h) => h !== defaultHome);
  if (others.length === 1) return { home: others[0], reason: "inferred", candidates: others };
  if (others.length > 1) return { home: null, reason: "ambiguous", candidates: others };
  return { home: defaultHome, reason: "default-fallback", candidates: [] };
}
