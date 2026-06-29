import { describe, it, expect } from "vitest";
import {
  buildCyboSpawnFailureOutcome,
  describeError,
  DaemonTelemetryFrameSchema,
} from "./daemon-telemetry.js";

describe("describeError", () => {
  it("extracts message + stack from an Error", () => {
    const err = new Error("No API key found for the selected model");
    const { reason, stack } = describeError(err);
    expect(reason).toBe("No API key found for the selected model");
    expect(stack).toContain("Error: No API key found");
  });

  it("stringifies a non-Error throw and has no stack", () => {
    expect(describeError("boom")).toEqual({ reason: "boom", stack: null });
  });

  it("caps an oversized reason and stack", () => {
    const err = new Error("x".repeat(5000));
    err.stack = "y".repeat(50000);
    const { reason, stack } = describeError(err);
    expect(reason.length).toBe(500);
    expect(stack?.length).toBe(4000);
  });
});

describe("buildCyboSpawnFailureOutcome", () => {
  const base = {
    err: new Error("Anthropic provider unavailable on this daemon"),
    cyboId: "cybo_123",
    cyboSlug: "researcher",
    provider: "claude",
    channelId: "chan_42",
    workspaceId: "ws_7",
    authorUserId: "user_99",
    at: 1_700_000_000_000,
  };

  it("produces a structured telemetry event with all failure context", () => {
    const { telemetry } = buildCyboSpawnFailureOutcome(base);
    expect(telemetry).toEqual({
      kind: "cybo_spawn_failure",
      cyboId: "cybo_123",
      channelId: "chan_42",
      workspaceId: "ws_7",
      provider: "claude",
      reason: "Anthropic provider unavailable on this daemon",
      stack: expect.stringContaining("Error: Anthropic provider unavailable"),
      at: 1_700_000_000_000,
    });
  });

  it("the telemetry event is a valid cyborg:telemetry frame payload", () => {
    const { telemetry } = buildCyboSpawnFailureOutcome(base);
    const frame = DaemonTelemetryFrameSchema.safeParse({
      type: "cyborg:telemetry",
      event: telemetry,
    });
    expect(frame.success).toBe(true);
  });

  it("the relay-side schema REJECTS an over-cap reason (untrusted daemon can't bloat the log)", () => {
    const { telemetry } = buildCyboSpawnFailureOutcome(base);
    const hostile = DaemonTelemetryFrameSchema.safeParse({
      type: "cyborg:telemetry",
      event: { ...telemetry, reason: "x".repeat(10_000) },
    });
    expect(hostile.success).toBe(false);
  });

  it("produces an author-only channel notice naming the cybo + the reason", () => {
    const { notice } = buildCyboSpawnFailureOutcome(base);
    expect(notice.type).toBe("cyborg:cybo_mention_notice");
    expect(notice.payload.toUserId).toBe("user_99");
    expect(notice.payload.channelId).toBe("chan_42");
    expect(notice.payload.text).toBe(
      "@researcher couldn't run: Anthropic provider unavailable on this daemon",
    );
  });

  it("falls back to a generic label when the slug is unknown", () => {
    const { notice, telemetry } = buildCyboSpawnFailureOutcome({
      ...base,
      cyboSlug: null,
      provider: null,
    });
    expect(notice.payload.text).toBe(
      "The cybo couldn't run: Anthropic provider unavailable on this daemon",
    );
    expect(telemetry.provider).toBeNull();
  });
});
