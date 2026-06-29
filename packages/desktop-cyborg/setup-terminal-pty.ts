// Electron-free pty core of the embedded "Set up Cybo" terminal — kept apart
// from setup-terminal.ts (which owns the IPC wiring) so the spawn behavior can
// be exercised by plain-node harnesses/tests without an Electron runtime.

import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type * as pty from "node-pty";

// node-pty is a NATIVE module. Load it LAZILY (first spawn) and behind a guard:
// a packaging miss (the prebuilt pty.node not collected from pnpm's symlinked
// node_modules — the reason after-pack hand-injects it) must disable ONLY the
// embedded Set-up-Cybo terminal, NOT crash the whole app at launch. A top-level
// `import "node-pty"` ran at startup and an uncaught "Cannot find module
// pty.node" took the entire main process down (0.0.130 wouldn't launch at all).
const require = createRequire(import.meta.url);
let ptyModule: typeof pty | null = null;
let ptyLoadError: Error | null = null;
// Latched so the win32 in-$INSTDIR fallback warn (see resolveNodePtySpecifier)
// fires at most once per process, not on every setup-terminal spawn.
let nativeRelocationFallbackWarned = false;

// On a packaged Windows desktop the main process relocates node-pty's loadable
// subtree OUT of the install dir (so a memory-mapped .node can't lock the dir and
// fail the NSIS auto-update uninstall) and exports the external dir via
// CYBORG7_NATIVE_DIR — see desktop-cyborg/native-relocate.ts. Resolve node-pty from
// there so this main-process terminal never loads the in-$INSTDIR copy. Off Windows
// / when unset / when the external copy is absent, resolve the bare specifier.
function resolveNodePtySpecifier(): string {
  const externalDir = process.env.CYBORG7_NATIVE_DIR;
  if (process.platform === "win32" && externalDir) {
    // native-relocate.ts writes a `.complete` marker at the ROOT of the external
    // dir as the LAST copy step. Require it (not just the package entry): a crash
    // mid-copy leaves the package dir present but partial, and loading a truncated
    // .node would crash. Marker absent → fall back to the in-$INSTDIR copy.
    const marker = path.join(externalDir, ".complete");
    const externalEntry = path.join(externalDir, "node-pty");
    if (existsSync(marker) && existsSync(externalEntry)) return externalEntry;
  }
  // FALLBACK on win32: the external relocation dir/marker is absent, so node-pty
  // loads from inside $INSTDIR — exactly the state that re-arms the auto-update
  // ":2" lock on the NEXT update (see native-relocate.ts). Make it observable;
  // warn at most once per process. console (not electron-log) keeps this file
  // Electron-free for the plain-node harnesses. Off-win32 stay silent.
  if (process.platform === "win32" && !nativeRelocationFallbackWarned) {
    nativeRelocationFallbackWarned = true;
    console.warn(
      "[native-relocate] loading node-pty from $INSTDIR (relocation absent) — update fragility risk",
    );
  }
  return "node-pty";
}

export function loadPty(): typeof pty {
  if (ptyModule) return ptyModule;
  if (ptyLoadError) throw ptyLoadError;
  try {
    ptyModule = require(resolveNodePtySpecifier()) as typeof pty;
    return ptyModule;
  } catch (err) {
    ptyLoadError =
      err instanceof Error ? err : new Error(`failed to load node-pty: ${String(err)}`);
    throw ptyLoadError;
  }
}

/** Whether the native pty module can load — lets callers degrade gracefully. */
export function isPtyAvailable(): boolean {
  try {
    loadPty();
    return true;
  } catch {
    return false;
  }
}

// Commands the renderer may request — a fixed allowlist, never free text. The
// renderer is trusted-origin gated, but a terminal spawn is the one IPC call
// where defense in depth is non-negotiable.
//
// NO autoType for cybo-login: since cybo 0.2.6, `cybo login` opens its OWN
// provider picker ("Choose [1-4]:") and reads stdin right away — the injected
// "/login\r" from the pre-0.2.6 interim flow (terminal ran the runtime UI and
// needed its in-UI /login command typed) lands in that picker as a bogus answer
// and kills it ("Nothing selected" → exit 1). The renderer's version gate only
// runs this command on ≥0.2.6, so inject nothing; autoType support stays for
// future commands that need it.
export const ALLOWED_COMMANDS: Record<string, { command: string; autoType?: string }> = {
  "cybo-login": { command: "cybo login" },
  // Verification companion (internal docs): auth + model status, read-only.
  "cybo-doctor": { command: "cybo doctor" },
};

// Type `sequence` into the pty once, ~1.2s after the FIRST output chunk (the
// UI is rendering by then). Returns a cancel function for teardown.
export function armAutoType(proc: pty.IPty, sequence: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const sub = proc.onData(() => {
    sub.dispose();
    timer = setTimeout(() => proc.write(sequence), 1200);
  });
  return () => {
    sub.dispose();
    if (timer) clearTimeout(timer);
  };
}

export function userShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC ?? "cmd.exe";
  }
  return process.env.SHELL ?? "/bin/zsh";
}

export function spawnSetupPty(opts: { cols: number; rows: number; commandKey: string }): {
  id: string;
  proc: pty.IPty;
  cancelAutoType: () => void;
} {
  const entry = ALLOWED_COMMANDS[opts.commandKey];
  if (!entry) throw new Error(`unknown setup-terminal command "${opts.commandKey}"`);
  const command = entry.command;
  const shell = userShell();
  // -i -l: interactive login shell → user PATH (homebrew/npm-global/proto)
  // resolved by the shell itself, the exact #342 failure family a GUI process
  // hits with a bare spawn; `exec` replaces the shell so the pty exit IS the
  // command's exit (no lingering shell after `cybo login` finishes).
  const args = process.platform === "win32" ? ["/c", command] : ["-il", "-c", `exec ${command}`];
  const proc = loadPty().spawn(shell, args, {
    name: "xterm-256color",
    cols: opts.cols,
    rows: opts.rows,
    cwd: os.homedir(),
    env: process.env as Record<string, string>,
  });
  const cancelAutoType = entry.autoType ? armAutoType(proc, entry.autoType) : () => {};
  return { id: randomUUID(), proc, cancelAutoType };
}
