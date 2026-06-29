#!/usr/bin/env node
// Re-export Pi's `pi` binary so `npm i -g @cyborg7/cybo` puts `pi` on PATH.
// npm only links this package's OWN bins (cybo); `pi` lives in a nested
// dependency (@earendil-works/pi-coding-agent) and isn't exposed otherwise. The
// daemon runs cybos by spawning the host `pi` via Paseo's PI provider, so after a
// bare `cybo` install `pi` must be resolvable too. (Option A — see
// internal docs)
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const PKG = "@earendil-works/pi-coding-agent";

// Find Pi's package root, then read its declared `bin` and resolve the CLI entry.
// We can't use require.resolve here: Pi's `exports` map exposes only the `import`
// condition (no `require`, no ./package.json), so CJS-style require.resolve of
// either the package main or ./package.json throws ERR_PACKAGE_PATH_NOT_EXPORTED.
// `require.resolve.paths(PKG)` returns the node_modules chain to search (it does
// NOT go through exports), so we stat each candidate's package.json directly —
// robust whether the dep is hoisted (root node_modules) or nested under cybo.
let piCliJs;
try {
  const searchPaths = require.resolve.paths(PKG) ?? [];
  let pkgRoot;
  for (const base of searchPaths) {
    const candidate = join(base, PKG);
    if (existsSync(join(candidate, "package.json"))) {
      pkgRoot = candidate;
      break;
    }
  }
  if (!pkgRoot) {
    throw new Error(`could not find ${PKG} in any node_modules path`);
  }
  const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  const bin = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});
  const relBin = bin.pi ?? Object.values(bin)[0];
  if (!relBin) {
    throw new Error(`${PKG} declares no \`bin\``);
  }
  piCliJs = resolve(pkgRoot, relBin);
} catch (err) {
  console.error(
    `[cybo] could not locate the bundled pi CLI: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

// Run the real Pi CLI in a fresh Node process (NOT a dynamic import): Pi reads
// process.argv[1] as its own path, so it must own the process entry. Spawning
// node directly with the resolved .js avoids the platform-specific .cmd shim and
// any shell. Inherit stdio (interactive TUI / RPC) and pass the exit code
// through; forward a terminating signal so callers see why it died.
const child = spawn(process.execPath, [piCliJs, ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("error", (err) => {
  console.error(`[cybo] failed to launch pi: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
