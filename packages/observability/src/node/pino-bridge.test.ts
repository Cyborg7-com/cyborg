import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachPinoBridge } from "./pino-bridge.js";
import { __resetStateForTests, getState } from "./state.js";

// reportError lives in logfire; stub it so the bridge has something to call when
// enabled, without standing up a real exporter.
const reportError = vi.fn();
vi.mock("logfire", () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));

function enable(): void {
  const state = getState();
  state.configured = true;
  state.enabled = true;
  state.globalTags = ["cyborg7", "platform:daemon", "version:1.0.0"];
  state.environment = "test";
  state.provider = null;
}

describe("attachPinoBridge", () => {
  beforeEach(() => {
    __resetStateForTests();
    reportError.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is a no-op when observability is disabled", () => {
    const logger = pino({ enabled: false });
    const errSpy = vi.spyOn(logger, "error");
    attachPinoBridge(logger);
    logger.error(new Error("boom"));
    // pino's own method still ran; nothing mirrored to logfire.
    expect(errSpy).toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("mirrors error-level records carrying an Error to logfire (level >= 50)", () => {
    enable();
    const logger = pino({ enabled: false }); // enabled:false silences output, methods still callable
    attachPinoBridge(logger);
    const err = new Error("kaboom");
    logger.error({ err, requestId: "r1" }, "request failed");
    expect(reportError).toHaveBeenCalledTimes(1);
    const [, reported, attrs] = reportError.mock.calls[0];
    expect(reported).toBe(err);
    expect((attrs as Record<string, unknown>).requestId).toBe("r1");
  });

  it("does not mirror error records that carry no Error", () => {
    enable();
    const logger = pino({ enabled: false });
    attachPinoBridge(logger);
    logger.error("just a string");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("mirrors fatal-level records too", () => {
    enable();
    const logger = pino({ enabled: false });
    attachPinoBridge(logger);
    logger.fatal(new Error("dead"));
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — re-bridging the same logger does not double-mirror", () => {
    enable();
    const logger = pino({ enabled: false });
    attachPinoBridge(logger);
    attachPinoBridge(logger);
    logger.error(new Error("once"));
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("propagates the bridge to children, attributing the child's name as scope", () => {
    enable();
    const logger = pino({ enabled: false });
    attachPinoBridge(logger);
    const child = logger.child({ name: "relay" });
    child.error(new Error("child boom"));
    expect(reportError).toHaveBeenCalledTimes(1);
    const [, , attrs] = reportError.mock.calls[0];
    expect((attrs as Record<string, unknown>).scope).toBe("relay");
  });
});
