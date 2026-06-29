// Lightweight update notifier for the cybo CLI (update-notifier style).
//
// On a normal run we print a one-line notice from a cached result (instant, no
// network), then — if the cache is stale — kick off a fail-silent background
// refresh that writes the cache for next time. Never blocks the command, never
// errors out, and stays out of stdout (writes to stderr) so piping cybo output
// is unaffected. Opt out with CYBO_NO_UPDATE_CHECK=1 (also skipped under CI).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCyboHome } from "./home.js";

// Hidden flag: the detached child re-invokes cybo with this to refresh the
// cache out-of-process, then exits. Handled at the very top of cli.ts.
export const BACKGROUND_REFRESH_FLAG = "--background-update-check";

// Releases (and the mirrored installers) live in the PUBLIC cyborg7-releases
// repo — the private source repo's API/assets aren't reachable unauthenticated.
// That repo also hosts frequent desktop releases, so scanning the releases API
// for the newest cybo-v* is unreliable (it'd page off). Each cybo release pins
// the current version in cybo/version.txt on the default branch — read that.
const REPO = "Cyborg7-com/cyborg7-releases";
// Installer ref. Defaults to the release repo's default branch, but can be
// pinned to an immutable release tag or commit SHA via CYBO_INSTALL_REF so a
// branch compromise / GitHub-side substitution can't move it. The other half of
// the integrity story is the published `.sha256`, verified by `cybo upgrade`
// before it runs the installer (see runUpgrade in cli.ts) — together they stop
// the blind `curl | sh` from executing a tampered script.
const INSTALL_REF = process.env.CYBO_INSTALL_REF ?? "main";
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${INSTALL_REF}/cybo`;
const VERSION_URL = `${RAW_BASE}/version.txt`;
const INSTALL_URL = `${RAW_BASE}/install.sh`;
const INSTALL_PS1 = `${RAW_BASE}/install.ps1`;
const INSTALL_SHA256 = `${INSTALL_URL}.sha256`;
const INSTALL_PS1_SHA256 = `${INSTALL_PS1}.sha256`;
const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

export function getInstallUrl(): string {
  return INSTALL_URL;
}
export function getInstallPs1Url(): string {
  return INSTALL_PS1;
}
export function getInstallSha256Url(): string {
  return INSTALL_SHA256;
}
export function getInstallPs1Sha256Url(): string {
  return INSTALL_PS1_SHA256;
}

interface UpdateCache {
  checkedAt: number;
  latest: string | null;
}

function cacheFile(): string {
  return join(getCyboHome(), "update-check.json");
}

// Compare dotted numeric versions; ignores any prerelease suffix. >0 if a > b.
function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .split("-")[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function readCache(): UpdateCache | null {
  try {
    return JSON.parse(readFileSync(cacheFile(), "utf8")) as UpdateCache;
  } catch {
    return null;
  }
}

function writeCache(c: UpdateCache): void {
  try {
    const home = getCyboHome();
    if (!existsSync(home)) mkdirSync(home, { recursive: true });
    writeFileSync(cacheFile(), `${JSON.stringify(c)}\n`);
  } catch {
    // best-effort; a read-only HOME just means we re-check next time
  }
}

async function fetchLatest(): Promise<string | null> {
  try {
    const res = await fetch(VERSION_URL, {
      headers: { "user-agent": "cybo-cli" },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const v = (await res.text()).trim();
    return v || null;
  } catch {
    return null;
  }
}

// Refresh the cache (used by the detached background child). Awaited there only.
export async function runBackgroundRefresh(): Promise<void> {
  const latest = await fetchLatest();
  writeCache({ checkedAt: Date.now(), latest });
}

// Print a notice if the cached latest is newer, then — when the cache is stale —
// spawn a DETACHED, unref'd child to refresh it. The refresh must not run in
// this process: an unawaited fetch (+ its timeout) keeps the event loop alive,
// so short commands like `cybo list` would hang until it resolves. The detached
// child owns the network call and writes the cache for next time.
export function maybeNotifyUpdate(current: string): void {
  if (process.env.CYBO_NO_UPDATE_CHECK || process.env.CI || current === "unknown") return;

  const cache = readCache();
  if (cache?.latest && compareVersions(cache.latest, current) > 0) {
    process.stderr.write(
      `\n  ▲ cybo ${cache.latest} is available (you have ${current}) — run \`cybo upgrade\`\n\n`,
    );
  }

  const stale = !cache || Date.now() - cache.checkedAt > CHECK_TTL_MS;
  const entry = process.argv[1];
  if (stale && entry) {
    try {
      spawn(process.execPath, [entry, BACKGROUND_REFRESH_FLAG], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } catch {
      // can't spawn — just re-check on a later run
    }
  }
}
