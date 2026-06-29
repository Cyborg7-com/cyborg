// Isolate the daemon's INTERNAL Codex runs (the slash AI completer: summarize /
// standup / action-items / translate) from the user's GLOBAL Codex config.
//
// The Codex app-server reads its config home (CODEX_HOME ?? ~/.codex) on every
// session: `config.toml` (mcp_servers + model/developer instructions), plus custom
// `prompts/` and `skills/`. So a user's global Codex config injects MCP servers /
// instructions / prompts into the ephemeral summarizer too, contaminating it — the
// Codex analogue of pi's "Design Studio" global extensions (see pi-internal-agent-dir).
//
// Fix (same pattern as #345/pi): point the internal Codex at an isolated CODEX_HOME
// that MIRRORS the real one via symlinks (auth.json, version markers, …) but OMITS the
// contaminating entries (config.toml / instructions / prompts / skills). Result: same
// credentials, zero global config. Set as CODEX_HOME on the internal agent's env.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";

const ENV_CODEX_HOME = "CODEX_HOME";
const CODEX_DIR_NAME = ".codex";

// Global entries under CODEX_HOME that carry user config/instructions/MCP/prompts —
// deliberately NOT mirrored so the internal Codex starts from a clean slate. auth.json
// (and anything else, e.g. version markers) IS mirrored so auth survives.
const OMIT_ENTRIES = new Set(["config.toml", "instructions.md", "AGENTS.md", "prompts", "skills"]);

// The user's REAL Codex home (holds auth.json + the global config.toml).
export function resolveRealCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env[ENV_CODEX_HOME] || join(homedir(), CODEX_DIR_NAME);
}

export interface EnsureInternalCodexHomeOptions {
  // Where the isolated dir lives. Default: $PASEO_HOME, else ~/.cyborg7.
  baseDir?: string;
  // The real Codex home to mirror. Default: resolveRealCodexHome().
  realCodexHome?: string;
  platform?: NodeJS.Platform;
  logger?: Pick<Logger, "info" | "warn">;
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function readlinkOrNull(p: string): string | null {
  try {
    return readlinkSync(p);
  } catch {
    return null;
  }
}

// Ensure `link` is a symlink → `target` (recreate if missing/stale/wrong).
function ensureMirrorSymlink(target: string, link: string): void {
  if (isSymlink(link) && readlinkOrNull(link) === target) return;
  if (existsSync(link) || isSymlink(link)) rmSync(link, { recursive: true, force: true });
  symlinkSync(target, link);
}

// Idempotently build the isolated Codex home and return its path, or null if it can't
// be set up (then the caller leaves CODEX_HOME unset → default behavior).
export function ensureInternalCodexHome(
  options: EnsureInternalCodexHomeOptions = {},
): string | null {
  const platform = options.platform ?? process.platform;
  // Windows symlinks need elevation; skip (leave CODEX_HOME unset → unchanged).
  if (platform === "win32") return null;

  const realHome = options.realCodexHome ?? resolveRealCodexHome();
  const base = options.baseDir ?? process.env.PASEO_HOME ?? join(homedir(), ".cyborg7");
  const isolated = join(base, "codex-internal-home");

  try {
    mkdirSync(isolated, { recursive: true });

    // Mirror every real top-level entry EXCEPT the contaminating config ones.
    if (existsSync(realHome)) {
      for (const entry of readdirSync(realHome)) {
        if (OMIT_ENTRIES.has(entry)) continue;
        ensureMirrorSymlink(join(realHome, entry), join(isolated, entry));
      }
    }

    // Belt-and-suspenders: ensure none of the omitted entries leaked in.
    for (const entry of OMIT_ENTRIES) {
      const p = join(isolated, entry);
      if (existsSync(p) || isSymlink(p)) rmSync(p, { recursive: true, force: true });
    }

    options.logger?.info(
      { isolated, realHome },
      "codex-internal-home: isolated Codex home ready (auth mirrored, no global config/instructions/mcp)",
    );
    return isolated;
  } catch (err) {
    options.logger?.warn(
      { err: err instanceof Error ? err.message : String(err), isolated, realHome },
      "codex-internal-home: setup failed; internal Codex will use the default home",
    );
    return null;
  }
}
