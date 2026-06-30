// Provider-agnostic seam for customer-comms integrations. Slack is the first
// implementation; Jira / ClickUp / others slot in behind the SAME interface later.
// WAVE 1 LOCKS this contract — the Slack Events endpoint, OAuth, and UI (WAVE 2)
// consume it. The adapter is STATELESS: tokens and secrets are passed in by the
// caller (route / relay), never read from env inside the adapter, so one adapter
// instance serves every workspace's installation.

// A normalized inbound file attachment carried on a message event. The bridge
// downloads it from the provider (Slack: GET url with `Authorization: Bearer
// <bot token>`), re-uploads the bytes to our S3 assets bucket, and stores the
// result on the Cyborg message's `attachments` JSONB. WAVE-2a addition — purely
// additive to the locked WAVE-1 contract (an optional field; WAVE-1's minimal
// parseInbound simply never populated it, so no existing consumer breaks).
export interface ParsedInboundFile {
  // The provider file id (Slack file.id) — for dedupe / logging.
  id: string;
  // The display filename (Slack file.name); used as the S3 object filename.
  name: string;
  // The MIME type (Slack file.mimetype) — gates the inline-safe S3 upload.
  mimetype: string;
  // The authenticated download URL (Slack url_private_download / url_private).
  // Fetched with the installation's bot token; never surfaced to a client.
  urlPrivate: string;
  // The provider-reported byte size, when present (Slack file.size). The bridge
  // re-measures the actual bytes on download, so this is advisory only.
  size: number | null;
}

// The normalized, provider-agnostic shape of ONE inbound message event, produced by
// parseInbound from a provider's raw webhook payload. The bridge maps this into a
// Cyborg message: resolve synthetic author → injectMessage → record the mapping.
export interface ParsedInboundMessage {
  // The event kind the bridge must act on. WAVE 1 mirrors "message"; edits/deletes
  // are tagged (parsed best-effort) so WAVE 2a can refine without a contract change.
  kind: "message" | "message_changed" | "message_deleted";
  // The provider tenant id (Slack team_id / enterprise_id).
  teamId: string;
  // The provider channel id the event occurred in (Slack channel id).
  channelId: string;
  // The provider user id who authored the message (Slack user id). null for
  // bot/system events with no user.
  userId: string | null;
  // Plain text / markdown body (Block Kit rendered best-effort in WAVE 2a).
  text: string;
  // The provider message id / timestamp (Slack ts) — the external_id we map + dedupe.
  ts: string;
  // The thread-root id (Slack thread_ts) when this is a threaded reply; null when
  // it is itself a root message.
  threadTs: string | null;
  // The provider bot id when the message was posted by a bot — drives the echo guard
  // (drop events whose bot is OURS). null for human messages.
  botId: string | null;
  // The provider envelope id (Slack event_id) for at-least-once retry dedupe. null
  // when the provider supplies none.
  eventId: string | null;
  // File attachments on this message (Slack event.files / event.message.files),
  // deep-extracted in WAVE 2a. Optional + additive: absent on a text-only message
  // and on WAVE-1's minimal parse, so this never changes the contract for an
  // existing consumer. The bridge downloads + re-hosts each on the Cyborg message.
  files?: ParsedInboundFile[];
}

// The outcome of parsing a provider webhook envelope:
//   - url_verification: a setup handshake whose challenge must be echoed (Slack).
//   - event: zero or more normalized inbound messages (+ the envelope id to dedupe).
//   - ignored: a payload the bridge takes no action on.
export type ParsedInbound =
  | { type: "url_verification"; challenge: string }
  | { type: "event"; eventId: string | null; messages: ParsedInboundMessage[] }
  | { type: "ignored" };

// Arguments for posting a message back to the provider (outbound).
export interface PostMessageArgs {
  channelId: string;
  text: string;
  // The provider thread root to reply under (Slack thread_ts), when threading.
  threadTs?: string;
}

// The result of a successful post — the provider message id (Slack ts) the bridge
// then records in message_integrations + marks on the echo guard.
export interface PostMessageResult {
  ts: string;
}

// A resolved provider user's display identity (names the synthetic Cyborg guest).
export interface ResolvedUser {
  name: string;
}

// The seam every customer-comms provider implements.
export interface IntegrationAdapter {
  // The provider key stored in integration_installations.provider and
  // message_integrations.provider (e.g. "slack").
  readonly provider: string;

  // Verify a webhook request is authentic. Slack: HMAC-SHA256 "v0" over
  // `v0:${timestamp}:${rawBody}`, compared constant-time to X-Slack-Signature, with
  // a 5-minute timestamp replay window. Pure + synchronous; MUST NOT throw (bad or
  // missing input → false). The secret is passed in, never read from env here.
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
    secret: string,
  ): boolean;

  // Parse an ALREADY-VERIFIED raw webhook payload into the normalized envelope.
  parseInbound(payload: unknown): ParsedInbound;

  // Post a message to the provider as the bot. Returns the provider message id.
  // Throws on a provider error (outbound failures must surface to the caller).
  postMessage(token: string, args: PostMessageArgs): Promise<PostMessageResult>;

  // Resolve a provider user's display identity (Slack users.info → real_name).
  // Degrades to { name: userId } on a provider error rather than throwing, so a
  // single lookup failure never blocks mirroring the message.
  resolveUser(token: string, userId: string): Promise<ResolvedUser>;
}
