import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearNativeHarnessLoginCache,
  isNativeHarnessProvider,
  probeNativeHarnessLogin,
} from "./native-harness-login.js";

// A minimal env with NO credential env vars so file/keychain detection is the
// only signal under test. Keychain is skipped (skipKeychain) for determinism —
// these tests run cross-platform in CI where the macOS Keychain is absent.
function bareEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

describe("isNativeHarnessProvider", () => {
  it("recognizes the native harnesses and nothing else", () => {
    expect(isNativeHarnessProvider("claude")).toBe(true);
    expect(isNativeHarnessProvider("codex")).toBe(true);
    expect(isNativeHarnessProvider("pi")).toBe(false);
    expect(isNativeHarnessProvider("opencode-go")).toBe(false);
  });
});

describe("probeNativeHarnessLogin — claude", () => {
  let root: string;
  let configDir: string;
  beforeEach(() => {
    clearNativeHarnessLoginCache();
    root = mkdtempSync(join(tmpdir(), "native-login-claude-"));
    configDir = join(root, ".claude");
    mkdirSync(configDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function probe(env: Record<string, string> = {}) {
    return probeNativeHarnessLogin("claude", {
      env: bareEnv({ CLAUDE_CONFIG_DIR: configDir, ...env }),
      platform: "linux",
      skipKeychain: true,
    });
  }

  it("logged_in via ANTHROPIC_API_KEY env", async () => {
    expect((await probe({ ANTHROPIC_API_KEY: "sk-ant-xxx" })).state).toBe("logged_in");
  });

  it("logged_in via CLAUDE_CODE_OAUTH_TOKEN env", async () => {
    expect((await probe({ CLAUDE_CODE_OAUTH_TOKEN: "tok" })).state).toBe("logged_in");
  });

  it("logged_in via .credentials.json with a non-expired access token", async () => {
    writeFileSync(
      join(configDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "a", expiresAt: Date.now() + 3_600_000 },
      }),
    );
    expect((await probe()).state).toBe("logged_in");
  });

  it("logged_in via .credentials.json refreshToken even when access token expired", async () => {
    writeFileSync(
      join(configDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: Date.now() - 1_000 },
      }),
    );
    expect((await probe()).state).toBe("logged_in");
  });

  it("logged_out when .credentials.json access token is expired and not refreshable", async () => {
    writeFileSync(
      join(configDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "a", expiresAt: Date.now() - 1_000 } }),
    );
    const result = await probe();
    expect(result.state).toBe("logged_out");
    if (result.state === "logged_out") {
      expect(result.reason.toLowerCase()).toContain("not signed in");
    }
  });

  it("logged_in via ~/.claude.json primaryApiKey (HOME-resolved)", async () => {
    // .claude.json lives in the real home; point HOME at the temp root.
    writeFileSync(join(root, ".claude.json"), JSON.stringify({ primaryApiKey: "sk-managed" }));
    const result = await probeNativeHarnessLogin("claude", {
      env: bareEnv({ CLAUDE_CONFIG_DIR: configDir, HOME: root }),
      platform: "linux",
      skipKeychain: true,
    });
    expect(result.state).toBe("logged_in");
  });

  it("logged_out when binary present but no creds anywhere (the bug's scenario)", async () => {
    const result = await probe();
    expect(result.state).toBe("logged_out");
    if (result.state === "logged_out") {
      expect(result.reason).toContain("Claude");
    }
  });
});

describe("probeNativeHarnessLogin — codex", () => {
  let root: string;
  let codexHome: string;
  beforeEach(() => {
    clearNativeHarnessLoginCache();
    root = mkdtempSync(join(tmpdir(), "native-login-codex-"));
    codexHome = join(root, ".codex");
    mkdirSync(codexHome, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function probe(env: Record<string, string> = {}) {
    return probeNativeHarnessLogin("codex", {
      env: bareEnv({ CODEX_HOME: codexHome, ...env }),
      platform: "linux",
      skipKeychain: true,
    });
  }

  it("logged_in via OPENAI_API_KEY env", async () => {
    expect((await probe({ OPENAI_API_KEY: "sk-openai" })).state).toBe("logged_in");
  });

  it("logged_in via auth.json OPENAI_API_KEY", async () => {
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-x" }));
    expect((await probe()).state).toBe("logged_in");
  });

  it("logged_in via auth.json tokens.access_token", async () => {
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: "at", refresh_token: "rt" } }),
    );
    expect((await probe()).state).toBe("logged_in");
  });

  it("logged_out when binary present but auth.json absent", async () => {
    const result = await probe();
    expect(result.state).toBe("logged_out");
    if (result.state === "logged_out") {
      expect(result.reason).toContain("Codex");
    }
  });

  it("logged_out when auth.json exists but carries no usable credential", async () => {
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));
    expect((await probe()).state).toBe("logged_out");
  });
});
