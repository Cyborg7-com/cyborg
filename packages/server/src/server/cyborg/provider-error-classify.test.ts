import { describe, it, expect } from "vitest";
import { classifyProviderError } from "./provider-error-classify.js";

describe("classifyProviderError", () => {
  it("classifies the Anthropic third-party usage gate (the real 400)", () => {
    const raw =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."}}';
    const c = classifyProviderError(raw);
    expect(c.kind).toBe("usage_gated");
    expect(c.reason.toLowerCase()).toContain("add usage");
  });

  it("classifies unauthorized / invalid credentials", () => {
    expect(classifyProviderError("401 Unauthorized").kind).toBe("auth_invalid");
    expect(classifyProviderError("invalid x-api-key").kind).toBe("auth_invalid");
    expect(classifyProviderError("authentication_error: bad key").kind).toBe("auth_invalid");
  });

  it("classifies expired credentials", () => {
    expect(classifyProviderError("OAuth token has expired").kind).toBe("expired");
    expect(classifyProviderError("Please reauthenticate").kind).toBe("expired");
  });

  it("classifies missing configuration", () => {
    expect(classifyProviderError("not configured").kind).toBe("not_configured");
    expect(classifyProviderError("(empty)").kind).toBe("not_configured");
    expect(classifyProviderError("No credentials found").kind).toBe("not_configured");
  });

  it("classifies rate limiting / overload", () => {
    expect(classifyProviderError("429 rate limit exceeded").kind).toBe("rate_limited");
    expect(classifyProviderError("Overloaded").kind).toBe("rate_limited");
  });

  it("falls back to unknown but preserves the raw text", () => {
    const c = classifyProviderError("some weird provider failure xyz");
    expect(c.kind).toBe("unknown");
    expect(c.reason).toContain("weird provider failure");
  });

  it("handles empty / null input without throwing", () => {
    expect(classifyProviderError("").kind).toBe("unknown");
    expect(classifyProviderError(null).kind).toBe("unknown");
    expect(classifyProviderError(undefined).kind).toBe("unknown");
  });

  it("truncates very long unknown text", () => {
    const c = classifyProviderError("x".repeat(500));
    expect(c.reason.length).toBeLessThanOrEqual(240);
    expect(c.reason.endsWith("…")).toBe(true);
  });
});
