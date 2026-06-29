// The turn-time provider failure (e.g. the Anthropic usage-gate 400 that only
// surfaces at INFERENCE time) must carry the SAME classified remedy reason the
// spawn-gate sends, so the agent chat shows "Add usage" / "Reconnect with an API
// key" instead of the raw `[System Error] 400 {…}` blob. enrichTurnFailedEvent is
// the daemon-side hook that classifies the broadcast turn_failed event.
import { describe, it, expect } from "vitest";
import { enrichTurnFailedEvent } from "./message-router.js";

// The exact live error body that triggered the bug (Anthropic usage-gate).
const USAGE_GATE_400 =
  '400 {"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage. Add more at claude.ai/settings/usage to keep using this app."}';

describe("enrichTurnFailedEvent", () => {
  it("classifies the Anthropic usage-gate 400 → usage_gated + reason", () => {
    const out = enrichTurnFailedEvent({
      type: "turn_failed",
      provider: "claude",
      error: USAGE_GATE_400,
      code: "400",
    });
    expect(out.reasonKind).toBe("usage_gated");
    expect(typeof out.unavailableReason).toBe("string");
    expect((out.unavailableReason as string).length).toBeGreaterThan(0);
    // Raw error is preserved for debugging.
    expect(out.error).toBe(USAGE_GATE_400);
    expect(out.code).toBe("400");
  });

  it("classifies a 401 / unauthorized turn failure → auth_invalid", () => {
    const out = enrichTurnFailedEvent({
      type: "turn_failed",
      provider: "claude",
      error: "401 unauthorized: invalid x-api-key",
    });
    expect(out.reasonKind).toBe("auth_invalid");
  });

  it("classifies an expired-credentials turn failure → expired", () => {
    const out = enrichTurnFailedEvent({
      type: "turn_failed",
      provider: "codex",
      error: "OAuth token has expired — please re-authenticate",
    });
    expect(out.reasonKind).toBe("expired");
  });

  it("classifies a rate-limit turn failure → rate_limited", () => {
    const out = enrichTurnFailedEvent({
      type: "turn_failed",
      provider: "claude",
      error: "429 rate_limit_error: too many requests",
    });
    expect(out.reasonKind).toBe("rate_limited");
  });

  it("falls back to the `diagnostic` field when `error` doesn't classify", () => {
    const out = enrichTurnFailedEvent({
      type: "turn_failed",
      provider: "claude",
      error: "Turn failed",
      diagnostic: USAGE_GATE_400,
    });
    expect(out.reasonKind).toBe("usage_gated");
  });

  it("leaves an UNCLASSIFIABLE turn failure untouched (UI shows raw error)", () => {
    const event = {
      type: "turn_failed",
      provider: "claude",
      error: "Something exploded in the agent loop",
    };
    const out = enrichTurnFailedEvent(event);
    expect(out.reasonKind).toBeUndefined();
    expect(out.unavailableReason).toBeUndefined();
    expect(out).toEqual(event);
  });

  it("never touches a non-turn_failed event", () => {
    const event = { type: "turn_completed", provider: "claude" };
    expect(enrichTurnFailedEvent(event)).toBe(event);
  });

  it("does not clobber an already-classified event (idempotent)", () => {
    const event = {
      type: "turn_failed",
      provider: "claude",
      error: USAGE_GATE_400,
      reasonKind: "auth_invalid",
      unavailableReason: "pre-set",
    };
    const out = enrichTurnFailedEvent(event);
    expect(out.reasonKind).toBe("auth_invalid");
    expect(out.unavailableReason).toBe("pre-set");
  });
});
