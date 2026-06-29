import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  BASE_BACKOFF_MS,
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  backoffMs,
  buildEventPayload,
  decideRetry,
  generateWebhookSecret,
  hashWebhookSecret,
  isEventEnabled,
  newOutgoingWebhookId,
  normalizeEventFlags,
  signBody,
  validateWebhookUrl,
  verifySignature,
} from "./outgoing-webhook-delivery.js";

describe("event flags", () => {
  it("isEventEnabled is strict-true (absent/false → not delivered)", () => {
    expect(isEventEnabled({ "message.created": true }, "message.created")).toBe(true);
    expect(isEventEnabled({ "message.created": true }, "message.updated")).toBe(false);
    expect(isEventEnabled({ "message.updated": false }, "message.updated")).toBe(false);
    expect(isEventEnabled(null, "message.created")).toBe(false);
    expect(isEventEnabled(undefined, "message.deleted")).toBe(false);
  });

  it("normalizeEventFlags coerces known keys to booleans and drops the rest", () => {
    expect(
      normalizeEventFlags({
        "message.created": true,
        "message.updated": "yes", // non-true → false
        "message.deleted": 1, // non-true → false
        injected: true, // unknown key dropped
      }),
    ).toEqual({
      "message.created": true,
      "message.updated": false,
      "message.deleted": false,
    });
  });

  it("normalizeEventFlags returns an empty object for non-objects", () => {
    expect(normalizeEventFlags(null)).toEqual({});
    expect(normalizeEventFlags("nope")).toEqual({});
    expect(normalizeEventFlags(42)).toEqual({});
  });
});

describe("secret generation + hashing (mcp/token model)", () => {
  it("generates a prefixed raw secret and stores only its sha256 hash", () => {
    const { raw, hash } = generateWebhookSecret();
    expect(raw.startsWith("cybo_whsec_")).toBe(true);
    // The hash is the sha256 hex of the raw — reproducible, and NOT the raw.
    expect(hash).toBe(hashWebhookSecret(raw));
    expect(hash).not.toBe(raw);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("each generated secret is unique", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });

  it("newOutgoingWebhookId is prefixed + unique", () => {
    const id = newOutgoingWebhookId();
    expect(id.startsWith("owh_")).toBe(true);
    expect(newOutgoingWebhookId()).not.toBe(id);
  });
});

describe("HMAC signing", () => {
  it("signs body as sha256=<hex(HMAC-SHA256(hash, body))>", () => {
    const hash = "a".repeat(64);
    const body = JSON.stringify({ hello: "world" });
    const expected = `sha256=${createHmac("sha256", hash).update(body).digest("hex")}`;
    expect(signBody(hash, body)).toBe(expected);
  });

  it("a different body or key yields a different signature", () => {
    const hash = "a".repeat(64);
    expect(signBody(hash, "a")).not.toBe(signBody(hash, "b"));
    expect(signBody("a".repeat(64), "x")).not.toBe(signBody("b".repeat(64), "x"));
  });

  it("verifySignature accepts the matching signature and rejects tampering", () => {
    const hash = "deadbeef".repeat(8);
    const body = JSON.stringify({ event: "message.created" });
    const sig = signBody(hash, body);
    expect(verifySignature(hash, body, sig)).toBe(true);
    // Wrong body, wrong key, missing header, truncated sig → all false.
    expect(verifySignature(hash, `${body} `, sig)).toBe(false);
    expect(verifySignature("0".repeat(64), body, sig)).toBe(false);
    expect(verifySignature(hash, body, undefined)).toBe(false);
    expect(verifySignature(hash, body, sig.slice(0, -1))).toBe(false);
  });
});

describe("backoff + retry decision", () => {
  it("backoffMs grows exponentially from the base and caps at the ceiling", () => {
    // rand=1 → the full window (no jitter shrink), so we read the ceiling.
    const one = () => 1;
    expect(backoffMs(1, one)).toBe(BASE_BACKOFF_MS); // 2^0 * base
    expect(backoffMs(2, one)).toBe(BASE_BACKOFF_MS * 2);
    expect(backoffMs(3, one)).toBe(BASE_BACKOFF_MS * 4);
    // Far out → clamped to MAX_BACKOFF_MS, never larger.
    expect(backoffMs(20, one)).toBe(MAX_BACKOFF_MS);
  });

  it("backoffMs applies full jitter in [0, window)", () => {
    expect(backoffMs(1, () => 0)).toBe(0); // rand=0 → no wait
    // A mid sample is strictly below the window.
    expect(backoffMs(1, () => 0.5)).toBeLessThan(BASE_BACKOFF_MS);
    expect(backoffMs(1, () => 0.5)).toBeGreaterThanOrEqual(0);
  });

  it("decideRetry schedules a future retry until the cap, then dead-letters", () => {
    const now = 1_000_000;
    const r1 = decideRetry(1, now, () => 1);
    expect(r1.willRetry).toBe(true);
    expect(r1.nextRetryAt).toBe(now + BASE_BACKOFF_MS);

    // At the cap (attempt === MAX_ATTEMPTS) the row is dead-lettered.
    const capped = decideRetry(MAX_ATTEMPTS, now);
    expect(capped.willRetry).toBe(false);
    expect(capped.nextRetryAt).toBeNull();

    // And beyond the cap, still dead-lettered.
    expect(decideRetry(MAX_ATTEMPTS + 1, now).willRetry).toBe(false);
  });
});

describe("event payload shape", () => {
  it("builds a created event with the full message fields", () => {
    const created = 1_700_000_000_000;
    const payload = buildEventPayload({
      eventType: "message.created",
      workspaceId: "ws1",
      channelId: "ch1",
      messageId: "m1",
      text: "hi",
      fromId: "u1",
      fromName: "Ada",
      createdAt: created,
      firedAt: created,
    });
    expect(payload).toEqual({
      event: "message.created",
      workspace_id: "ws1",
      delivered_at: new Date(created).toISOString(),
      data: {
        id: "m1",
        channel_id: "ch1",
        text: "hi",
        from_id: "u1",
        from_name: "Ada",
        created_at: new Date(created).toISOString(),
      },
    });
  });

  it("a deleted event carries only the ids (no text/author leak)", () => {
    const payload = buildEventPayload({
      eventType: "message.deleted",
      workspaceId: "ws1",
      channelId: "ch1",
      messageId: "m1",
      // These must be ignored for a delete.
      text: "secret",
      fromId: "u1",
      fromName: "Ada",
      firedAt: 0,
    });
    expect(payload.data).toEqual({ id: "m1", channel_id: "ch1" });
    expect(JSON.stringify(payload)).not.toContain("secret");
  });
});

describe("validateWebhookUrl", () => {
  it("accepts a public https URL", () => {
    expect(validateWebhookUrl("https://hooks.example.com/abc")).toBeNull();
  });

  it("rejects non-https schemes", () => {
    expect(validateWebhookUrl("http://example.com")).toMatch(/https/);
    expect(validateWebhookUrl("ftp://example.com")).toMatch(/https/);
    expect(validateWebhookUrl("not a url")).toBeTruthy();
  });

  it("rejects private/loopback/metadata literals and internal names", () => {
    expect(validateWebhookUrl("https://127.0.0.1/x")).toMatch(/private|internal/);
    expect(validateWebhookUrl("https://169.254.169.254/latest/")).toMatch(/private|internal/);
    expect(validateWebhookUrl("https://10.0.0.5/x")).toMatch(/private|internal/);
    expect(validateWebhookUrl("https://localhost/x")).toMatch(/private|internal/);
    expect(validateWebhookUrl("https://svc.internal/x")).toMatch(/private|internal/);
  });
});
