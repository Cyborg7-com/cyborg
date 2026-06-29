import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// PI ships with an `exports` map that blocks `require.resolve(".../package.json")`
// and even the package main, so we locate its install directory by walking up the
// node_modules tree from this file (works in both the pnpm dev layout and the
// flat `pnpm deploy` bundle). fs ignores the exports restriction.
function findPiPkgDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = resolve(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    if (existsSync(resolve(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Absolute path to the bundled PI package.json, or null (used for name-patching). */
export function resolvePiPackageJson(): string | null {
  const dir = findPiPkgDir();
  return dir ? resolve(dir, "package.json") : null;
}

function resolveBundledPiJs(): string | null {
  const dir = findPiPkgDir();
  if (!dir) return null;
  try {
    const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const rel =
      typeof pkg.bin === "string"
        ? pkg.bin
        : (pkg.bin?.pi ?? (pkg.bin ? Object.values(pkg.bin)[0] : undefined));
    return rel ? resolve(dir, rel) : null;
  } catch {
    return null;
  }
}

/** How to spawn PI: a command plus any prefix args (e.g. node + pi entry). */
export interface PiExec {
  cmd: string;
  pre: string[];
}

/**
 * Resolve how to invoke PI. Order: explicit `--pi-command` → `PI_COMMAND` env →
 * the PI bundled inside cybo (spawned via the current Node, so it doesn't depend
 * on PATH or the .proto toolchain) → `pi` on PATH.
 */
export function resolvePi(explicit?: string): PiExec {
  if (explicit) return { cmd: explicit, pre: [] };
  if (process.env.PI_COMMAND) return { cmd: process.env.PI_COMMAND, pre: [] };
  const js = resolveBundledPiJs();
  if (js) return { cmd: process.execPath, pre: [js] };
  return { cmd: "pi", pre: [] };
}

/** Human-readable form of a PiExec for error/help messages. */
export function describePi(pi: PiExec): string {
  return pi.pre.length > 0 ? `${pi.cmd} ${pi.pre.join(" ")}` : pi.cmd;
}
