// Slack implementation of the IntegrationAdapter seam (WAVE 1). verifyWebhook is
// FULLY implemented (Slack signing-secret HMAC v0 + 5-minute replay window);
// parseInbound / postMessage / resolveUser are real-but-minimal — enough for WAVE
// 2a (the events endpoint + outbound hook) to build on without a contract change.
//
// The adapter is STATELESS: the signing secret (verifyWebhook) and bot token
// (postMessage / resolveUser) are passed in by the caller, never read from env, so
// one `slackAdapter` instance serves every workspace's installation. Env reads +
// the configured-gate live in slack-app.ts (mirrors github-app.ts).

import { createHmac, timingSafeEqual } from "node:crypto";
import { WebClient } from "@slack/web-api";
import { logError } from "@cyborg7/observability/node";
import type {
  IntegrationAdapter,
  ParsedInbound,
  ParsedInboundFile,
  ParsedInboundMessage,
  PostMessageArgs,
  PostMessageResult,
  ResolvedUser,
} from "./types.js";

export const SLACK_PROVIDER = "slack";

// Slack's documented anti-replay bound: reject a request whose
// X-Slack-Request-Timestamp is more than 5 minutes from now.
const SLACK_TIMESTAMP_WINDOW_SECONDS = 60 * 5;

export class SlackAdapter implements IntegrationAdapter {
  readonly provider = SLACK_PROVIDER;

  // HMAC-SHA256 "v0" verification per Slack's signing-secret scheme:
  //   basestring = `v0:${timestamp}:${rawBody}`
  //   expected   = `v0=` + hex(HMAC-SHA256(signingSecret, basestring))
  //   then compare X-Slack-Signature constant-time and reject a timestamp outside
  //   ±5 min (replay guard). Pure + synchronous; never throws — bad/missing input
  //   returns false. The route must read the EXACT raw body BEFORE parsing (same
  //   raw-body discipline as the GitHub/Stripe receivers).
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
    secret: string,
  ): boolean {
    if (!secret) return false;
    const signature = headers["x-slack-signature"];
    const timestamp = headers["x-slack-request-timestamp"];
    if (!signature || !timestamp) return false;

    // Replay guard: timestamp must be a finite, recent unix-seconds value.
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - ts) > SLACK_TIMESTAMP_WINDOW_SECONDS) return false;

    const basestring = `v0:${timestamp}:${rawBody}`;
    const expected = `v0=${createHmac("sha256", secret).update(basestring).digest("hex")}`;
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    // Length-guard so timingSafeEqual never throws on a mismatched-length input.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // Parse an already-verified Events API payload. Handles the url_verification
  // handshake and the event_callback envelope; a single message event becomes one
  // normalized ParsedInboundMessage. Anything else → { type: "ignored" }.
  parseInbound(payload: unknown): ParsedInbound {
    if (!isRecord(payload)) return { type: "ignored" };

    // Setup handshake — echo the challenge (Slack sends this once on URL save).
    if (payload.type === "url_verification" && typeof payload.challenge === "string") {
      return { type: "url_verification", challenge: payload.challenge };
    }

    // Event envelope: { type:"event_callback", team_id, event_id, event:{...} }.
    if (payload.type !== "event_callback") return { type: "ignored" };
    const eventId = typeof payload.event_id === "string" ? payload.event_id : null;
    const teamId = typeof payload.team_id === "string" ? payload.team_id : "";
    const event = payload.event;
    if (!isRecord(event)) return { type: "event", eventId, messages: [] };

    const message = parseMessageEvent(event, teamId, eventId);
    return { type: "event", eventId, messages: message ? [message] : [] };
  }

  // Post as the bot via chat.postMessage. Throws on a provider error so the
  // outbound hook can decide (the post is best-effort there, never blocks).
  async postMessage(token: string, args: PostMessageArgs): Promise<PostMessageResult> {
    const client = new WebClient(token);
    const params = {
      channel: args.channelId,
      text: args.text,
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
    };
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Slack Web API chat.postMessage, NOT the DOM window.postMessage (no targetOrigin exists)
    const res = await client.chat.postMessage(params);
    const ts = typeof res.ts === "string" ? res.ts : "";
    if (!res.ok || !ts) {
      throw new Error(`Slack chat.postMessage failed: ${res.error ?? "no ts returned"}`);
    }
    return { ts };
  }

  // Resolve a Slack user's display name (real_name → profile.display_name → name).
  // Degrades to { name: userId } on a provider error (e.g. missing users:read
  // scope) so a single lookup failure never blocks mirroring the message.
  async resolveUser(token: string, userId: string): Promise<ResolvedUser> {
    try {
      const client = new WebClient(token);
      const res = await client.users.info({ user: userId });
      const user = res.user;
      const name = user?.real_name || user?.profile?.display_name || user?.name || userId;
      return { name };
    } catch (err) {
      logError("slack-adapter", err, { op: "resolveUser", userId });
      return { name: userId };
    }
  }
}

// Stateless singleton — one instance serves every workspace's installation.
export const slackAdapter = new SlackAdapter();

// ─── helpers ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Map a Slack `message` event to the normalized inbound shape, or null when it is
// not a kind the bridge mirrors. WAVE 2a deep-extracts the nested payloads:
//   - message_changed: the edited content lives under `event.message` (and the
//     prior text under `event.previous_message`); the top-level event carries no
//     user/text/files of its own.
//   - message_deleted: the removed message's id lives under
//     `event.previous_message.ts` (or top-level `deleted_ts`); no new content.
//   - file_share / a plain message with uploads: `event.files[]`.
// System subtypes (channel_join, topic changes, …) are not customer content →
// ignored. The route decides what to ACT on (WAVE 2a mirrors creates; edits/
// deletes are parsed-but-deferred). The "content event" the timestamps/text/files
// come from is the nested message for an edit, else the event itself.
function parseMessageEvent(
  event: Record<string, unknown>,
  teamId: string,
  eventId: string | null,
): ParsedInboundMessage | null {
  if (event.type !== "message") return null;

  const subtype = typeof event.subtype === "string" ? event.subtype : undefined;
  const kind = classifyMessageKind(subtype);
  if (kind === "ignore") return null;

  const channelId = typeof event.channel === "string" ? event.channel : "";
  if (!channelId) return null;

  // The record the message FIELDS (ts/text/user/files/thread) are read from. For an
  // edit, Slack nests the current content under event.message; for a delete, the
  // removed message is event.previous_message. A plain message reads the event
  // itself. Falls back to the event when the nested record is absent (so a partial/
  // malformed edit/delete still yields a tagged row instead of throwing).
  const content = contentRecordFor(kind, event);

  // Prefer the content record's ts; for a delete Slack may only set deleted_ts on
  // the top-level event, so fall back to that, then to the event's own ts.
  const ts =
    asString(content.ts) ||
    (kind === "message_deleted" ? asString(event.deleted_ts) : "") ||
    asString(event.ts);
  // thread_ts equal to ts means the message IS the root, not a reply.
  const threadTsRaw = asString(content.thread_ts) || asString(event.thread_ts);
  const threadTs = threadTsRaw && threadTsRaw !== ts ? threadTsRaw : null;
  const userId = asString(content.user) || asString(event.user) || null;
  const text = asString(content.text);
  const botId = asString(content.bot_id) || asString(event.bot_id) || null;
  const files = extractFiles(content.files ?? event.files);

  const parsed: ParsedInboundMessage = {
    kind,
    teamId,
    channelId,
    userId,
    text,
    ts,
    threadTs,
    botId,
    eventId,
  };
  // Additive: only attach `files` when there are some, so a text-only message keeps
  // the exact WAVE-1 shape (no empty array, no key).
  if (files.length > 0) parsed.files = files;
  return parsed;
}

// The nested record a message event's content lives in: event.message for an edit,
// event.previous_message for a delete, else the event itself. Always an object so
// callers can index it without a null check.
function contentRecordFor(
  kind: ParsedInboundMessage["kind"],
  event: Record<string, unknown>,
): Record<string, unknown> {
  if (kind === "message_changed" && isRecord(event.message)) return event.message;
  if (kind === "message_deleted" && isRecord(event.previous_message)) return event.previous_message;
  return event;
}

// Normalize a Slack files[] array (top-level or nested) into ParsedInboundFile[].
// Skips entries with no authenticated download URL (e.g. a tombstoned file) — the
// bridge can't fetch those. url_private_download is preferred (forces a download
// response), falling back to url_private.
function extractFiles(raw: unknown): ParsedInboundFile[] {
  if (!Array.isArray(raw)) return [];
  const files: ParsedInboundFile[] = [];
  for (const f of raw) {
    if (!isRecord(f)) continue;
    const urlPrivate = asString(f.url_private_download) || asString(f.url_private);
    if (!urlPrivate) continue;
    files.push({
      id: asString(f.id),
      name: asString(f.name) || asString(f.title) || "file",
      mimetype: asString(f.mimetype),
      urlPrivate,
      size: typeof f.size === "number" && Number.isFinite(f.size) ? f.size : null,
    });
  }
  return files;
}

// Coerce an untrusted JSON value to a string ("" when absent / not a string).
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Classify a Slack message subtype into the inbound kind, or "ignore" for system
// subtypes that aren't customer content.
function classifyMessageKind(subtype: string | undefined): ParsedInboundMessage["kind"] | "ignore" {
  if (subtype === undefined) return "message";
  if (subtype === "message_changed") return "message_changed";
  if (subtype === "message_deleted") return "message_deleted";
  // Customer content that still carries a body at the top level.
  if (subtype === "bot_message" || subtype === "file_share" || subtype === "thread_broadcast") {
    return "message";
  }
  return "ignore";
}
