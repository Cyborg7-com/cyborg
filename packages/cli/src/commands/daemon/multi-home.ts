// Shared multi-home target resolution for stop/restart/status/doctor (#665).
// Ties the running-daemon registry + the default home + a liveness probe into a
// single call the commands use instead of blindly assuming ~/.paseo.
import { resolvePaseoHome } from "@getpaseo/server";
import { resolveLocalDaemonState } from "./local-daemon.js";
import { listRunningDaemonHomes, resolveTargetHome } from "./daemon-registry.js";
import type { CommandError } from "../../output/index.js";

export interface ResolvedTargetHome {
  // The home to operate on (undefined keeps the callee's own default resolution
  // for the explicit-home path, where we pass it straight through).
  home?: string;
  // Human note when the home was inferred (not the default) — surfaced so the
  // user sees the command didn't act on ~/.paseo.
  note?: string;
}

// Resolve which home a command should act on. Throws a CommandError (caught by
// withOutput) when several daemons are running and none was specified.
export function resolveTargetHomeForCommand(explicitHome?: string): ResolvedTargetHome {
  if (explicitHome) return { home: explicitHome };

  const defaultHome = resolvePaseoHome();
  const runningHomes = listRunningDaemonHomes((home) => resolveLocalDaemonState({ home }).running);
  const resolution = resolveTargetHome({ defaultHome, runningHomes });

  if (resolution.reason === "ambiguous") {
    const error: CommandError = {
      code: "DAEMON_HOME_AMBIGUOUS",
      message:
        "Multiple daemons are running — pass --home <path> to choose one. " +
        `Running: ${resolution.candidates.join(", ")}`,
    };
    throw error;
  }

  if (resolution.reason === "inferred" && resolution.home) {
    return {
      home: resolution.home,
      note: `No daemon at the default home (${defaultHome}); operating on the running daemon at ${resolution.home}. Pass --home to override.`,
    };
  }

  // default-running or default-fallback → use the default (home undefined lets
  // the callee resolve it exactly as before; back-compat).
  return {};
}
