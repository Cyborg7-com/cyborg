// FIX A (Windows auto-update lock — THE CURE): relocate the loadable native
// payload OUT of the install dir ($INSTDIR) so the NSIS uninstaller can always
// empty the dir on auto-update, regardless of who still holds a handle.
//
// ROOT CAUSE: the Windows auto-update fails "Failed to uninstall old application
// files .: 2" because a native .node image under $INSTDIR is still memory-mapped
// when the old uninstaller runs. The lockable files are node-pty
// (conpty.node / conpty_console_list.node / pty.node) and better-sqlite3
// (better_sqlite3.node), packaged UNDER $INSTDIR in two copies (the main-process
// app.asar.unpacked node-pty and the daemon/pty-host bundle). Surviving holders —
// an orphaned daemon worker, the detached persistence pty-host, or Windows
// Defender scanning the freshly-killed UNSIGNED .node files — keep the lock past
// the uninstall. Killing the holder is a race we keep losing, so the durable cure
// is HOLDER-AGNOSTIC: make sure NO lockable native file lives under $INSTDIR at
// runtime.
//
// MECHANISM: on first launch of a given version, copy the FULL loadable subtree of
// node-pty (lib + build/Release + prebuilds/win32-x64 + third_party/conpty) AND
// better-sqlite3 (build/Release/better_sqlite3.node + lib) from the packaged
// install-dir location to a stable, per-version external dir
// %LOCALAPPDATA%/cyborg/native/<appVersion>/. The path is exported via
// CYBORG7_NATIVE_DIR; the daemon (terminal.ts, storage.ts, sqlite-timeline-store.ts)
// and the main-process Set-up-Cybo terminal (setup-terminal-pty.ts) resolve the
// native module from THERE, so the in-$INSTDIR copies are never loaded and never
// locked. Per-version so an in-flight update (which lands a new version dir) never
// overwrites a .node a still-running pty-host of the OLD version has mapped.
//
// Windows + packaged only. A no-op everywhere else (dev resolves from the repo
// node_modules; macOS/Linux swap the install dir in place, so there is nothing to
// lock). Best-effort: a copy failure NEVER blocks startup — the loaders simply
// fall back to the in-$INSTDIR packaged copy (the pre-fix behavior).

import { app } from "electron";
import log from "electron-log/main";
import path from "node:path";
import os from "node:os";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

// The env var contract read by every native loader (daemon + main process). When
// set, a loader resolves "<dir>/<package>" instead of the bare specifier; when
// unset (non-Windows, dev, or a failed copy) it resolves normally.
export const NATIVE_DIR_ENV = "CYBORG7_NATIVE_DIR";

// The native packages whose .node images must not live under $INSTDIR at runtime.
const NATIVE_PACKAGES = ["node-pty", "better-sqlite3"] as const;

// Runtime deps that live as SIBLINGS of a native package (not nested under it) and
// must travel WITH it when relocated. better-sqlite3 loads better_sqlite3.node via
// require("bindings")("better_sqlite3.node"), and `bindings` (plus its own dep
// file-uri-to-path) sits at @getpaseo/server/node_modules/bindings — left behind by
// the package-only copy. Without them require("bindings") cannot resolve from the
// relocated tree and the daemon worker crash-loops ("Cannot find module 'bindings'").
// node-pty has no entry: it loads its .node by relative path, so it needs nothing.
const COLOCATED_RUNTIME_DEPS: Record<string, readonly string[]> = {
  "better-sqlite3": ["bindings", "file-uri-to-path"],
};

function localAppData(): string {
  return process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
}

// Per-version target: %LOCALAPPDATA%/cyborg/native/<appVersion>/. Versioned so a
// downloaded update (new version) creates a NEW dir and never overwrites a .node
// a running old-version pty-host has mapped.
function versionedNativeDir(): string {
  return path.join(localAppData(), "cyborg", "native", app.getVersion());
}

// The daemon bundle's node_modules inside the packaged app (the authoritative
// platform-pruned copy with the win32 prebuild + third_party/conpty +
// better_sqlite3.node). after-pack.cjs places this at
// resources/daemon/node_modules/@getpaseo/server/node_modules.
function daemonNativeSourceRoot(): string {
  return path.join(
    process.resourcesPath,
    "daemon",
    "node_modules",
    "@getpaseo",
    "server",
    "node_modules",
  );
}

// Copy the loadable native subtree out of $INSTDIR into `target`, writing the
// `.complete` marker LAST so a crash mid-copy leaves no marker and the next launch
// re-copies. THROWS on a hard copy failure so the caller can retry / log loudly; a
// per-package missing source is a SOFT skip (warn + continue) that leaves that one
// package to resolve from $INSTDIR — the pre-fix per-package fallback.
function copyNativeModulesTo(target: string): void {
  const marker = path.join(target, ".complete");
  mkdirSync(target, { recursive: true });
  const srcRoot = daemonNativeSourceRoot();
  for (const name of NATIVE_PACKAGES) {
    const src = path.join(srcRoot, name);
    const dst = path.join(target, name);
    if (!existsSync(src)) {
      // The source is missing only if packaging changed; warn and leave this
      // package to resolve from $INSTDIR (the loader falls back on a missing
      // external entry).
      log.warn(`[native-relocate] packaged source missing — skipping ${name}`, { src });
      continue;
    }
    // dereference: the daemon copy was materialized whole (after-pack cpSync
    // with dereference), but copy through symlinks defensively so the external
    // tree is fully self-contained.
    cpSync(src, dst, { recursive: true, dereference: true });

    // Co-locate each sibling runtime dep INSIDE the relocated package's own
    // node_modules so the package's require() resolves it from the external tree
    // (better-sqlite3 → bindings → file-uri-to-path), not back into $INSTDIR.
    for (const dep of COLOCATED_RUNTIME_DEPS[name] ?? []) {
      const depSrc = path.join(srcRoot, dep);
      const depDst = path.join(dst, "node_modules", dep);
      if (!existsSync(depSrc)) {
        // Same shape as the missing-package warn: leave the dep to resolve from
        // $INSTDIR rather than failing the relocation.
        log.warn(`[native-relocate] runtime dep missing — skipping ${dep} for ${name}`, {
          depSrc,
        });
        continue;
      }
      // Explicit parent create so the dep copy never depends on cpSync's implicit
      // parent creation (better-sqlite3 ships without its own node_modules).
      mkdirSync(path.join(dst, "node_modules"), { recursive: true });
      cpSync(depSrc, depDst, { recursive: true, dereference: true });
    }
  }

  // Marker written LAST: a crash mid-copy leaves no marker, so the next launch
  // re-copies rather than trusting a partial tree.
  writeFileSync(marker, `${new Date().toISOString()}\n`);
}

// Copy node-pty + better-sqlite3 out of $INSTDIR (idempotent, guarded by a marker)
// and export CYBORG7_NATIVE_DIR so child processes (daemon → pty-host) and the
// in-process setup terminal resolve the .node from outside the install dir. Must
// run BEFORE the daemon is spawned and before any setup-terminal load.
//
// OBSERVABILITY (Caveat 1): relocation is best-effort — on copy failure every
// loader silently falls back to the in-$INSTDIR .node, which re-arms the Windows
// auto-update lock (":2") on the NEXT update with no signal. So this logs LOUDLY:
// one INFO on success, a single cheap RETRY on the first copy failure, and an
// ERROR (greppable "[native-relocate] FAILED") if the retry also fails. The
// fallback behavior is UNCHANGED — failure is never fatal, the app still launches.
export function relocateNativeModulesForWindows(): void {
  if (process.platform !== "win32") return; // macOS/Linux swap in place — nothing to lock.
  if (!app.isPackaged) return; // dev resolves from the repo node_modules.

  const target = versionedNativeDir();
  const marker = path.join(target, ".complete");

  // Fast path: this version was already relocated. Skip the copy entirely so a
  // same-version relaunch never touches a .node a running pty-host has mapped
  // (which would EBUSY on Windows). Just re-export the path.
  if (existsSync(marker)) {
    process.env[NATIVE_DIR_ENV] = target;
    return;
  }

  try {
    copyNativeModulesTo(target);
  } catch (firstErr) {
    // A transient holder (Defender mid-scan, a slow AV) can briefly EBUSY a single
    // .node on the first pass. Retry ONCE — cheap, and it usually clears a momentary
    // lock. NOT swallowed: the first failure is logged here and, if the retry also
    // throws, escalated to ERROR below.
    log.warn("[native-relocate] copy failed — retrying once", firstErr);
    try {
      copyNativeModulesTo(target);
    } catch (secondErr) {
      // LOUD + greppable. Relocation did NOT happen, so every native loader falls
      // back to the in-$INSTDIR copy and the NEXT Windows auto-update may fail
      // again with "uninstall ... : 2". NEVER fatal — the app still launches on the
      // in-place copy — but this MUST be visible so the regression is caught early.
      log.error(
        "[native-relocate] FAILED — falling back to in-$INSTDIR natives; the NEXT Windows update may fail with code 2",
        secondErr,
      );
      return;
    }
  }

  process.env[NATIVE_DIR_ENV] = target;
  log.info(`[native-relocate] ok -> ${target}`);
}
