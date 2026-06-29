import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authConfigPath, readSavedAuth, type SavedAuth } from "./login.js";
import { buildWhoamiResult, runWhoamiCommand } from "./whoami.js";

function makeAuth(over: Partial<SavedAuth> = {}): SavedAuth {
  return {
    url: "https://relay.cyborg7.com",
    relayWs: "wss://relay.cyborg7.com/relay",
    token: "tok_123",
    userId: "user_abc",
    email: "rod@example.com",
    ...over,
  };
}

describe("buildWhoamiResult", () => {
  it("returns email + userId + relay from saved creds", () => {
    const result = buildWhoamiResult(makeAuth(), "/home/u/.cyborg/auth.json");
    expect(result.type).toBe("single");
    expect(result.data.email).toBe("rod@example.com");
    expect(result.data.userId).toBe("user_abc");
    expect(result.data.relayUrl).toBe("https://relay.cyborg7.com");
    expect(result.data.configPath).toBe("/home/u/.cyborg/auth.json");
  });

  it("throws a clear NOT_LOGGED_IN error when no creds", () => {
    try {
      buildWhoamiResult(null, "/home/u/.cyborg/auth.json");
      throw new Error("expected buildWhoamiResult to throw");
    } catch (e) {
      const err = e as { code?: string; message?: string };
      expect(err.code).toBe("NOT_LOGGED_IN");
      expect(err.message).toContain("cyborg login");
    }
  });
});

describe("readSavedAuth + runWhoamiCommand (filesystem)", () => {
  let home: string;
  const prev = process.env.CYBORG_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cyborg-whoami-"));
    process.env.CYBORG_HOME = home;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.CYBORG_HOME;
    else process.env.CYBORG_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });

  it("reads saved creds and prints email + userId", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(authConfigPath(), JSON.stringify(makeAuth()) + "\n");

    const auth = readSavedAuth();
    expect(auth?.email).toBe("rod@example.com");
    expect(auth?.userId).toBe("user_abc");

    const result = await runWhoamiCommand({}, {} as never);
    expect(result.data.email).toBe("rod@example.com");
    expect(result.data.userId).toBe("user_abc");
  });

  it("with no creds file → NOT_LOGGED_IN", async () => {
    expect(readSavedAuth()).toBeNull();
    await expect(runWhoamiCommand({}, {} as never)).rejects.toMatchObject({
      code: "NOT_LOGGED_IN",
    });
  });

  it("treats a malformed creds file as not logged in", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(authConfigPath(), "{ not valid json");
    expect(readSavedAuth()).toBeNull();
  });
});
