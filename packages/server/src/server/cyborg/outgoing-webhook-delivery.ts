import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { isBlockedHost } from "./secure-fetch.js";

// Pure, side-effect-free helpers for outgoing-webhook delivery (#598). Kept
// separate from the runner (webhook-delivery-runner.ts) so the signing, backoff,
// retry-decision, and payload-shape logic is unit-testable without a DB or a
// network. The runner composes these with PgSync + secureFetch.

// ─── URL validation (create/update time) ─────────────────────────────────────

// Cheap synchronous check that a destination URL is acceptable to STORE: https
// only + not a literal private/loopback/metadata host. The authoritative guard
// (incl. DNS-resolution + redirect re-check) still runs in secureFetch at every
// DELIVERY — a stored public name could resolve to a private IP later — but
// rejecting an obviously-internal URL at create time gives the user an immediate,
// legible error instead of a silently-failing webhook. Returns null when OK, or a
// short human reason when the URL must be refused.
export function validateWebhookUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "Enter a valid URL.";
  }
  if (parsed.protocol !== "https:") return "Webhook URL must use https.";
  if (isBlockedHost(parsed.hostname)) {
    return "Webhook URL can't point to a private or internal address.";
  }
  return null;
}

// ─── Event types ─────────────────────────────────────────────────────────────

export const WEBHOOK_EVENT_TYPES = [
  "message.created",
  "message.updated",
  "message.deleted",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface WebhookEventFlags {
  "message.created"?: boolean;
  "message.updated"?: boolean;
  "message.deleted"?: boolean;
}

// True when the webhook is configured to deliver this event type. An absent flag
// is treated as false (opt-in per event).
export function isEventEnabled(
  flags: WebhookEventFlags | null | undefined,
  type: WebhookEventType,
): boolean {
  return flags?.[type] === true;
}

// Normalize an arbitrary (untrusted) flags object to the closed set, coercing
// each known key to a boolean and dropping anything else. Used when accepting an
// `events` patch from a client.
export function normalizeEventFlags(input: unknown): WebhookEventFlags {
  const out: WebhookEventFlags = {};
  if (input && typeof input === "object") {
    const rec = input as Record<string, unknown>;
    for (const k of WEBHOOK_EVENT_TYPES) {
      if (k in rec) out[k] = rec[k] === true;
    }
  }
  return out;
}

// ─── Secret generation + hashing (mcp/token.js model) ────────────────────────

const SECRET_PREFIX = "cybo_whsec";

export interface GeneratedWebhookSecret {
  /** The opaque secret handed to the webhook creator ONCE in the create
   *  response. The consumer hashes this (sha256) to derive the HMAC key. */
  raw: string;
  /** SHA-256 hash of `raw`, stored in outgoing_webhooks.secret_key and used as
   *  the HMAC signing key. A DB leak never yields `raw`. */
  hash: string;
}

export function generateWebhookSecret(): GeneratedWebhookSecret {
  const raw = `${SECRET_PREFIX}_${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashWebhookSecret(raw) };
}

export function hashWebhookSecret(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function newOutgoingWebhookId(): string {
  return `owh_${randomUUID()}`;
}

// ─── Signing ─────────────────────────────────────────────────────────────────

export const SIGNATURE_HEADER = "X-Cyborg7-Signature";
export const TIMESTAMP_HEADER = "X-Cyborg7-Timestamp";
export const EVENT_HEADER = "X-Cyborg7-Event";
export const DELIVERY_ID_HEADER = "X-Cyborg7-Delivery";

// HMAC-SHA256 of the exact request body, keyed by the stored secret hash. Format
// `sha256=<hex>` (GitHub convention). The consumer computes the same over the
// received bytes, keyed by sha256(rawSecret), and compares constant-time.
export function signBody(secretKeyHash: string, body: string): string {
  return `sha256=${createHmac("sha256", secretKeyHash).update(body).digest("hex")}`;
}

// Constant-time verify (exposed for tests + a future inbound verify helper).
export function verifySignature(
  secretKeyHash: string,
  body: string,
  header: string | undefined,
): boolean {
  if (!header) return false;
  const expected = signBody(secretKeyHash, body);
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─── Retry / backoff ─────────────────────────────────────────────────────────

// Max delivery attempts before the row is dead-lettered and the webhook is
// deactivated + the owner DM'd. The first attempt is #1, so a cap of 5 means 4
// retries after the initial try.
export const MAX_ATTEMPTS = 5;

// Base backoff and ceiling for the exponential schedule. Exported for tests.
export const BASE_BACKOFF_MS = 30_000; // 30s after the first failure
export const MAX_BACKOFF_MS = 60 * 60_000; // cap at 1h

// Exponential backoff with full jitter for the Nth attempt that just FAILED
// (1-based). attempt=1 → ~base; doubles each time; capped; jitter is uniform in
// [0, window). Returns the delay in ms before the next try. `rand` is injectable
// for deterministic tests (defaults to Math.random).
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
  // Full jitter: a uniform sample in [0, exp]. Spreads retries so a fleet of
  // failed deliveries doesn't thundering-herd the consumer on the same tick.
  return Math.floor(rand() * exp);
}

export type DeliveryFailureCode = "http_error" | "timeout" | "ssrf_blocked" | "network_error";

export interface RetryDecision {
  // Whether more attempts remain after this failed one.
  willRetry: boolean;
  // The next_retry_at to schedule (epoch ms), or null when dead-lettered.
  nextRetryAt: number | null;
}

// Decide what happens after a delivery attempt #`attempt` (1-based) FAILED:
// schedule the next retry with backoff, or dead-letter once the cap is hit.
export function decideRetry(
  attempt: number,
  now: number,
  rand: () => number = Math.random,
): RetryDecision {
  if (attempt >= MAX_ATTEMPTS) return { willRetry: false, nextRetryAt: null };
  return { willRetry: true, nextRetryAt: now + backoffMs(attempt, rand) };
}

// ─── Event payload shape ─────────────────────────────────────────────────────

export interface WebhookMessagePayloadInput {
  eventType: WebhookEventType;
  workspaceId: string;
  channelId: string;
  messageId: string;
  // Present for created/updated; omitted for deleted (only the id is known).
  text?: string | null;
  fromId?: string | null;
  fromName?: string | null;
  createdAt?: number | null;
  // ISO timestamp the event fired (defaults to now()).
  firedAt?: number;
}

// Build the JSON-serializable event body POSTed to the consumer. Stored verbatim
// in webhook_outbox.event_data so a retry resends the EXACT bytes the signature
// covers. Stable, documented shape (Plane/GitHub style).
export function buildEventPayload(input: WebhookMessagePayloadInput): Record<string, unknown> {
  const firedAt = input.firedAt ?? Date.now();
  const data: Record<string, unknown> = {
    id: input.messageId,
    channel_id: input.channelId,
  };
  if (input.eventType !== "message.deleted") {
    if (input.text !== undefined) data.text = input.text;
    if (input.fromId !== undefined) data.from_id = input.fromId;
    if (input.fromName !== undefined) data.from_name = input.fromName;
    if (input.createdAt !== undefined && input.createdAt !== null) {
      data.created_at = new Date(input.createdAt).toISOString();
    }
  }
  return {
    event: input.eventType,
    workspace_id: input.workspaceId,
    delivered_at: new Date(firedAt).toISOString(),
    data,
  };
}
