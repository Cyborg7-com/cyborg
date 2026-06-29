// Credential discovery — detect existing host logins (Claude Code, Codex CLI,
// Gemini CLI) BEFORE asking the user to sign in (internal docs). Ported from
// hermes-agent's credential-reuse logic (agent/anthropic_adapter.py,
// hermes_cli/auth.py) + AionUi's gemini detection skeleton.
//
// Read-only and defensive by contract: every on-disk/keychain payload is
// untrusted, so parsing uses runtime typeof/presence guards and falls back to
// `null` on ANY mismatch — a poisoned ~/.claude/.credentials.json yields null,
// never a half-typed credential. We never write to the host's credential files
// and never read managed API keys (~/.claude.json primaryApiKey) — only
// refreshable OAuth logins are reusable.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export type DiscoverBackend = "anthropic" | "openai" | "google";

export interface DiscoveredCredential {
  found: true;
  backend: DiscoverBackend;
  // Where the login was found, for the doctor/UI provenance line.
  source: "claude-code-keychain" | "claude-code-file" | "codex-cli" | "gemini-cli";
  // false when found but unusable (e.g. an expired Codex token with no refresh).
  // Callers offer reuse only for valid creds; doctor distinguishes the states.
  valid: boolean;
  // Epoch ms, when the backend exposes one (anthropic). Undefined otherwise.
  expiresAt?: number;
}

// ── Shared defensive helpers ────────────────────────────────────────────────

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    // Missing, unreadable, or garbage JSON → treat as "no credential".
    return null;
  }
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// Decode a JWT's claims (middle segment) defensively — {} on any malformation.
function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) return {};
  try {
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    payload += "=".repeat((4 - (payload.length % 4)) % 4);
    const json: unknown = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
    return asObject(json) ?? {};
  } catch {
    return {};
  }
}

// ── anthropic (Claude Code) ─────────────────────────────────────────────────
// Keychain (macOS ≥ Claude Code 2.1.114) → file. The file path covers Linux AND
// Windows (%USERPROFILE%\.claude\.credentials.json); honor $CLAUDE_CONFIG_DIR.
// Validity: unexpired (60s skew) OR a refreshToken present (refreshable counts).

interface ClaudeOauth {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

function parseClaudeOauth(data: Record<string, unknown>): ClaudeOauth | null {
  const oauth = asObject(data.claudeAiOauth);
  if (!oauth) return null;
  const accessToken = asNonEmptyString(oauth.accessToken);
  if (!accessToken) return null;
  const refreshToken = asNonEmptyString(oauth.refreshToken);
  const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : null;
  return { accessToken, refreshToken, expiresAt };
}

function claudeOauthValid(creds: ClaudeOauth): boolean {
  // A refreshable login stays usable even past the access-token expiry.
  if (creds.refreshToken) return true;
  if (creds.expiresAt == null) return true; // no expiry set → valid if token present (it is)
  return Date.now() < creds.expiresAt - 60_000;
}

function readClaudeKeychain(): ClaudeOauth | null {
  if (platform() !== "darwin") return null;
  let raw = "";
  try {
    const r = spawnSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 5000, encoding: "utf-8" },
    );
    if (r.error || r.status !== 0) return null;
    raw = (r.stdout ?? "").trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const data = asObject(JSON.parse(raw));
    return data ? parseClaudeOauth(data) : null;
  } catch {
    return null;
  }
}

function claudeCredentialsPath(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  const dir = override && override.length > 0 ? override : join(homedir(), ".claude");
  return join(dir, ".credentials.json");
}

function detectAnthropic(): DiscoveredCredential | null {
  const fromKeychain = readClaudeKeychain();
  if (fromKeychain) {
    return {
      found: true,
      backend: "anthropic",
      source: "claude-code-keychain",
      valid: claudeOauthValid(fromKeychain),
      expiresAt: fromKeychain.expiresAt ?? undefined,
    };
  }
  const data = readJsonFile(claudeCredentialsPath());
  const oauth = data ? parseClaudeOauth(data) : null;
  if (!oauth) return null;
  return {
    found: true,
    backend: "anthropic",
    source: "claude-code-file",
    valid: claudeOauthValid(oauth),
    expiresAt: oauth.expiresAt ?? undefined,
  };
}

// ── openai (Codex CLI) ──────────────────────────────────────────────────────
// ${CODEX_HOME:-~/.codex}/auth.json → tokens.{access_token,refresh_token}.
// Both tokens required; the access token's JWT `exp` gates validity (an expired
// token surfaces as found-but-invalid, never a false "ready" — the hermes lesson).

function codexAuthPath(): string {
  const home = process.env.CODEX_HOME?.trim();
  const base = home && home.length > 0 ? home : join(homedir(), ".codex");
  return join(base, "auth.json");
}

function detectOpenai(): DiscoveredCredential | null {
  const data = readJsonFile(codexAuthPath());
  if (!data) return null;
  const tokens = asObject(data.tokens);
  if (!tokens) return null;
  const accessToken = asNonEmptyString(tokens.access_token);
  const refreshToken = asNonEmptyString(tokens.refresh_token);
  if (!accessToken || !refreshToken) return null;
  const exp = decodeJwtClaims(accessToken).exp;
  // The access token is a JWT; we trust it only when its `exp` decodes to a
  // number. A missing/malformed exp (non-JWT or corrupt token) is reported as
  // found-but-INVALID rather than a false "ready" — the login exists (doctor
  // shows "sign in to refresh"), but reuse never offers an unconfirmable cred.
  if (typeof exp !== "number") {
    return { found: true, backend: "openai", source: "codex-cli", valid: false };
  }
  // exp is JWT seconds-since-epoch; expired (with no skew) → invalid.
  const expired = exp <= Date.now() / 1000;
  return {
    found: true,
    backend: "openai",
    source: "codex-cli",
    valid: !expired,
    expiresAt: exp * 1000,
  };
}

// ── google (Gemini CLI) ─────────────────────────────────────────────────────
// ~/.gemini/oauth_creds.json → valid if access_token OR refresh_token present
// (AionUi's check; Gemini CLI refreshes its own token, so presence ⇒ usable).

function detectGoogle(): DiscoveredCredential | null {
  const data = readJsonFile(join(homedir(), ".gemini", "oauth_creds.json"));
  if (!data) return null;
  const hasToken =
    asNonEmptyString(data.access_token) !== null || asNonEmptyString(data.refresh_token) !== null;
  if (!hasToken) return null;
  return { found: true, backend: "google", source: "gemini-cli", valid: true };
}

// Detect an existing host login for one backend. Returns null when nothing
// reusable is present. Detection is side-effect-free (it never USES a cred —
// that requires explicit user consent at the call site).
export function detectExisting(backend: DiscoverBackend): DiscoveredCredential | null {
  switch (backend) {
    case "anthropic":
      return detectAnthropic();
    case "openai":
      return detectOpenai();
    case "google":
      return detectGoogle();
    default:
      return null;
  }
}

export const DISCOVERABLE_BACKENDS: DiscoverBackend[] = ["anthropic", "openai", "google"];

export const BACKEND_LABELS: Record<DiscoverBackend, string> = {
  anthropic: "Claude",
  openai: "ChatGPT/Codex",
  google: "Gemini",
};

// Probe every known backend; returns only the ones with a host login present.
export function detectAllExisting(): DiscoveredCredential[] {
  return DISCOVERABLE_BACKENDS.map((b) => detectExisting(b)).filter(
    (c): c is DiscoveredCredential => c !== null,
  );
}
