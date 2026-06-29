import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensurePrivateDirectory } from "./private-files.js";

/** Default daemon home when PASEO_HOME is unset. Single source of truth (#744). */
export const DEFAULT_PASEO_HOME = "~/.cyborg7";

/** Legacy Paseo.app home, kept only to nudge migration off the old default (#744). */
const LEGACY_PASEO_HOME = "~/.paseo";

let warnedLegacyHome = false;

function expandHomeDir(input: string): string {
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  if (input === "~") {
    return os.homedir();
  }
  return input;
}

// One-time nudge: when we fall back to the new ~/.cyborg7 default but an old
// ~/.paseo home still exists, the user likely expected the daemon to keep using
// it. We do NOT auto-migrate or move files — just tell them how to opt back in.
function warnIfLegacyHomeExists(): void {
  if (warnedLegacyHome) {
    return;
  }
  warnedLegacyHome = true;

  const legacyHome = path.resolve(expandHomeDir(LEGACY_PASEO_HOME));
  if (!existsSync(legacyHome)) {
    return;
  }

  console.warn(
    `[paseo] Using default home ${DEFAULT_PASEO_HOME} but found a legacy ${LEGACY_PASEO_HOME}. ` +
      `Set PASEO_HOME=${LEGACY_PASEO_HOME} to keep using the old location (no files were moved).`,
  );
}

export function resolvePaseoHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PASEO_HOME?.trim();
  if (!override) {
    warnIfLegacyHomeExists();
  }
  const raw = override || DEFAULT_PASEO_HOME;
  const resolved = path.resolve(expandHomeDir(raw));
  ensurePrivateDirectory(resolved);
  return resolved;
}
