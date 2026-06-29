import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { runRestartCommand } from "./restart.js";
import { resolveLocalDaemonState, resolveTcpHostFromListen } from "./local-daemon.js";
import { tryConnectToDaemon } from "../../utils/client.js";
import { planAndRunUpdate, type RollbackPoint, type UpdateDeps } from "./daemon-update-plan.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

// CLI-first daemon updates: pull the latest daemon code (source checkout) or the
// latest published package (global install), then restart the local daemon onto
// it. The desktop app auto-restarts on a version mismatch; this is the headless
// equivalent for server/CLI daemons.

interface UpdateResult {
  action: "updated" | "up-to-date" | "rolled-back";
  mode: string;
  versionBefore: string;
  versionAfter: string;
  message: string;
}

const updateResultSchema: OutputSchema<UpdateResult> = {
  idField: "action",
  columns: [
    { header: "STATUS", field: "action", color: () => "green" },
    { header: "MODE", field: "mode" },
    { header: "FROM", field: "versionBefore" },
    { header: "TO", field: "versionAfter" },
    { header: "MESSAGE", field: "message" },
  ],
};

export type UpdateCommandResult = SingleResult<UpdateResult>;

function findRepoRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 15; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readCliVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        const pkg = JSON.parse(readFileSync(pj, "utf8")) as { name?: string; version?: string };
        if (pkg.name === "@getpaseo/cli" && typeof pkg.version === "string") return pkg.version;
      } catch {
        // keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "unknown";
}

function run(cmd: string, args: string[], cwd?: string): void {
  execFileSync(cmd, args, { stdio: "inherit", cwd });
}

function detectPackageManager(repoRoot: string): string {
  if (existsSync(join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoRoot, "yarn.lock"))) return "yarn";
  return "npm";
}

function hasBuildScript(repoRoot: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return typeof pkg.scripts?.build === "string";
  } catch {
    return false;
  }
}

export function npmViewLatest(): string | null {
  try {
    return execFileSync("npm", ["view", "@getpaseo/cli", "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null; // offline / not published — caller can't short-circuit, attempts the update
  }
}

function gitHead(repoRoot: string): string {
  return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Poll the freshly-restarted daemon until it is actually SERVING (or the
// timeout). A live pid alone isn't enough — a daemon that boots but fails to
// bind the WS is the exact failure rollback exists to catch — so for TCP
// listens we confirm the websocket answers, not just that the process is up.
// Unix-socket listens (no host) fall back to the pid check.
async function pollOnline(
  home: string | undefined,
  timeoutMs: number,
): Promise<{ online: boolean; version: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = resolveLocalDaemonState({ home });
    if (state.running && !state.stalePidFile) {
      const host = resolveTcpHostFromListen(state.listen);
      if (!host) return { online: true, version: null }; // unix socket — pid is all we can check
      const client = await tryConnectToDaemon({ host, timeout: 1500 });
      if (client) {
        const version = client.getLastServerInfoMessage()?.version ?? null;
        await client.close().catch(() => {}); // intentional: best-effort teardown of the version probe connection
        return { online: true, version };
      }
    }
    if (Date.now() >= deadline) return { online: false, version: null };
    await sleep(500);
  }
}

export async function runDaemonUpdateCommand(
  options: CommandOptions,
  command: Command,
): Promise<UpdateCommandResult> {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(here);
  const home = typeof options.home === "string" ? options.home : undefined;
  const mode = repoRoot ? "source" : "global";
  const steps: string[] = [];
  const verifyTimeoutMs = parseVerifyTimeoutMs(options.verifyTimeout);

  const applyUpdate = async (): Promise<string> => {
    if (repoRoot) {
      run("git", ["-C", repoRoot, "pull", "--ff-only"]);
      steps.push("git pull --ff-only");
      const pm = detectPackageManager(repoRoot);
      run(pm, ["install"], repoRoot);
      steps.push(`${pm} install`);
      if (options.build !== false && hasBuildScript(repoRoot)) {
        run(pm, ["run", "build"], repoRoot);
        steps.push(`${pm} run build`);
      }
    } else {
      run("npm", ["install", "-g", "@getpaseo/cli@latest"]);
      steps.push("npm install -g @getpaseo/cli@latest");
    }
    return readCliVersion();
  };

  const deps: UpdateDeps = {
    currentVersion: readCliVersion,
    // Source checkouts can't cheaply resolve "latest" (it's a moving branch);
    // null means "attempt the pull" and the no-op detection short-circuits.
    latestVersion: async () => (repoRoot ? null : npmViewLatest()),
    backup: async (): Promise<RollbackPoint> =>
      repoRoot
        ? { kind: "git", ref: gitHead(repoRoot) }
        : { kind: "version", ref: readCliVersion() },
    applyUpdate,
    restart: async () => {
      await runRestartCommand(options, command);
    },
    verifyOnline: (timeoutMs) => pollOnline(home, timeoutMs),
    rollback: async (point) => {
      if (point.kind === "git" && repoRoot) {
        run("git", ["-C", repoRoot, "reset", "--hard", point.ref]);
        const pm = detectPackageManager(repoRoot);
        run(pm, ["install"], repoRoot);
        if (options.build !== false && hasBuildScript(repoRoot))
          run(pm, ["run", "build"], repoRoot);
      } else {
        run("npm", ["install", "-g", `@getpaseo/cli@${point.ref}`]);
      }
      await runRestartCommand(options, command);
    },
    log: (step) => steps.push(step),
  };

  let outcome: Awaited<ReturnType<typeof planAndRunUpdate>>;
  try {
    outcome = await planAndRunUpdate(deps, {
      force: options.force === true,
      verifyTimeoutMs,
    });
  } catch (err) {
    const error: CommandError = {
      code: "UPDATE_FAILED",
      message: `Daemon update failed (${mode}): ${(err as Error).message}`,
      details: steps.length ? `completed: ${steps.join(", ")}` : undefined,
    };
    throw error;
  }

  const versionBefore = outcome.action === "up-to-date" ? outcome.version : outcome.versionBefore;
  let versionAfter: string;
  if (outcome.action === "updated") {
    versionAfter = outcome.versionAfter;
  } else if (outcome.action === "rolled-back") {
    versionAfter = versionBefore; // restored to the pre-update version
  } else {
    versionAfter = outcome.version;
  }
  const message =
    outcome.action === "rolled-back"
      ? `${outcome.reason} — rolled back to ${versionBefore}`
      : steps.join(" → ");

  return {
    type: "single",
    data: { action: outcome.action, mode, versionBefore, versionAfter, message },
    schema: updateResultSchema,
  };
}

function parseVerifyTimeoutMs(raw: unknown): number {
  if (typeof raw === "string" && raw.trim().length > 0) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n * 1000);
  }
  return 30_000;
}
