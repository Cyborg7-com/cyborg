// Atomic, reversible daemon self-update orchestration (#662).
//
// The risky part of a self-update isn't the install — it's coming back up. A
// new build that won't boot, or a port the old supervisor re-grabbed on a
// crash-respawn, leaves the user with a dead daemon. So the flow is:
//   capture rollback point → apply update → clean restart → VERIFY online
//     → on failure: roll back to the captured point and restart again.
// A clean stop releases the pidlock before the new start, so there's no
// port race; verification + rollback make a bad build non-fatal.
//
// This module is the pure orchestrator — every side effect (read version,
// resolve latest, install, restart, probe, roll back) is injected, so the whole
// decision tree is unit-testable without npm/git/a real daemon.

export interface RollbackPoint {
  // "version" → reinstall this published version (global install);
  // "git" → reset the checkout to this commit (source install).
  kind: "version" | "git";
  ref: string;
}

export interface UpdateDeps {
  // The CLI/daemon version installed right now.
  currentVersion(): string;
  // The latest published version, or null when it can't be resolved (offline,
  // source checkout) — null means "can't short-circuit, attempt the update".
  latestVersion(): Promise<string | null>;
  // Capture the point to roll back to BEFORE mutating anything.
  backup(): Promise<RollbackPoint>;
  // Perform the install/pull(+build). Returns the version now installed.
  applyUpdate(): Promise<string>;
  // Clean stop → start (supervisor releases the pidlock between, so no port race).
  restart(): Promise<void>;
  // Poll the freshly-restarted daemon until it reports online (or the timeout).
  verifyOnline(timeoutMs: number): Promise<{ online: boolean; version: string | null }>;
  // Reinstall/reset to the captured point, then restart onto it.
  rollback(point: RollbackPoint): Promise<void>;
  log(step: string): void;
}

export interface UpdatePlanOptions {
  // Update + restart even when already on the latest version.
  force?: boolean;
  // How long to wait for the new daemon to come online before rolling back.
  verifyTimeoutMs?: number;
}

export type UpdateOutcome =
  | { action: "up-to-date"; version: string }
  | { action: "updated"; versionBefore: string; versionAfter: string }
  | {
      action: "rolled-back";
      versionBefore: string;
      attemptedVersion: string;
      reason: string;
    };

const DEFAULT_VERIFY_TIMEOUT_MS = 30_000;

export async function planAndRunUpdate(
  deps: UpdateDeps,
  options: UpdatePlanOptions = {},
): Promise<UpdateOutcome> {
  const versionBefore = deps.currentVersion();
  const verifyTimeoutMs = options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;

  // Short-circuit: already latest and not forced → don't touch a running daemon.
  if (!options.force) {
    const latest = await deps.latestVersion();
    if (latest && latest === versionBefore) {
      deps.log(`already on the latest version (${versionBefore})`);
      return { action: "up-to-date", version: versionBefore };
    }
  }

  // Capture the rollback point BEFORE any mutation.
  const point = await deps.backup();
  deps.log(`rollback point captured (${point.kind}: ${point.ref})`);

  const versionAfter = await deps.applyUpdate();

  // A no-op install (e.g. git pull --ff-only with nothing new) means we were
  // already current — skip the restart so we don't bounce the daemon for nothing.
  if (!options.force && versionAfter === versionBefore) {
    deps.log("install was a no-op — already up to date");
    return { action: "up-to-date", version: versionBefore };
  }

  await deps.restart();

  const verified = await deps.verifyOnline(verifyTimeoutMs);
  if (verified.online) {
    deps.log(`new daemon online (${verified.version ?? versionAfter})`);
    return { action: "updated", versionBefore, versionAfter };
  }

  // The new daemon didn't come back — roll back to the captured point and
  // restart onto it. A rollback failure is fatal (manual intervention) and
  // propagates to the caller.
  deps.log("new daemon did not come online within the timeout — rolling back");
  await deps.rollback(point);
  deps.log(`rolled back to ${point.ref}`);
  return {
    action: "rolled-back",
    versionBefore,
    attemptedVersion: versionAfter,
    reason: "the updated daemon did not come online within the timeout",
  };
}
