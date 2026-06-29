// Keeps the Pi provider-availability snapshot fresh after a cybo install, so a cybo
// can spawn WITHOUT a daemon restart.
//
// The bug: provider availability is a boot-time cached snapshot
// (ProviderSnapshotManager). Installing cybo/pi via the button (`npm i -g
// @cyborg7/cybo`) links `pi` onto PATH, but the snapshot still says "pi unavailable"
// until the daemon restarts — so the cybo-spawn provider-check keeps answering "This
// daemon doesn't have the Pi provider available". refreshSnapshotForCwd already
// exists; nobody called it after the install.
//
// The cwd to refresh: the spawn provider-check queries `listProviders({ wait: true })`
// with NO cwd, which resolves to the home dir — so we refresh that snapshot's `pi`
// entry (only `pi`, to avoid re-probing every provider).

import { homedir } from "node:os";
import type { Logger } from "pino";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { findBackendGap } from "./cybo-runtime-profile.js";

type RefreshCapable = Pick<ProviderSnapshotManager, "refreshSnapshotForCwd">;
type RefreshAndList = RefreshCapable & Pick<ProviderSnapshotManager, "listProviders">;

async function refreshPiHomeSnapshot(
  manager: RefreshCapable,
  logger?: Logger | null,
): Promise<void> {
  try {
    await manager.refreshSnapshotForCwd({ cwd: homedir(), providers: ["pi"] });
  } catch (err) {
    // Best-effort: a stale snapshot self-heals on the next probe; never fail the
    // install/status response over a refresh hiccup. Logged to daemon.log (#736).
    logger?.error({ err }, "[cybo] Pi provider snapshot refresh failed (will self-heal)");
  }
}

// After a SUCCESSFUL cybo install/update, refresh the Pi snapshot so the freshly
// linked `pi` binary becomes visible to the spawn provider-check immediately.
export async function refreshPiSnapshotAfterInstall(
  manager: RefreshCapable | null,
  result: { ok: boolean },
  logger?: Logger | null,
): Promise<void> {
  if (!result.ok || !manager) return;
  await refreshPiHomeSnapshot(manager, logger);
}

// Passive reconciliation: when a cybo status probe sees the CLI installed but the
// CACHED snapshot still reports pi unavailable/absent, refresh once. The gating read
// is cached (no `wait` → no probe), and it's self-bounding — once the snapshot flips
// to available, the condition is false and nothing fires. Pairs with the agents-pane
// probe (#353) so simply opening the pane heals a stale snapshot.
export async function reconcilePiSnapshotOnStatus(
  manager: RefreshAndList | null,
  status: { installed: boolean },
  logger?: Logger | null,
): Promise<void> {
  if (!status.installed || !manager) return;
  const entries = await manager.listProviders({ providers: ["pi"] });
  const pi = entries.find((entry) => entry.provider === "pi");
  if (!pi || pi.status === "unavailable") {
    await refreshPiHomeSnapshot(manager, logger);
  }
}

type PiEntry = Awaited<ReturnType<ProviderSnapshotManager["listProviders"]>>[number];

// Lazy re-probe at SPAWN time. The snapshot's verdict is STICKY: the spawn guard's
// listProviders({ wait: true }) only waits for a warm-up — it never re-probes an
// entry that already settled (warmUp uses force:false → returns the cached load).
// Two stale-cache shapes blocked spawns until a daemon restart:
//
//   1. status STICKY: a pi that became available after the last settled probe
//      (installed before #358 shipped, installed outside the in-app button, PATH
//      fixed, daemon env race at boot, …) stayed "unavailable" forever.
//   2. MODELS stale: a pi that was already "ready" at boot but whose model list
//      pre-dates a `cybo login` connecting a NEW backend. The per-backend gate
//      then reads the boot-time models, finds no entry for the just-authed
//      backend (e.g. anthropic), and refuses an Anthropic cybo with "needs
//      Anthropic — the runtime isn't connected to it" — even though `pi
//      --list-models` now shows the backend. status-only refresh never fired
//      because the entry wasn't "unavailable".
//
// `requiredBackend` (the cybo's pinned backend, when known) closes case 2: when
// it's missing from the cached model ids, force ONE refresh and re-read so the
// gate decides against fresh models. Self-bounding — an available pi whose models
// already cover the backend never triggers the refresh, and a real gap re-probes
// only per spawn ATTEMPT (user-initiated, so there's no loop).
export async function reprobePiBeforeSpawn(
  manager: RefreshAndList,
  requiredBackend?: string | null,
  logger?: Logger | null,
): Promise<PiEntry | null> {
  const read = async (wait: boolean): Promise<PiEntry | null> =>
    (await manager.listProviders({ wait, providers: ["pi"] })).find(
      (entry) => entry.provider === "pi",
    ) ?? null;
  const pi = await read(true);
  if (!pi || pi.status === "unavailable") {
    await refreshPiHomeSnapshot(manager, logger);
    return read(false);
  }
  // Case 2: ready, but the cached models don't list the backend this cybo needs.
  // findBackendGap is the same verdict the spawn gate uses, so we refresh exactly
  // when (and only when) the gate would otherwise wrongly refuse on stale models.
  const gap = findBackendGap(
    (pi.models ?? []).map((m) => m.id),
    requiredBackend ?? null,
  );
  if (gap) {
    await refreshPiHomeSnapshot(manager, logger);
    return read(false);
  }
  return pi;
}

// On-demand full re-check (Settings → Daemon → "Re-check providers"): refresh the
// home-cwd snapshot for ALL providers and return the settled statuses. The user-
// facing self-repair for the same stickiness, without restarting the daemon.
export async function recheckProviders(
  manager: RefreshAndList | null,
  logger?: Logger | null,
): Promise<{ provider: string; status: string }[]> {
  if (!manager) return [];
  try {
    await manager.refreshSnapshotForCwd({ cwd: homedir() });
  } catch (err) {
    // Best-effort: still answer with the current snapshot so the UI shows truth.
    logger?.error({ err }, "[cybo] provider re-check refresh failed");
  }
  const entries = await manager.listProviders({});
  return entries.map((entry) => ({ provider: entry.provider, status: entry.status }));
}
