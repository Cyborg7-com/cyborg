// Native-harness LOGIN probe (internal docs — "fix the native-availability
// half-truth").
//
// THE BUG: a native harness's `isAvailable()` (Paseo
// providers/claude/agent.ts + codex-app-server-agent.ts) only verifies the
// BINARY resolves/launches — it does NOT check whether the host is LOGGED IN.
// So a daemon with `claude`/`codex` installed but signed OUT reports the native
// provider as available → a native cybo reads "Configured"/runnable → the user
// opens a chat → the FIRST TURN dies with an auth error, instead of the UI
// showing "Needs setup / Connect" upfront. This is the fact-A-vs-fact-B trap
// internal docs already fixed for the Cybo runtime, now closed for the native
// route.
//
// THE FIX (cyborg-side only — Paseo's `agent/` is untouched): a lightweight,
// READ-ONLY login check the cyborg provider surfaces consult AFTER Paseo's
// binary `isAvailable()` says yes. Installed + logged-in → available
// (unchanged). Installed + logged-OUT → a non-available status carrying the
// `not_configured` reason so the UI renders a Connect/login remedy. Binary
// absent → unavailable (unchanged, decided by Paseo upstream before we run).
//
// READ-ONLY GUARANTEE: every probe below only READS env vars + credential files
// (and, on macOS, queries — never writes — the Keychain). It NEVER writes back
// to `~/.claude` / `~/.codex`, never spawns the harness, never makes a network
// round-trip. Per internal docs we deliberately do NOT validate the token over
// the wire (an expired-but-refreshable OAuth token still counts as logged in,
// matching how the harness itself treats it); a genuinely rejected credential
// surfaces at turn time via the existing turn_failed classifier.
//
// Credential locations mirror Hermes's detection ladder (internal docs) and
// the harnesses' own conventions:
//   • Claude: ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN env →
//     $CLAUDE_CONFIG_DIR|~/.claude/.credentials.json (claudeAiOauth) →
//     ~/.claude.json primaryApiKey → (macOS) Keychain "Claude Code-credentials".
//   • Codex: OPENAI_API_KEY env → $CODEX_HOME|~/.codex/auth.json
//     (OPENAI_API_KEY or tokens.access_token).

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { resolveRealCodexHome } from "./codex-internal-home.js";

const execFileAsync = promisify(execFile);

export type NativeHarnessProvider = "claude" | "codex";

export type NativeHarnessLogin =
  | { state: "logged_in" }
  // Installed but signed out — the UI should show a Connect/login remedy.
  | { state: "logged_out"; reason: string }
  // The probe itself failed (unexpected). Treated as logged_in by callers so a
  // probe hiccup never blocks an otherwise-available, possibly-authed harness
  // (fail-open: the worst case degrades to today's binary-only behavior, and a
  // real auth gap still surfaces at turn time).
  | { state: "unknown" };

const LOGGED_OUT_REASON: Record<NativeHarnessProvider, string> = {
  claude:
    "Claude is installed on this daemon but not signed in — connect it to run native Claude cybos.",
  codex:
    "Codex is installed on this daemon but not signed in — connect it to run native Codex cybos.",
};

// Short TTL cache so repeated snapshot reads / list_providers calls in quick
// succession don't re-stat credential files (or re-query the Keychain) every
// time. A fresh `claude login` / `codex login` becomes visible within the TTL;
// the provider re-check + lazy re-probe paths already force a fresh read when
// the user explicitly asks.
const CACHE_TTL_MS = 10_000;

interface CacheEntry {
  at: number;
  value: NativeHarnessLogin;
}

const cache = new Map<NativeHarnessProvider, CacheEntry>();

function envHasValue(name: string, env: NodeJS.ProcessEnv): boolean {
  const v = env[name];
  return typeof v === "string" && v.trim().length > 0;
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

// An OAuth payload is "usable" when it has a refresh token (refreshable even if
// the access token is stale) OR a not-yet-expired access token. Matches Hermes's
// is_claude_code_token_valid (expiresAt minus a 60s buffer, OR refreshToken
// present). We never reject solely on expiry — the harness can refresh.
function claudeOAuthUsable(oauth: Record<string, unknown>): boolean {
  if (nonEmptyString(oauth.refreshToken)) return true;
  if (!nonEmptyString(oauth.accessToken)) return false;
  const expiresAt = oauth.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    // Has an access token but no parseable expiry — treat as present (the
    // harness owns expiry semantics; we don't second-guess it offline).
    return true;
  }
  return expiresAt - 60_000 > Date.now();
}

// Resolve the home directory, honoring an explicit HOME override in the passed
// env (so the probe is fully driven by `options.env` and unit-testable). Falls
// back to os.homedir() when HOME isn't set in the provided env.
function resolveHome(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.HOME;
  return typeof fromEnv === "string" && fromEnv.trim().length > 0 ? fromEnv : homedir();
}

function resolveClaudeConfigDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ?? join(resolveHome(env), ".claude");
}

// macOS only: the Keychain item Claude Code ≥2.1.114 writes. `security
// find-generic-password -s ...` (existence check only — NO `-w`) exits 0 when
// the item exists, non-zero otherwise. We deliberately omit `-w`: that flag
// requests the DECRYPTED secret, which can pop an interactive Keychain GUI
// prompt and HANG an unattended daemon. Checking item metadata is sufficient —
// "item exists" ⇒ logged_in. Short timeout so a stuck Keychain can never hang a
// snapshot read.
async function claudeKeychainHasCredentials(platform: NodeJS.Platform): Promise<boolean> {
  if (platform !== "darwin") return false;
  try {
    await execFileAsync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials"],
      {
        timeout: 2_000,
      },
    );
    return true;
  } catch {
    return false;
  }
}

export interface ProbeNativeHarnessLoginOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  // Test seam: skip the Keychain shell-out (and the cache) for determinism.
  skipKeychain?: boolean;
}

async function probeClaudeLogin(
  options: ProbeNativeHarnessLoginOptions,
): Promise<NativeHarnessLogin> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  if (envHasValue("ANTHROPIC_API_KEY", env) || envHasValue("CLAUDE_CODE_OAUTH_TOKEN", env)) {
    return { state: "logged_in" };
  }

  const configDir = resolveClaudeConfigDir(env);
  const creds = await readJsonFile(join(configDir, ".credentials.json"));
  const oauth =
    creds && typeof creds.claudeAiOauth === "object" && creds.claudeAiOauth !== null
      ? (creds.claudeAiOauth as Record<string, unknown>)
      : null;
  if (oauth && claudeOAuthUsable(oauth)) {
    return { state: "logged_in" };
  }

  // Claude's managed API key (read for presence only — never used by us).
  const dotClaude = await readJsonFile(join(resolveHome(env), ".claude.json"));
  if (dotClaude && nonEmptyString(dotClaude.primaryApiKey)) {
    return { state: "logged_in" };
  }

  if (!options.skipKeychain && (await claudeKeychainHasCredentials(platform))) {
    return { state: "logged_in" };
  }

  return { state: "logged_out", reason: LOGGED_OUT_REASON.claude };
}

async function probeCodexLogin(
  options: ProbeNativeHarnessLoginOptions,
): Promise<NativeHarnessLogin> {
  const env = options.env ?? process.env;

  if (envHasValue("OPENAI_API_KEY", env)) {
    return { state: "logged_in" };
  }

  const auth = await readJsonFile(join(resolveRealCodexHome(env), "auth.json"));
  if (auth) {
    if (nonEmptyString(auth.OPENAI_API_KEY)) {
      return { state: "logged_in" };
    }
    const tokens =
      typeof auth.tokens === "object" && auth.tokens !== null
        ? (auth.tokens as Record<string, unknown>)
        : null;
    if (tokens && (nonEmptyString(tokens.access_token) || nonEmptyString(tokens.refresh_token))) {
      return { state: "logged_in" };
    }
  }

  return { state: "logged_out", reason: LOGGED_OUT_REASON.codex };
}

// Read-only login probe for a native harness. Returns the discriminated login
// state; never throws (probe failures degrade to "unknown" → callers fail open).
export async function probeNativeHarnessLogin(
  provider: NativeHarnessProvider,
  options: ProbeNativeHarnessLoginOptions = {},
): Promise<NativeHarnessLogin> {
  const useCache = !options.env && !options.platform && !options.skipKeychain;
  if (useCache) {
    const cached = cache.get(provider);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.value;
    }
  }

  let value: NativeHarnessLogin;
  try {
    value =
      provider === "claude" ? await probeClaudeLogin(options) : await probeCodexLogin(options);
  } catch {
    value = { state: "unknown" };
  }

  if (useCache) {
    cache.set(provider, { at: Date.now(), value });
  }
  return value;
}

// Clear the cache (test hook + a seam for an explicit "re-check providers").
export function clearNativeHarnessLoginCache(): void {
  cache.clear();
}

export function isNativeHarnessProvider(provider: string): provider is NativeHarnessProvider {
  return provider === "claude" || provider === "codex";
}
