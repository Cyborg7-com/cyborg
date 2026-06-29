import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureObservability, createSpanProcessor } from "./config.js";
import { logError } from "./errors.js";
import { getScopedLogger, mergeScopeTags } from "./logger.js";
import { flush, shutdown } from "./lifecycle.js";
import { withSpan } from "./span.js";
import { __resetStateForTests, getState, OTEL_SCOPE } from "./state.js";

describe("@cyborg7/observability/node — no-op gate (no LOGFIRE_TOKEN)", () => {
  beforeEach(() => {
    __resetStateForTests();
    delete process.env.LOGFIRE_TOKEN;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("configureObservability stays disabled and never creates a provider", () => {
    configureObservability({ platform: "daemon", version: "1.2.3" });
    const state = getState();
    expect(state.configured).toBe(true);
    expect(state.enabled).toBe(false);
    expect(state.provider).toBeNull();
  });

  it("getScopedLogger returns a no-op logger whose methods never throw", () => {
    configureObservability({ platform: "daemon", version: "1.2.3" });
    const log = getScopedLogger("agent_factory", ["model:gpt-4"]);
    expect(() => {
      log.trace("t");
      log.debug("d");
      log.info("i", { a: 1 });
      log.notice("n");
      log.warning("w");
      log.error("e");
      log.fatal("f");
    }).not.toThrow();
  });

  it("logError is a silent no-op and never throws", () => {
    configureObservability({ platform: "cli", version: "0.0.1" });
    expect(() => logError("scope", new Error("boom"), { k: "v" })).not.toThrow();
  });

  it("withSpan runs the callback against a noop span when disabled", async () => {
    configureObservability({ platform: "relay", version: "9.9.9" });
    const result = await withSpan("op", { foo: "bar", skip: undefined }, async (span) => {
      span.setAttributes({ x: 1 });
      return 42;
    });
    expect(result).toBe(42);
  });

  it("flush/shutdown are no-ops when there is no provider", async () => {
    configureObservability({ platform: "daemon", version: "1.0.0" });
    await expect(flush()).resolves.toBeUndefined();
    await expect(shutdown()).resolves.toBeUndefined();
  });

  it("is idempotent — a second configure call does not flip state", () => {
    configureObservability({ platform: "daemon", version: "1.0.0" });
    // Even if a token appears later, the guard prevents re-configuration.
    process.env.LOGFIRE_TOKEN = "tok_xxx";
    configureObservability({ platform: "daemon", version: "2.0.0" });
    expect(getState().enabled).toBe(false);
    delete process.env.LOGFIRE_TOKEN;
  });
});

describe("getScopedLogger tag merging", () => {
  it("merges global + scope + per-call tags, de-duplicated and order-stable", () => {
    const global = [OTEL_SCOPE, "platform:daemon", "version:1.2.3"];
    const merged = mergeScopeTags(global, "agent_factory", ["model:gpt-4", "platform:daemon"]);
    expect(merged).toEqual([
      "cyborg7",
      "platform:daemon",
      "version:1.2.3",
      "scope:agent_factory",
      "model:gpt-4",
    ]);
  });

  it("works with no per-call tags", () => {
    const merged = mergeScopeTags(["cyborg7"], "audit", undefined);
    expect(merged).toEqual(["cyborg7", "scope:audit"]);
  });
});

describe("createSpanProcessor — picks the processor by platform lifetime", () => {
  const exporter = new OTLPTraceExporter({ url: "http://localhost/v1/traces" });

  it("uses SimpleSpanProcessor for the short-lived CLI (flushes on exit)", () => {
    expect(createSpanProcessor("cli", exporter)).toBeInstanceOf(SimpleSpanProcessor);
  });

  it("uses BatchSpanProcessor for long-running platforms (daemon, relay, desktop)", () => {
    for (const platform of ["daemon", "relay", "desktop"]) {
      expect(createSpanProcessor(platform, exporter)).toBeInstanceOf(BatchSpanProcessor);
    }
  });
});
