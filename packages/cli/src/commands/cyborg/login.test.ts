import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authConfigPath, readSavedAuth, runLoginCommand, type SavedAuth } from "./login.js";

describe("runLoginCommand persists credentials", () => {
  let home: string;
  const prev = process.env.CYBORG_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cyborg-login-"));
    process.env.CYBORG_HOME = home;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.CYBORG_HOME;
    else process.env.CYBORG_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });

  it("writes email + userId + token + relayUrl into the creds file", async () => {
    await runLoginCommand(
      {
        url: "https://relay.cyborg7.com",
        token: "tok_999",
        userId: "user_xyz",
        email: "rod@example.com",
      },
      {} as never,
    );

    const raw = JSON.parse(readFileSync(authConfigPath(), "utf8")) as SavedAuth;
    expect(raw.email).toBe("rod@example.com");
    expect(raw.userId).toBe("user_xyz");
    expect(raw.token).toBe("tok_999");
    expect(raw.url).toBe("https://relay.cyborg7.com");
    expect(raw.relayWs).toBe("wss://relay.cyborg7.com/relay");

    const auth = readSavedAuth();
    expect(auth?.email).toBe("rod@example.com");
    expect(auth?.userId).toBe("user_xyz");
  });
});
