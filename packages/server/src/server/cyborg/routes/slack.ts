import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { S3Client } from "@aws-sdk/client-s3";
import type { PgSync, StoredIntegrationInstallation } from "../db/pg-sync.js";
import type { WorkspaceRelay } from "../workspace-relay.js";
import type { RelayEnv } from "./types.js";
import { uploadBufferToS3, MAX_ATTACHMENT_BYTES } from "./assets.js";
import { slackAdapter, SLACK_PROVIDER } from "../integrations/slack-adapter.js";
import type {
  ParsedInboundFile,
  ParsedInboundMessage,
  ParsedInboundReaction,
} from "../integrations/types.js";
import { slackNameToEmoji } from "../integrations/slack-emoji.js";
import { getSlackSigningSecret } from "../slack-app.js";
import { consumePostedReaction, consumePostedTs, isOurBotUserId } from "../slack-outbound.js";

// INBOUND Slack Events receiver (WAVE 2a). A customer's message in a linked Slack
// (Connect) channel → an injected message in the bound Cyborg channel, authored by a
// synthetic guest. Mirrors routes/github.ts's contract:
//   - PUBLIC (no requireAuth) — Slack authenticates via the signing-secret HMAC over
//     the EXACT raw body (read c.req.text() BEFORE any parse, same raw-body
//     discipline as the GitHub/Stripe receivers).
//   - url_verification handshake → echo the challenge.
//   - 200-ACK in <3s, then process asynchronously (Slack retries on a slow/failed
//     ack — we ack first, work after).
//   - Dedup by Slack event_id (at-least-once delivery + retries).
//   - Echo-guarded against our OWN outbound posts (slack-outbound.ts).
//
// OAUTH + the install/settings surface is the OTHER coder's routes/slack-oauth.ts —
// this module is the events endpoint ONLY.

export interface SlackRoutesDeps {
  pg: PgSync | null;
  relay: WorkspaceRelay;
  // S3 assets client/bucket (injected from the relay compositor) for re-hosting
  // inbound Slack file attachments. When absent, files are simply skipped.
  s3Client: S3Client | null;
  s3Bucket: string | undefined;
  s3Region: string;
}

// ── event_id dedupe (at-least-once + Slack's 3x retry on a slow ack) ──
// A small in-memory TTL set of recently-seen event ids. Slack retries an unacked
// delivery within minutes; 10 minutes covers that without growing unbounded.
const EVENT_DEDUPE_TTL_MS = 10 * 60 * 1000;
const seenEventIds = new Map<string, number>();

function alreadyHandledEvent(eventId: string, now = Date.now()): boolean {
  // Prune on read so the map stays bounded on a long-lived relay.
  for (const [id, exp] of seenEventIds) {
    if (exp <= now) seenEventIds.delete(id);
  }
  if (seenEventIds.has(eventId)) return true;
  seenEventIds.set(eventId, now + EVENT_DEDUPE_TTL_MS);
  return false;
}

// Slack ts ("1700000000.000200" = unix-seconds.micros) → epoch ms. Falls back to now
// for an unparseable value so a message never lands with a NaN createdAt.
function slackTsToEpochMs(ts: string): number {
  const seconds = Number.parseFloat(ts);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : Date.now();
}

// Is this a Slack-owned file host? url_private comes from the (HMAC-verified) Slack
// event, but the URL is still attacker-influenceable — a forged/compromised file object
// could point it at an internal address (SSRF). Only ever fetch HTTPS Slack hosts.
function isSlackFileUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "files.slack.com" || host.endsWith(".slack.com");
}

// Stream a fetch body into a Buffer, aborting (and cancelling the stream) the moment it
// exceeds `cap`. Returns null on overflow so an attacker can't OOM the relay with a body
// whose Content-Length lied or was absent. arrayBuffer() would buffer the whole thing
// before any size check — this never holds more than `cap` + one chunk.
async function readBodyCapped(res: Response, cap: number, fileId: string): Promise<Buffer | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      console.error(`[slack] file ${fileId}: body exceeded ${cap}-byte cap, aborted`);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// Download an inbound Slack file with the bot token and re-host it on our S3 assets
// bucket, returning the persisted attachment fields. null on any failure / when S3
// is off / when the type isn't inline-safe (uploadBufferToS3 enforces that) — the
// caller just drops that one file and keeps mirroring the message text. Hardened
// against SSRF (Slack-host allowlist + no redirects), OOM (streamed, capped at the
// shared attachment ceiling), and stream leaks (body cancelled on any early return).
// Exported for unit tests (the SSRF + size-cap guards).
export async function rehostSlackFile(
  file: ParsedInboundFile,
  token: string,
  deps: SlackRoutesDeps,
): Promise<{ key: string; name: string; type: string; size: number; url: string } | null> {
  // SSRF guard BEFORE the fetch: refuse anything that isn't an HTTPS Slack host.
  if (!isSlackFileUrl(file.urlPrivate)) {
    console.error(`[slack] file ${file.id}: refusing non-Slack url_private`);
    return null;
  }
  try {
    // `redirect: "error"` so a 30x can't bounce past the host check to an internal
    // address after it passed — a redirect rejects the fetch (caught below).
    const res = await fetch(file.urlPrivate, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
    });
    if (!res.ok) {
      console.error(`[slack] file download failed (${res.status}) for ${file.id}`);
      await res.body?.cancel(); // don't leak the unread body stream.
      return null;
    }
    // Reject an over-cap declared Content-Length up front (cheap), then stream with a
    // hard cap in case the header lied or was absent.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
      console.error(`[slack] file ${file.id}: declared ${declared} bytes over cap`);
      await res.body?.cancel();
      return null;
    }
    const buffer = await readBodyCapped(res, MAX_ATTACHMENT_BYTES, file.id);
    if (!buffer) return null;
    const uploaded = await uploadBufferToS3({
      s3Client: deps.s3Client,
      s3Bucket: deps.s3Bucket,
      s3Region: deps.s3Region,
      buffer,
      contentType: file.mimetype,
      filename: file.name,
      folder: "slack-files",
    });
    if (!uploaded) return null; // S3 off, too large, or not an inline-safe type.
    return {
      key: uploaded.key,
      name: file.name,
      type: file.mimetype,
      size: buffer.length, // the ACTUAL bytes, not Slack's advisory file.size.
      url: uploaded.publicUrl,
    };
  } catch (err) {
    console.error(`[slack] file re-host failed for ${file.id}`, err);
    return null;
  }
}

// Build the attachments[] for an inbound message (best-effort; a failed file is
// skipped). Empty array when there are no files / no token / no S3.
async function buildAttachments(
  files: ParsedInboundFile[] | undefined,
  token: string | null,
  deps: SlackRoutesDeps,
): Promise<{ key: string; name: string; type: string; size: number; url: string }[]> {
  if (!files || files.length === 0 || !token) return [];
  const out: { key: string; name: string; type: string; size: number; url: string }[] = [];
  for (const file of files) {
    const att = await rehostSlackFile(file, token, deps);
    if (att) out.push(att);
  }
  return out;
}

// Is this inbound event an echo of one of OUR OWN outbound posts (which must never be
// re-mirrored)? The AUTHORITATIVE, cross-instance guard is the per-install identity check
// (installation.botUserId === msg.userId): installation comes from shared Postgres, so it
// holds even when our outbound post happened on a DIFFERENT relay instance than the one
// this bot-echo event is load-balanced to. A bot echo of our own chat.postMessage always
// carries user=<bot Uxxx>, so this matches; a bot frame with no user is dropped by the
// `!msg.userId` guard in the caller. consumePostedTs (the ts WE posted) and isOurBotUserId
// are module-level per-process sets — same-instance fast-paths only; do NOT remove the DB
// identity check believing they cover it (they do not share state across instances).
function isOurOwnEcho(
  installation: StoredIntegrationInstallation | null,
  msg: ParsedInboundMessage,
): boolean {
  if (consumePostedTs(msg.ts)) return true;
  if (msg.botId !== null) {
    if (installation?.botUserId && msg.userId === installation.botUserId) return true;
    if (isOurBotUserId(msg.userId)) return true;
  }
  return false;
}

// Mirror ONE inbound Slack message into its bound Cyborg channel. Resolves the
// channel link, applies the echo guard, ensures a synthetic author, resolves the
// thread parent, re-hosts files, injects, and records the message_integrations
// back-link. Best-effort per message — a failure logs + returns (the receiver has
// already 200-acked). Exported for unit tests (the inbound→inject mapping), mirroring
// github-outbound's exported emit.
export async function handleInboundMessage(
  pg: PgSync,
  relay: WorkspaceRelay,
  deps: SlackRoutesDeps,
  msg: ParsedInboundMessage,
): Promise<void> {
  // Only a channel WE'RE bound to is mirrored — everything else is silently skipped.
  const link = await pg.getSlackChannelLinkBySlackChannel(msg.channelId);
  if (!link) return;
  // An outbound-only link doesn't mirror Slack→Cyborg.
  if (link.syncDirection === "outbound") return;

  const installation = await pg.getIntegrationInstallationById(link.installationId);

  // Echo guard: never re-mirror an event that is our OWN outbound post bouncing back.
  if (isOurOwnEcho(installation, msg)) return;

  // Slack EDIT → update the mirrored Cyborg message's text (WAVE 2.1). Our OWN bot
  // edits already dropped by isOurOwnEcho above; only a real customer edit reaches here.
  if (msg.kind === "message_changed") {
    const map = await pg.getMessageIntegrationByExternal(SLACK_PROVIDER, msg.ts, link.workspaceId);
    if (!map) return; // an edit of a message we never mirrored — nothing to update.
    await pg.updateMessageText(map.messageId, msg.text);
    relay.injectMessage(link.workspaceId, {
      type: "cyborg:edit_message_broadcast",
      payload: { workspaceId: link.workspaceId, messageId: map.messageId, text: msg.text },
    });
    return;
  }

  // Slack DELETE → soft-delete the mirrored Cyborg message.
  if (msg.kind === "message_deleted") {
    const map = await pg.getMessageIntegrationByExternal(SLACK_PROVIDER, msg.ts, link.workspaceId);
    if (!map) return;
    await pg.deleteMessage(map.messageId);
    relay.injectMessage(link.workspaceId, {
      type: "cyborg:delete_message_broadcast",
      payload: { workspaceId: link.workspaceId, messageId: map.messageId },
    });
    return;
  }

  // A message with no authoring user can't be attributed to a synthetic guest
  // (a system/integration frame that slipped past classification) — skip it.
  if (!msg.userId) return;

  // Durable inbound dedupe (cross-instance + restart-proof). The module-level
  // seenEventIds set is per-process and clears on every deploy, so a Slack retry routed
  // to a DIFFERENT relay instance, or arriving after a restart, escapes it. The
  // message_integrations (provider, external_id=ts) row lives in shared Postgres and is
  // written ONLY after a successful mirror below, so a redelivery of an already-mirrored
  // ts is dropped here — while a redelivery of one that FAILED before recording still
  // re-injects (recovery). Cheapest correct spot: before the resolveUser network call.
  if (await pg.getMessageIntegrationByExternal(SLACK_PROVIDER, msg.ts, link.workspaceId)) return;

  const syntheticId = `${SLACK_PROVIDER}:${msg.teamId}:${msg.userId}`;
  const displayName = await ensureSyntheticAuthor(
    pg,
    link,
    msg.teamId,
    msg.userId,
    installation?.accessToken ?? null,
  );

  // Thread mapping: a Slack threaded reply (thread_ts) posts under the Cyborg message
  // its root was mapped to. An unmapped root → a top-level post (parentId null).
  let parentId: string | null = null;
  if (msg.threadTs) {
    const parentMap = await pg.getMessageIntegrationByExternal(
      SLACK_PROVIDER,
      msg.threadTs,
      link.workspaceId,
    );
    parentId = parentMap?.messageId ?? null;
  }

  const attachments = await buildAttachments(msg.files, installation?.accessToken ?? null, deps);

  const messageId = randomUUID();
  // Inject through the normal relay path (persist + broadcast), exactly like a human
  // web-UI post. The outbound hook this triggers DROPS it (the `slack:` synthetic
  // author short-circuits mirrorChannelMessageToSlack) — no A→B→A loop.
  relay.injectMessage(
    link.workspaceId,
    {
      type: "cyborg:channel_message_broadcast",
      payload: {
        id: messageId,
        workspaceId: link.workspaceId,
        channelId: link.cyborgChannelId,
        fromId: syntheticId,
        fromType: "human",
        fromName: displayName,
        toId: null,
        text: msg.text,
        mentions: null,
        parentId,
        attachments: attachments.length > 0 ? attachments : null,
        source: SLACK_PROVIDER,
        createdAt: slackTsToEpochMs(msg.ts),
      },
    },
    syntheticId,
  );

  // Record the Cyborg-message ↔ Slack-ts back-link: dedupes a redelivery, resolves
  // future thread replies, and (with the synthetic author) double-guards the echo.
  await pg.upsertMessageIntegration({
    messageId,
    workspaceId: link.workspaceId,
    provider: SLACK_PROVIDER,
    externalId: msg.ts,
    externalThreadId: msg.threadTs ?? null,
  });
}

// Ensure the synthetic Cyborg guest that authors this Slack (team, user)'s messages +
// reactions exists, returning its display name. First sight resolves the real name via
// the bot token (degrades to the user id) and persists both the user row and the
// slack_user_map; thereafter the cached map name is reused. Keyed by primitives so both
// the message and reaction inbound paths share it.
async function ensureSyntheticAuthor(
  pg: PgSync,
  link: { workspaceId: string },
  teamId: string,
  userId: string,
  token: string | null,
): Promise<string> {
  const syntheticId = `${SLACK_PROVIDER}:${teamId}:${userId}`;
  const existing = await pg.getSlackUserMap(teamId, userId);
  if (existing) {
    // Avatar backfill: a row created before the avatar was captured (older code, or a
    // pre-users:read install) is frozen — getSlackUserMap short-circuits, so resolveUser
    // never runs again and the profile stays image-less forever. If we hold a token and
    // the stored image is NULL (never attempted), re-resolve ONCE and update.
    // We write "" when there's no avatar OR the resolve failed — "" is falsy (the UI still
    // falls back to initials) but is NOT null, so we do NOT re-hit users.info on every
    // subsequent message (avoids a per-message API storm / rate-limit). Keep the stored
    // name: a transient resolveUser failure returns name=userId, and upsertSyntheticUser
    // coalesces on non-null, so passing it would clobber the already-correct display name.
    if (token) {
      const stored = await pg.getUserById(syntheticId);
      if (stored && stored.imageUrl === null) {
        const resolved = await slackAdapter.resolveUser(token, userId);
        await pg.upsertSyntheticUser(
          syntheticId,
          stored.email,
          stored.name ?? resolved.name,
          resolved.imageUrl ?? "",
        );
      }
    }
    return existing.displayName ?? userId;
  }

  let displayName = userId;
  let imageUrl: string | null = null;
  if (token) {
    const resolved = await slackAdapter.resolveUser(token, userId);
    displayName = resolved.name;
    imageUrl = resolved.imageUrl;
  }
  // The cloud-guest pattern: a synthetic user row keyed by the Slack identity, with a
  // routable-but-unreachable email so it can never collide with a real account.
  const email = `slack_${teamId}_${userId}@remote.local`;
  await pg.upsertSyntheticUser(syntheticId, email, displayName, imageUrl);
  await pg.upsertSlackUserMap({
    id: `slku_${randomUUID()}`,
    workspaceId: link.workspaceId,
    slackTeamId: teamId,
    slackUserId: userId,
    syntheticUserId: syntheticId,
    displayName,
  });
  return displayName;
}

// Mirror ONE inbound Slack reaction (reaction_added / reaction_removed) onto its bound
// Cyborg message. Resolves the channel link + the target Cyborg message (by Slack ts),
// applies the echo guard, maps the Slack emoji name to Cyborg's Unicode key, and
// applies/removes the reaction as the synthetic Slack author — then broadcasts so live
// clients update. Best-effort per reaction (the receiver has already 200-acked). A
// reaction on an un-mirrored message, or an uncurated emoji, is a quiet no-op. Exported
// for unit tests.
export async function handleInboundReaction(
  pg: PgSync,
  relay: WorkspaceRelay,
  r: ParsedInboundReaction,
): Promise<void> {
  // Only a channel WE'RE bound to is mirrored — everything else is silently skipped.
  const link = await pg.getSlackChannelLinkBySlackChannel(r.channelId);
  if (!link) return;
  // An outbound-only link doesn't mirror Slack→Cyborg.
  if (link.syncDirection === "outbound") return;

  const installation = await pg.getIntegrationInstallationById(link.installationId);

  // Echo guard (authoritative, cross-instance): a reaction_added/removed authored by our
  // OWN bot is the echo of a Cyborg→Slack mirror — never re-apply it. installation comes
  // from shared Postgres so this holds even across relay instances.
  if (installation?.botUserId && r.userId === installation.botUserId) return;
  if (isOurBotUserId(r.userId)) return;

  // Map the Slack reaction name to Cyborg's Unicode key. A custom/workspace or uncurated
  // emoji has no key → no-op (a reaction is never dropped destructively).
  const emoji = slackNameToEmoji(r.reaction);
  if (!emoji) return;

  // Echo guard (same-instance fast path): drop the bot-echo of our own outbound reaction,
  // keyed by the Cyborg emoji so it's immune to Slack's reaction-name aliasing.
  if (consumePostedReaction(r.messageTs, emoji, r.action)) return;

  // Resolve the Cyborg message this Slack ts maps to; an un-mirrored message → nothing to
  // react on.
  const map = await pg.getMessageIntegrationByExternal(
    SLACK_PROVIDER,
    r.messageTs,
    link.workspaceId,
  );
  if (!map) return;

  const syntheticId = `${SLACK_PROVIDER}:${r.teamId}:${r.userId}`;
  const displayName = await ensureSyntheticAuthor(
    pg,
    link,
    r.teamId,
    r.userId,
    installation?.accessToken ?? null,
  );

  // Directional + idempotent apply (NOT toggle): a retried reaction_added won't flip a
  // reaction off. `changed` is false when it's already in the target state → no broadcast.
  const changed =
    r.action === "added"
      ? await pg.addReaction(link.workspaceId, map.messageId, syntheticId, displayName, emoji)
      : await pg.removeReaction(link.workspaceId, map.messageId, syntheticId, emoji);
  if (!changed) return;

  // Broadcast so live clients update, matching the guest reaction handler's payload shape.
  // injectMessage fans out but does NOT re-enter the `cyborg:reaction` websocket handler
  // (the only outbound-reaction mirror seam), so an inbound-applied reaction can never
  // loop back out to Slack.
  relay.injectMessage(link.workspaceId, {
    type: "cyborg:reaction_broadcast",
    payload: {
      workspaceId: link.workspaceId,
      messageId: map.messageId,
      userId: syntheticId,
      userName: displayName,
      emoji,
      action: r.action,
    },
  });
}

// Process every normalized message + reaction on a verified event envelope. Sequential so
// an edit can't race its own create; per-item failures are isolated.
async function processInboundEvent(
  pg: PgSync,
  relay: WorkspaceRelay,
  deps: SlackRoutesDeps,
  messages: ParsedInboundMessage[],
  reactions: ParsedInboundReaction[],
): Promise<void> {
  for (const msg of messages) {
    try {
      await handleInboundMessage(pg, relay, deps, msg);
    } catch (err) {
      console.error("[slack] failed to mirror inbound message", err);
    }
  }
  for (const reaction of reactions) {
    try {
      await handleInboundReaction(pg, relay, reaction);
    } catch (err) {
      console.error("[slack] failed to mirror inbound reaction", err);
    }
  }
}

// The Slack Events endpoint, mounted as a Hono sub-app — see
// `app.route("/", createSlackRoutes(...))` in relay-standalone.ts.
export function createSlackRoutes(deps: SlackRoutesDeps): Hono<RelayEnv> {
  const { pg, relay } = deps;
  const app = new Hono<RelayEnv>();

  // ── PUBLIC events receiver ──
  app.post("/api/slack/events", async (c) => {
    // RAW body first — the HMAC must be computed over the EXACT bytes Slack signed.
    const rawBody = await c.req.text().catch(() => "");
    const signingSecret = getSlackSigningSecret();
    // verifyWebhook returns false for a missing secret, so an unconfigured relay
    // rejects (401) rather than silently accepting unauthenticated posts.
    const headers = {
      "x-slack-signature": c.req.header("x-slack-signature"),
      "x-slack-request-timestamp": c.req.header("x-slack-request-timestamp"),
    };
    if (!slackAdapter.verifyWebhook(rawBody, headers, signingSecret ?? "")) {
      return c.json({ error: "invalid signature" }, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      payload = null;
    }
    const parsed = slackAdapter.parseInbound(payload);

    // Setup handshake — echo the challenge (Slack sends this once on URL save).
    if (parsed.type === "url_verification") {
      return c.json({ challenge: parsed.challenge });
    }
    if (parsed.type === "ignored") return c.json({ ok: true });

    // event envelope. Dedup by event_id BEFORE any work (retries + at-least-once).
    if (parsed.eventId && alreadyHandledEvent(parsed.eventId)) {
      return c.json({ ok: true });
    }
    // Without a DB we can't resolve links — still 200-ack so Slack stops retrying.
    const reactions = parsed.reactions ?? [];
    if (pg && (parsed.messages.length > 0 || reactions.length > 0)) {
      // 200-ACK now, process AFTER (Slack's 3s ack window). Fire-and-forget; a
      // failure inside is logged, never retried-storm'd back at Slack.
      void processInboundEvent(pg, relay, deps, parsed.messages, reactions).catch((err) =>
        console.error("[slack] async event processing failed", err),
      );
    }
    return c.json({ ok: true });
  });

  return app;
}

// TEST-ONLY: clear the event_id dedupe set between cases.
export function _resetSlackEventDedupeForTest(): void {
  seenEventIds.clear();
}
