import { describe, expect, it } from "vitest";
import { CLAUDE_USAGE_URL, providerRemedy } from "./provider-remedy.js";

describe("providerRemedy", () => {
  it("usage_gated → add-usage URL + reconnect-with-key, body uses the daemon reason", () => {
    const r = providerRemedy("usage_gated", "Claude", "Add usage to keep going");
    expect(r.title).toBe("Claude is connected but your plan is rejecting requests");
    expect(r.body).toBe("Add usage to keep going");
    expect(r.actions).toEqual([
      { label: "Add usage", kind: "open_url", url: CLAUDE_USAGE_URL },
      { label: "Reconnect with an API key", kind: "reconnect_api_key" },
    ]);
  });

  it("auth_invalid → reconnect + use-an-api-key", () => {
    const r = providerRemedy("auth_invalid", "Claude");
    expect(r.title).toBe("Reconnect Claude");
    expect(r.actions.map((a) => a.kind)).toEqual(["reconnect", "reconnect_api_key"]);
  });

  it("expired → reconnect + use-an-api-key (same shape as auth_invalid)", () => {
    const r = providerRemedy("expired", "Claude");
    expect(r.title).toBe("Reconnect Claude");
    expect(r.actions.map((a) => a.kind)).toEqual(["reconnect", "reconnect_api_key"]);
  });

  it("not_configured → single connect action", () => {
    const r = providerRemedy("not_configured", "Codex");
    expect(r.title).toBe("Connect Codex");
    expect(r.actions).toEqual([{ label: "Connect", kind: "setup" }]);
  });

  it("rate_limited → re-check only", () => {
    const r = providerRemedy("rate_limited", "Claude");
    expect(r.title).toBe("Rate-limited — try again shortly");
    expect(r.actions).toEqual([{ label: "Re-check", kind: "recheck" }]);
  });

  it("unknown → shows the raw reason as the title, recheck + reconnect + api-key", () => {
    const r = providerRemedy("unknown", "Claude", "weird upstream 500");
    expect(r.title).toBe("weird upstream 500");
    expect(r.actions.map((a) => a.kind)).toEqual(["recheck", "reconnect", "reconnect_api_key"]);
  });

  it("null reasonKind falls back to the unknown shape", () => {
    const r = providerRemedy(null, "Claude");
    expect(r.actions.map((a) => a.kind)).toEqual(["recheck", "reconnect", "reconnect_api_key"]);
  });

  it("falls back to a generic body when the daemon gives no reason", () => {
    const r = providerRemedy("usage_gated", "Claude");
    expect(r.body.length).toBeGreaterThan(0);
    expect(r.body).toContain("Claude");
  });

  it("blank provider label degrades to 'this provider'", () => {
    const r = providerRemedy("not_configured", "");
    expect(r.title).toBe("Connect this provider");
  });
});
