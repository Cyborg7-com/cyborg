import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectExisting, detectAllExisting } from "./credential-discovery.js";

// Drive detection off a throwaway HOME with fixture credential files. On Linux
// (the test platform) os.homedir() honors $HOME and the macOS keychain branch
// is skipped, so the file path is exercised directly — which is exactly the
// "non-Darwin uses the file, not the keychain" assertion.
let home: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function writeJson(path: string, body: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
}

// A codex access token is a JWT; only its `exp` claim is read. Build a minimal
// one with the given expiry (seconds since epoch).
function codexJwt(expSeconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/=/g, "");
  return `${b64({ alg: "none" })}.${b64({ exp: expSeconds })}.sig`;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cybo-cred-"));
  setEnv("HOME", home);
  setEnv("USERPROFILE", home);
  setEnv("CLAUDE_CONFIG_DIR", undefined);
  setEnv("CODEX_HOME", undefined);
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
  rmSync(home, { recursive: true, force: true });
});

describe("detectExisting — anthropic (Claude Code)", () => {
  it("finds a valid unexpired login from the credentials file", () => {
    writeJson(join(home, ".claude", ".credentials.json"), {
      claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + 3_600_000 },
    });
    const c = detectExisting("anthropic");
    expect(c).toMatchObject({
      found: true,
      backend: "anthropic",
      source: "claude-code-file",
      valid: true,
    });
  });

  it("counts an expired token as valid when a refreshToken is present (refreshable)", () => {
    writeJson(join(home, ".claude", ".credentials.json"), {
      claudeAiOauth: { accessToken: "tok", refreshToken: "ref", expiresAt: Date.now() - 1000 },
    });
    expect(detectExisting("anthropic")?.valid).toBe(true);
  });

  it("marks an expired token with NO refreshToken invalid", () => {
    writeJson(join(home, ".claude", ".credentials.json"), {
      claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() - 1000 },
    });
    expect(detectExisting("anthropic")?.valid).toBe(false);
  });

  it("honors CLAUDE_CONFIG_DIR for the file location", () => {
    const dir = join(home, "custom-claude");
    setEnv("CLAUDE_CONFIG_DIR", dir);
    writeJson(join(dir, ".credentials.json"), {
      claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + 3_600_000 },
    });
    expect(detectExisting("anthropic")?.found).toBe(true);
  });

  it("returns null when no credentials file exists", () => {
    expect(detectExisting("anthropic")).toBeNull();
  });

  it("returns null for a managed-key-only file (no claudeAiOauth)", () => {
    writeJson(join(home, ".claude", ".credentials.json"), { primaryApiKey: "sk-managed" });
    expect(detectExisting("anthropic")).toBeNull();
  });
});

describe("detectExisting — openai (Codex CLI)", () => {
  it("finds a valid login when the JWT is unexpired and both tokens present", () => {
    writeJson(join(home, ".codex", "auth.json"), {
      tokens: { access_token: codexJwt(Date.now() / 1000 + 3600), refresh_token: "ref" },
    });
    const c = detectExisting("openai");
    expect(c).toMatchObject({ found: true, source: "codex-cli", valid: true });
  });

  it("marks an EXPIRED JWT invalid (no false 'ready')", () => {
    writeJson(join(home, ".codex", "auth.json"), {
      tokens: { access_token: codexJwt(Date.now() / 1000 - 3600), refresh_token: "ref" },
    });
    expect(detectExisting("openai")?.valid).toBe(false);
  });

  it("returns null when a token is missing", () => {
    writeJson(join(home, ".codex", "auth.json"), { tokens: { access_token: "x" } });
    expect(detectExisting("openai")).toBeNull();
  });

  it("reports found-but-invalid when the access token isn't a decodable JWT (no false 'ready')", () => {
    // Both tokens present, but the access token has no decodable exp claim.
    writeJson(join(home, ".codex", "auth.json"), {
      tokens: { access_token: "not-a-jwt", refresh_token: "ref" },
    });
    const c = detectExisting("openai");
    expect(c).toMatchObject({ found: true, source: "codex-cli", valid: false });
    expect(c?.expiresAt).toBeUndefined();
  });

  it("honors CODEX_HOME", () => {
    const dir = join(home, "custom-codex");
    setEnv("CODEX_HOME", dir);
    writeJson(join(dir, "auth.json"), {
      tokens: { access_token: codexJwt(Date.now() / 1000 + 3600), refresh_token: "ref" },
    });
    expect(detectExisting("openai")?.found).toBe(true);
  });
});

describe("detectExisting — google (Gemini CLI)", () => {
  it("finds a login with an access_token", () => {
    writeJson(join(home, ".gemini", "oauth_creds.json"), { access_token: "tok" });
    expect(detectExisting("google")).toMatchObject({
      found: true,
      source: "gemini-cli",
      valid: true,
    });
  });

  it("finds a login with only a refresh_token", () => {
    writeJson(join(home, ".gemini", "oauth_creds.json"), { refresh_token: "ref" });
    expect(detectExisting("google")?.found).toBe(true);
  });

  it("returns null for an empty credentials object", () => {
    writeJson(join(home, ".gemini", "oauth_creds.json"), {});
    expect(detectExisting("google")).toBeNull();
  });
});

describe("detectExisting — defensive parsing (#596)", () => {
  it("returns null on malformed JSON instead of a half-typed credential", () => {
    writeJson(join(home, ".claude", ".credentials.json"), "{ this is not json");
    expect(detectExisting("anthropic")).toBeNull();
  });

  it("returns null when claudeAiOauth is the wrong type", () => {
    writeJson(join(home, ".claude", ".credentials.json"), { claudeAiOauth: "nope" });
    expect(detectExisting("anthropic")).toBeNull();
  });

  it("returns null when codex tokens is an array, not an object", () => {
    writeJson(join(home, ".codex", "auth.json"), { tokens: ["a", "b"] });
    expect(detectExisting("openai")).toBeNull();
  });
});

describe("detectAllExisting", () => {
  it("returns only the backends with a host login present", () => {
    writeJson(join(home, ".claude", ".credentials.json"), {
      claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + 3_600_000 },
    });
    writeJson(join(home, ".gemini", "oauth_creds.json"), { access_token: "tok" });
    const found = detectAllExisting()
      .map((c) => c.backend)
      .sort();
    expect(found).toEqual(["anthropic", "google"]);
  });

  it("returns [] when no host logins exist", () => {
    expect(detectAllExisting()).toEqual([]);
  });
});
