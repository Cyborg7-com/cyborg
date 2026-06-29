import { describe, expect, it } from "vitest";
import type { SavedAuth } from "./login.js";
import { buildCyborgStatus } from "./status.js";

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

function rowValue(result: ReturnType<typeof buildCyborgStatus>, key: string): string {
  return result.data.find((r) => r.key === key)?.value ?? "";
}

describe("buildCyborgStatus", () => {
  it("reports logged-in user and a reachable daemon", () => {
    const result = buildCyborgStatus({
      auth: makeAuth(),
      configPath: "/home/u/.cyborg/auth.json",
      daemonHost: "localhost:6767",
      daemonReachable: true,
    });
    expect(rowValue(result, "Logged in")).toBe("yes");
    expect(rowValue(result, "Email")).toBe("rod@example.com");
    expect(rowValue(result, "User ID")).toBe("user_abc");
    expect(rowValue(result, "Relay")).toBe("https://relay.cyborg7.com");
    expect(rowValue(result, "Daemon")).toBe("reachable (localhost:6767)");
  });

  it("reports not-logged-in and an unreachable daemon clearly", () => {
    const result = buildCyborgStatus({
      auth: null,
      configPath: "/home/u/.cyborg/auth.json",
      daemonHost: "localhost:6767",
      daemonReachable: false,
    });
    expect(rowValue(result, "Logged in")).toBe("no");
    expect(rowValue(result, "Email")).toBe("-");
    expect(rowValue(result, "Daemon")).toBe("unreachable (localhost:6767)");
  });
});
