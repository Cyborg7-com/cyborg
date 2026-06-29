// FIX A (Windows auto-update lock) — native module resolver.
//
// On a packaged Windows desktop the daemon's better-sqlite3 lives UNDER the install
// dir ($INSTDIR). Its native image (better_sqlite3.node) gets memory-mapped and a
// surviving holder — an orphaned daemon worker, a Windows Defender scan — keeps a
// lock that fails the NSIS auto-update uninstall ("Failed to uninstall old
// application files .: 2"). The desktop main process copies the loadable subtree to
// a stable external dir and exports its path via CYBORG7_NATIVE_DIR (see
// desktop-cyborg/native-relocate.ts); resolve the native module from THERE so
// nothing under $INSTDIR is loaded or locked. Off Windows / when unset / when the
// external copy is absent, resolve the bare specifier exactly as a static import
// would.
//
// IMPORTANT: this module has NO top-level value import of better-sqlite3 — the
// require is lazy, inside loadBetterSqlite3(). The Postgres-only relay never calls
// it, so importing this file does NOT drag better-sqlite3 into the relay's startup
// graph (the ERR_MODULE_NOT_FOUND crash-loop guarded throughout storage.ts).

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";

const require = createRequire(import.meta.url);

// Latched so the win32 in-$INSTDIR fallback warn (see resolveNativeSpecifier)
// fires at most once per process, not on every native load.
let nativeRelocationFallbackWarned = false;

function resolveNativeSpecifier(name: string): string {
  const externalDir = process.env.CYBORG7_NATIVE_DIR;
  if (process.platform === "win32" && externalDir) {
    // native-relocate.ts writes a `.complete` marker at the ROOT of the external
    // dir as the LAST copy step. Require it (not just the package entry): a crash
    // mid-copy leaves the package dir present but partial, and loading a truncated
    // better_sqlite3.node would crash. Marker absent → fall back to the in-$INSTDIR copy.
    const marker = join(externalDir, ".complete");
    const externalEntry = join(externalDir, name);
    if (existsSync(marker) && existsSync(externalEntry)) return externalEntry;
  }
  // FALLBACK on win32: the external relocation dir/marker is absent, so this native
  // module loads from inside $INSTDIR — exactly the state that re-arms the
  // auto-update ":2" lock on the NEXT update (see desktop-cyborg/native-relocate.ts).
  // Make it observable; warn at most once per process. Off-win32 there is no
  // relocation, so stay silent.
  if (process.platform === "win32" && !nativeRelocationFallbackWarned) {
    nativeRelocationFallbackWarned = true;
    console.warn(
      `[native-relocate] loading ${name} from $INSTDIR (relocation absent) — update fragility risk`,
    );
  }
  return name;
}

let betterSqlite3: typeof Database | null = null;

// Lazily load the better-sqlite3 constructor, resolving from the external native
// dir on a packaged Windows desktop. Cached after first load.
export function loadBetterSqlite3(): typeof Database {
  if (!betterSqlite3) {
    betterSqlite3 = require(resolveNativeSpecifier("better-sqlite3")) as typeof Database;
  }
  return betterSqlite3;
}
