// "Set up Cybo on this daemon" CTA resolution (internal docs Phase 1).
//
// The embedded terminal can only run where the pty actually executes: the
// machine THIS app is running on. So the terminal CTA appears only when all
// of these hold — otherwise we degrade to showing the exact command to run on
// the daemon's machine (Phase 2 = remote PTY relay, not built yet):
//   1. desktop shell (the pty bridge exists — a plain browser has no pty),
//   2. the shown daemon is the user's OWN (setup writes that host's runtime
//      auth — doing that "for" someone else's daemon makes no sense), and
//   3. the daemon runs on THIS machine (hostname match: the daemon publishes
//      meta.host; the bridge reports the app host).

// First cybo release that ships the `login` subcommand. Older runtimes treat
// `cybo login` as a one-shot PROMPT (an AI run with "login" as the prompt!) —
// the terminal must never spawn it there (W0's #399 finding).
export const MIN_LOGIN_RUNTIME_VERSION = "0.2.6";

// Tolerant semver-triple compare: true when `version` >= MIN_LOGIN_RUNTIME_VERSION.
// Unparseable / missing versions are treated as too old (fail safe — gate on
// the update path, never spawn `cybo login` blind).
export function runtimeSupportsLogin(version: string | null | undefined): boolean {
  if (!version) return false;
  const parse = (v: string): number[] | null => {
    const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const have = parse(version);
  const min = parse(MIN_LOGIN_RUNTIME_VERSION);
  if (!have || !min) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== min[i]) return have[i] > min[i];
  }
  return true;
}

export interface SetupCyboCtaInput {
  // window.cyborg7Desktop present (utils.ts isDesktop) AND its setupTerminal
  // bridge exists (older desktop builds may lack it).
  hasTerminalBridge: boolean;
  daemon: { ownerId: string; meta?: { host?: string } | null } | undefined;
  currentUserId: string | undefined;
  // os.hostname() of the machine the app runs on (from the bridge; null in a
  // browser or while the async lookup is in flight).
  appHostname: string | null;
  cliInstalled: boolean;
  // Probed runtime version (cliStatus.version); null/undefined = unknown.
  cliVersion: string | null | undefined;
}

export type SetupCyboCta =
  // Open the embedded terminal running `cybo login` on this machine.
  | { kind: "terminal" }
  // Local own daemon but the runtime predates `cybo login` (or is unknown):
  // run the existing update RPC first, then the terminal.
  | { kind: "update-first" }
  // Show the exact command to run on the daemon's machine.
  | { kind: "command"; command: string }
  // No daemon to set up.
  | { kind: "hidden" };

export function resolveSetupCyboCta(input: SetupCyboCtaInput): SetupCyboCta {
  const { daemon } = input;
  if (!daemon) return { kind: "hidden" };

  const own = !!input.currentUserId && daemon.ownerId === input.currentUserId;
  const sameHost =
    !!input.appHostname && !!daemon.meta?.host && daemon.meta.host === input.appHostname;
  const loginReady = input.cliInstalled && runtimeSupportsLogin(input.cliVersion);

  if (input.hasTerminalBridge && own && sameHost) {
    return loginReady ? { kind: "terminal" } : { kind: "update-first" };
  }

  // Remote / foreign / browser: the user runs it themselves on that machine.
  // An old runtime needs the update first there too — `cybo login` on <0.2.6
  // fires an AI one-shot, so the install step is part of the command.
  return {
    kind: "command",
    command: loginReady ? "cybo login" : "npm i -g @cyborg7/cybo@latest && cybo login",
  };
}

// ─── Always-reachable "Connect provider" label (runtime section) ─────────────
//
// The setup CTA used to live ONLY inside the not-runnable banner, so a daemon
// already authenticated with ONE backend (e.g. opencode-go) had NO door to add
// another (anthropic for a Claude cybo) — and users looked for it in the Cybo
// runtime section (next to Check/Update) where it didn't exist. This label
// feeds that always-visible button: "Set up Cybo" when nothing is connected
// yet, "Connect provider" (+ which backends already are, from the #398
// capability meta) when adding to an existing setup.

export interface RuntimeProfileLike {
  configured: boolean;
  backends: { backend: string; modelCount: number }[];
}

export function connectProviderLabel(profile?: RuntimeProfileLike | null): {
  label: string;
  detail: string | null;
} {
  const backends =
    profile?.backends?.filter((b) => b.modelCount > 0).map((b) => b.backend) ?? [];
  if (profile?.configured && backends.length > 0) {
    return { label: "Connect provider", detail: `${backends.join(", ")} connected` };
  }
  if (profile?.configured) {
    // Configured but the breakdown isn't derivable (plain model ids).
    return { label: "Connect provider", detail: "a provider is connected" };
  }
  return { label: "Set up Cybo", detail: null };
}
