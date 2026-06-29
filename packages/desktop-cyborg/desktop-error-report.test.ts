import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CLIENT_LOG_PATH,
  CLOUD_RELAY_WS_URL,
  httpBaseFromWsUrl,
  toMainErrorPayload,
} from "./desktop-error-report.js";

// ─── httpBaseFromWsUrl: ws(s)://host[/api/ws] → http(s)://host ───────────────

test("wss + /api/ws → https origin (the cloud default)", () => {
  assert.equal(httpBaseFromWsUrl(CLOUD_RELAY_WS_URL), "https://relay.cyborg7.com");
});

test("ws + /ws → http origin (local dev relay)", () => {
  assert.equal(httpBaseFromWsUrl("ws://localhost:9100/ws"), "http://localhost:9100");
});

test("trailing slash after /api/ws is stripped", () => {
  assert.equal(httpBaseFromWsUrl("wss://host.example/api/ws/"), "https://host.example");
});

test("bare wss host with no path", () => {
  assert.equal(httpBaseFromWsUrl("wss://host.example"), "https://host.example");
});

test("CLIENT_LOG_PATH composes the full beacon URL", () => {
  assert.equal(
    `${httpBaseFromWsUrl(CLOUD_RELAY_WS_URL)}${CLIENT_LOG_PATH}`,
    "https://relay.cyborg7.com/api/cyborg/client-log",
  );
});

// ─── toMainErrorPayload: normalize a thrown value → relay client-log payload ──

test("real Error preserves message + stack, tags source/kind", () => {
  const err = new Error("boom");
  const p = toMainErrorPayload("desktop.main", err, "uncaughtException");
  assert.equal(p.source, "desktop.main");
  assert.equal(p.message, "boom");
  assert.equal(p.kind, "uncaughtException");
  assert.ok(typeof p.stack === "string" && p.stack.includes("boom"));
});

test("non-Error value is wrapped (String coercion), stack present", () => {
  const p = toMainErrorPayload("desktop.main", "just a string", "unhandledRejection");
  assert.equal(p.message, "just a string");
  assert.equal(p.kind, "unhandledRejection");
  assert.equal(typeof p.stack, "string"); // wrapped Error has a stack
});

test("Error with empty message falls back to a source-named message", () => {
  const p = toMainErrorPayload("desktop.renderer", new Error(""), "log");
  assert.equal(p.message, "error in desktop.renderer");
});

test("null/undefined value does not throw and yields a payload", () => {
  const p = toMainErrorPayload("desktop.main", undefined, "uncaughtException");
  assert.equal(p.source, "desktop.main");
  assert.ok(p.message.length > 0);
});
