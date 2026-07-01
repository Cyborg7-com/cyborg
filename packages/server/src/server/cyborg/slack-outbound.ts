// OUTBOUND mirror: a channel message posted in Cyborg7 → post it back to the linked
// Slack channel as the bot, but ONLY for genuinely Cyborg-originated posts (a human
// in the web UI, or a cybo reply — both ride this seam). The inbound path
// (routes/slack.ts) is the reverse: a Slack event → an injected Cyborg message.
//
// Two concerns live here, split (as in github-outbound.ts) so the loop guard is pure
// + unit-testable while the Slack I/O is injected:
//   1. The ECHO GUARD — the two-sided loop breaker. Outbound: when we post to Slack
//      we record the returned `ts` in a short-lived set, AND remember our bot's
//      user-id. Inbound (routes/slack.ts) then DROPS any event whose ts we just
//      posted, or whose author is our bot — so a Cyborg→Slack post can never bounce
//      back in as a "new" inbound message (an A→B→A loop). The synthetic-author
//      check below (`slack:` ids never re-post) closes the other direction.
//   2. The OUTBOUND emit — resolve the channel's Slack link + installation token,
//      resolve the thread root, and chat.postMessage via the (injected) poster.
//      Best-effort: a missing link / token / network failure logs + returns; it
//      never throws to the message-broadcast path that triggered it.

import type { PgSync } from "./db/pg-sync.js";
import { isSlackConfigured } from "./slack-app.js";
import { SLACK_PROVIDER, slackAdapter } from "./integrations/slack-adapter.js";
import { emojiToSlackName } from "./integrations/slack-emoji.js";
import { MAX_ATTACHMENT_BYTES } from "./routes/assets.js";
import type {
  PostMessageArgs,
  PostMessageResult,
  ReactionArgs,
  UpdateMessageArgs,
  UploadFileArgs,
  DeleteMessageArgs,
} from "./integrations/types.js";
import { lookup } from "node:dns/promises";
import net from "node:net";

// ─── Echo guard (shared with the inbound receiver) ───────────────────────────

// How long a posted-ts marker stays "fresh". A Cyborg→Slack post and the resulting
// inbound echo (Slack delivers the bot's own message event back over the Events API)
// can be a couple of seconds apart on a slow round trip; 60s is comfortably longer
// than that while short enough that it can't shadow an UNRELATED later message.
const ECHO_TTL_MS = 60_000;

// Slack ts WE posted → expiry epoch ms. Module-level so the outbound emit (which
// marks) and the inbound receiver (which consumes) share one registry within the
// relay process. Bounded by pruning on every write.
//
// NOTE (cross-instance): this map and ourBotUserIds below are PER-PROCESS. The relay
// runs multi-instance (Redis fan-out), and a bot-echo event can be load-balanced to a
// DIFFERENT instance than the one that posted, where neither set has the entry. They
// are therefore only a SAME-INSTANCE fast-path — the AUTHORITATIVE cross-instance echo
// guard is the per-install bot-identity check in routes/slack.ts
// (installation.botUserId === msg.userId), which reads shared Postgres. Do not treat
// these in-memory sets as the load-bearing guarantee. (Future: share them via Redis.)
const postedTs = new Map<string, number>();

// The bot USER ids (Slack Uxxxx) we post as, captured from each installation we post
// through. The inbound receiver drops a message authored by one of these (the bot's
// own echo) as a second, identity-based guard alongside the ts set — but, per the note
// above, only as a same-instance fast-path, not the cross-instance guarantee.
const ourBotUserIds = new Set<string>();

// Reaction echo markers: `${slackTs}:${emoji}:${action}` WE just applied to Slack →
// expiry epoch ms. When our own reactions.add/remove lands, Slack delivers a
// reaction_added/removed event authored by our bot; the inbound receiver consumes the
// matching marker to drop it. Keyed by the CYBORG Unicode emoji (not the Slack name) so
// it survives Slack's alias canonicalization ("+1" ⇄ "thumbsup" both resolve to the same
// Unicode key). Same-instance fast-path (the authoritative cross-instance guard is the
// per-install bot-identity check: event.user === installation.botUserId).
const postedReactions = new Map<string, number>();

// Drop expired markers so the Map can't grow unbounded across a long-lived relay.
function pruneEcho(now: number): void {
  for (const [ts, exp] of postedTs) {
    if (exp <= now) postedTs.delete(ts);
  }
}

// Same pruning for the reaction marker registry.
function pruneReactionEcho(now: number): void {
  for (const [key, exp] of postedReactions) {
    if (exp <= now) postedReactions.delete(key);
  }
}

// The reaction echo key: a Slack message ts + Cyborg emoji + direction uniquely
// identifies the bot-echo event our own reactions.add/remove will trigger.
function reactionEchoKey(slackTs: string, emoji: string, action: "added" | "removed"): string {
  return `${slackTs}:${emoji}:${action}`;
}

/**
 * Mark a Slack `ts` as one WE JUST POSTED, so the inbound receiver suppresses the
 * bot's-own-message echo Slack delivers for it. Called right after a successful
 * outbound chat.postMessage.
 */
export function markPostedTs(ts: string, now = Date.now()): void {
  if (!ts) return;
  pruneEcho(now);
  postedTs.set(ts, now + ECHO_TTL_MS);
}

/**
 * Did WE recently post this Slack `ts`? Consumes the marker (a single outbound post
 * suppresses a single inbound echo) and returns true only when a still-fresh marker
 * existed. The route dedupes by Slack event_id BEFORE this, so a retried echo of the
 * same event never reaches a second consume.
 */
export function consumePostedTs(ts: string, now = Date.now()): boolean {
  const exp = postedTs.get(ts);
  if (exp === undefined) return false;
  postedTs.delete(ts);
  return exp > now;
}

/** Remember a bot user-id we post as (identity-based echo guard). */
export function rememberOurBotUserId(botUserId: string): void {
  if (botUserId) ourBotUserIds.add(botUserId);
}

/** Is this Slack user-id one of OUR bots? (the inbound bot-echo guard). */
export function isOurBotUserId(botUserId: string | null): boolean {
  return botUserId !== null && ourBotUserIds.has(botUserId);
}

/**
 * Mark a reaction WE JUST APPLIED to Slack (add/remove), so the inbound receiver
 * suppresses the bot's-own reaction_added/removed echo Slack delivers for it. Called
 * right BEFORE the outbound reactions.add/remove call (arm-before, like the edit/delete
 * ts guard). Keyed by the Slack message ts + CYBORG emoji + direction.
 */
export function markPostedReaction(
  slackTs: string,
  emoji: string,
  action: "added" | "removed",
  now = Date.now(),
): void {
  if (!slackTs || !emoji) return;
  pruneReactionEcho(now);
  postedReactions.set(reactionEchoKey(slackTs, emoji, action), now + ECHO_TTL_MS);
}

/**
 * Did WE recently apply this exact reaction (ts + emoji + direction) to Slack? Consumes
 * the marker (a single outbound apply suppresses a single inbound echo) and returns true
 * only when a still-fresh marker existed. The route dedupes by Slack event_id BEFORE
 * this, so a retried echo of the same event never reaches a second consume.
 */
export function consumePostedReaction(
  slackTs: string,
  emoji: string,
  action: "added" | "removed",
  now = Date.now(),
): boolean {
  const key = reactionEchoKey(slackTs, emoji, action);
  const exp = postedReactions.get(key);
  if (exp === undefined) return false;
  postedReactions.delete(key);
  return exp > now;
}

/** TEST-ONLY: clear the echo registries between cases. */
export function _resetSlackEchoGuardForTest(): void {
  postedTs.clear();
  ourBotUserIds.clear();
  postedReactions.clear();
}

// ─── Outbound emit (Slack I/O injectable) ────────────────────────────────────

/** The Cyborg channel-message fields the outbound emit needs (lifted from the
 * broadcast payload at the relay seam). */
export interface OutboundChannelMessage {
  workspaceId: string;
  /** The Cyborg channel the message landed in (resolved to a Slack link). */
  cyborgChannelId: string;
  /** The Cyborg message id (recorded in message_integrations + idempotency key). */
  messageId: string;
  /** The author id — a `slack:<team>:<user>` synthetic id means it CAME FROM Slack
   * (an inbound mirror) and must NOT be re-posted; anything else is Cyborg-originated. */
  fromId: string;
  /** "human" | "agent" | "system" — system messages are not mirrored. */
  fromType: string;
  /** Denormalized display name from the broadcast payload — correct for both humans and
   * cybos. Used as the Slack username override when chat:write.customize is in scope. */
  fromName?: string | null;
  text: string;
  /** The parent Cyborg message id for a thread reply, else null (→ thread root). */
  parentId: string | null;
  /** File attachments on this Cyborg message (lifted from the broadcast payload). Each is
   * downloaded from our S3 (capped) and uploaded to the linked Slack channel. Absent /
   * null / empty on a text-only message. Only the fields the upload needs are read. */
  attachments?: OutboundAttachment[] | null;
}

/** The minimal attachment shape the outbound file mirror needs, lifted from the Cyborg
 * message's `attachments` JSONB (which also carries key/width/height/etc. we ignore). */
export interface OutboundAttachment {
  /** The delivery URL the bytes are fetched from (our S3 asset URL). */
  url: string;
  /** The display filename (Slack file title + name). */
  name: string;
  /** The MIME type — advisory; the upload doesn't re-gate on it. */
  type: string;
  /** The stored byte size — a cheap pre-cap check before the streamed download. */
  size: number;
}

/** The Slack post surface, injected so the emit is unit-testable without network.
 * The default is the real `slackAdapter`. */
export interface SlackPoster {
  postMessage(token: string, args: PostMessageArgs): Promise<PostMessageResult>;
}

/** The Slack file-upload surface, injected so the emit is unit-testable without network. */
export interface SlackFileUploader {
  uploadFile(token: string, args: UploadFileArgs): Promise<void>;
}

/** Why an outbound mirror was skipped (returned for tests/observability; the relay
 * hook ignores it). "posted" means a Slack post was actually made. */
export type OutboundOutcome =
  | "posted"
  | "synthetic-author" // came from Slack — never re-post (inbound-echo guard).
  | "system-author" // a "X joined" style system row — not customer content.
  | "empty-text" // Slack rejects an empty body.
  | "not-configured" // SLACK_* secrets absent — feature inert.
  | "no-link" // channel isn't Slack-linked.
  | "inbound-only" // link is inbound-only — don't write back.
  | "no-token" // installation has no bot token.
  | "already-mirrored"; // this Cyborg message already has a mapping.

/** Resolve the Slack per-sender identity override for an outbound message. Returns
 * {} (post as the bot) unless the install has chat:write.customize AND we can resolve
 * a display name; icon_url is set only from an absolute http(s) avatar. Never throws. */
export async function resolveSenderIdentity(
  pg: PgSync,
  msg: OutboundChannelMessage,
  scopes: string | null,
): Promise<{ username?: string; iconUrl?: string }> {
  // Gate: the customize scope is required for username/icon_url; without it, posting
  // these can hard-fail. Post as the bot (current behavior) until the install adds it.
  if (
    !scopes ||
    !scopes
      .split(",")
      .map((s) => s.trim())
      .includes("chat:write.customize")
  ) {
    return {};
  }
  try {
    let username = msg.fromName?.trim() || undefined;
    let avatar: string | null = null;
    if (msg.fromType === "human") {
      const u = await pg.getUserById(msg.fromId);
      if (u) {
        username = username || u.name?.trim() || undefined;
        avatar = u.imageUrl;
      }
    } else if (msg.fromType === "agent") {
      const c = await pg.getCyboById(msg.fromId);
      if (c) {
        username = username || c.name?.trim() || undefined;
        avatar = c.avatar;
      }
    }
    const iconUrl = avatar && /^https?:\/\//i.test(avatar) ? avatar : undefined;
    return { ...(username ? { username } : {}), ...(iconUrl ? { iconUrl } : {}) };
  } catch (err) {
    console.error("[slack] resolveSenderIdentity failed (posting as bot)", err);
    return {};
  }
}

/**
 * Mirror ONE Cyborg channel message to its linked Slack channel, as the bot.
 * Best-effort + echo-guarded:
 *   - a `slack:` synthetic author is the inbound mirror itself → never re-posted;
 *   - a system message is skipped;
 *   - gated on isSlackConfigured() + a live installation token + a bidirectional
 *     (or outbound) link;
 *   - idempotent on the Cyborg message id (a message already in message_integrations
 *     is never double-posted), which also covers a cybo reply re-broadcast.
 * On a successful post it records the new ts in message_integrations and marks the
 * echo guard. A message with file attachments ALSO uploads each to the linked Slack
 * channel (best-effort, streamed + size-capped); an attachment-only message (empty
 * text) still uploads its files but keeps the claim as a `pending:` sentinel (no chat
 * message ts to map). The `slack:` synthetic-author short-circuit also means an inbound-
 * rehosted message's files are NEVER re-uploaded back to Slack. Throws only if the
 * injected poster rejects AND the caller doesn't wrap it — the relay hook wraps in
 * `void … .catch()`, so it never blocks the post path.
 */
export async function mirrorChannelMessageToSlack(
  pg: PgSync,
  msg: OutboundChannelMessage,
  poster: SlackPoster = slackAdapter,
  uploader: SlackFileUploader = slackAdapter,
): Promise<OutboundOutcome> {
  // Inbound-echo guard (direction 1): a message authored by a `slack:` synthetic
  // guest IS an inbound mirror — re-posting it (or re-uploading its rehosted files)
  // would loop it straight back to Slack.
  if (msg.fromId.startsWith(`${SLACK_PROVIDER}:`)) return "synthetic-author";
  if (msg.fromType === "system") return "system-author";
  const hasText = !!msg.text && !!msg.text.trim();
  const attachments = normalizeOutboundAttachments(msg.attachments);
  // Nothing to mirror at all (Slack rejects an empty message and there are no files).
  if (!hasText && attachments.length === 0) return "empty-text";
  if (!isSlackConfigured()) return "not-configured";

  const link = await pg.getSlackChannelLinkByCyborgChannel(msg.cyborgChannelId);
  if (!link) return "no-link";
  // An inbound-only link mirrors Slack→Cyborg but not back. Bidirectional (default)
  // and any future outbound-only direction write back.
  if (link.syncDirection === "inbound") return "inbound-only";

  const installation = await pg.getIntegrationInstallationById(link.installationId);
  if (!installation?.accessToken) return "no-token";

  // Idempotency (ATOMIC, not a read-then-post TOCTOU): claim this Cyborg message's
  // mirror slot BEFORE the network post. claimMessageIntegration is an INSERT … ON
  // CONFLICT (message_id) DO NOTHING on the PK, so of two concurrent re-broadcasts of
  // the SAME message (a cybo reply the relay re-broadcasts via MCP-send + stream-flush,
  // or a daemon replay of an unacked relay_message) exactly ONE wins the claim — the
  // loser returns here without posting. A bare read-then-post let both read null and
  // BOTH post. An already-mapped message (mirrored, or itself an inbound row) also fails
  // the claim.
  if (
    !(await pg.claimMessageIntegration({
      messageId: msg.messageId,
      workspaceId: msg.workspaceId,
      provider: SLACK_PROVIDER,
    }))
  ) {
    return "already-mirrored";
  }

  const token = installation.accessToken;
  try {
    // Thread resolution: a reply posts under the Slack thread root its PARENT was mapped to
    // (extracted so this function stays under the complexity budget).
    const threadTs = await resolveOutboundThreadTs(pg, msg.parentId);

    // Post the text (when present). An attachment-only message skips this and keeps the
    // claim's `pending:` sentinel — the files still upload below, and edit/delete/reaction
    // mirrors gracefully no-op on a pending mapping (there's no chat message ts to target).
    if (hasText) {
      await postTextAndRecordMapping(pg, poster, msg, {
        channelId: link.slackChannelId,
        token,
        scopes: installation.scopes,
        botUserId: installation.botUserId,
        threadTs,
      });
    }

    // Upload attachments into the SAME linked Slack channel, under the SAME thread the
    // text used (a threaded Cyborg message's files land in that Slack thread; a root
    // message's files land top-level). Best-effort per file: a download/upload failure is
    // logged and skipped, never failing the (already-committed) text mirror or throwing.
    if (attachments.length > 0) {
      await uploadAttachmentsToSlack(uploader, token, link.slackChannelId, threadTs, attachments);
    }
    return "posted";
  } catch (err) {
    // The post (or its bookkeeping) failed — release the claim so a later re-broadcast
    // can retry the mirror instead of being wrongly treated as already-posted, then
    // always re-throw the ORIGINAL `err`. releaseOutboundClaim NEVER throws, so a second
    // DB failure during release can't mask the original error or leave the claim dangling
    // silently — the message can't be stuck "claimed" forever with its real cause lost.
    await releaseOutboundClaim(pg, msg.messageId);
    throw err;
  }
}

/** Resolve the Slack thread root an outbound reply posts under: the ts its Cyborg PARENT
 * was mapped to. An unmapped parent (root predates the link) or a parent still mid-claim
 * (its external_id is a `pending:<id>` sentinel, not a real ts) → undefined (a top-level
 * post). Keep "pending:" in sync with claimMessageIntegration. */
async function resolveOutboundThreadTs(
  pg: PgSync,
  parentId: string | null,
): Promise<string | undefined> {
  if (!parentId) return undefined;
  const parentMap = await pg.getMessageIntegrationByMessageId(parentId);
  const parentExternal = parentMap?.externalId;
  return parentExternal && !parentExternal.startsWith("pending:") ? parentExternal : undefined;
}

/** The resolved per-install context a text post needs. */
interface TextPostContext {
  channelId: string;
  token: string;
  scopes: string | null;
  botUserId: string | null;
  threadTs: string | undefined;
}

/** Post the text as the (per-sender) identity, arm the echo guard, and fill the claimed
 * message_integrations row with the real Slack ts (so future thread replies resolve under
 * it). Extracted from mirrorChannelMessageToSlack to keep it under the complexity budget. */
async function postTextAndRecordMapping(
  pg: PgSync,
  poster: SlackPoster,
  msg: OutboundChannelMessage,
  ctx: TextPostContext,
): Promise<void> {
  const identity = await resolveSenderIdentity(pg, msg, ctx.scopes);
  const res = await poster.postMessage(ctx.token, {
    channelId: ctx.channelId,
    text: msg.text,
    ...(ctx.threadTs ? { threadTs: ctx.threadTs } : {}),
    ...identity,
  });

  // Echo guard: the per-install bot identity is the AUTHORITATIVE cross-instance guard
  // (routes/slack.ts reads it from shared Postgres); the in-memory ts + user-id sets are
  // same-instance fast-paths only.
  markPostedTs(res.ts);
  if (ctx.botUserId) rememberOurBotUserId(ctx.botUserId);

  await pg.upsertMessageIntegration({
    messageId: msg.messageId,
    workspaceId: msg.workspaceId,
    provider: SLACK_PROVIDER,
    externalId: res.ts,
    externalThreadId: ctx.threadTs ?? null,
  });
}

/**
 * Release a claimed mirror slot after an outbound post failed, so a later re-broadcast can
 * retry instead of being wrongly treated as already-posted. If the release ITSELF throws (a
 * second DB failure) this LOGS and swallows it rather than propagating: the caller re-throws
 * the ORIGINAL post error, so the real cause is never replaced and a dangling claim is always
 * surfaced (no silent message loss).
 */
async function releaseOutboundClaim(pg: PgSync, messageId: string): Promise<void> {
  try {
    await pg.deleteMessageIntegration(messageId);
  } catch (releaseErr) {
    console.error("[slack] failed to release outbound claim after post failure", {
      err: releaseErr,
      messageId,
    });
  }
}

// ─── Outbound FILE mirror (Cyborg → Slack) ───────────────────────────────────

// Coerce the untrusted broadcast `attachments` into the minimal shape the upload needs,
// dropping anything malformed / without an http(s) URL. Defensive over `unknown` because
// the relay seam lifts this straight from the broadcast payload.
function normalizeOutboundAttachments(raw: unknown): OutboundAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: OutboundAttachment[] = [];
  for (const a of raw) {
    if (typeof a !== "object" || a === null) continue;
    const rec = a as Record<string, unknown>;
    const url = typeof rec.url === "string" ? rec.url : "";
    if (!/^https?:\/\//i.test(url)) continue;
    const name = typeof rec.name === "string" && rec.name ? rec.name : "file";
    const type = typeof rec.type === "string" ? rec.type : "application/octet-stream";
    const size = typeof rec.size === "number" && Number.isFinite(rec.size) ? rec.size : 0;
    out.push({ url, name, type, size });
  }
  return out;
}

// Stream a fetch body into a Buffer, aborting the moment it exceeds `cap`. Mirrors the
// INBOUND rehostSlackFile discipline (routes/slack.ts): never holds more than cap + one
// chunk, cancels the stream on overflow, so a lying/absent Content-Length can't OOM the
// relay. Returns null on overflow / missing body.

function isPrivateIPv4(addr: string): boolean {
  const [a, b] = addr.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return true; // "this host", private, loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64.0.0/10)
  if (a >= 224) return true; // multicast + reserved (224.0.0.0/4, 240.0.0.0/4)
  return false;
}

function isPrivateIPv6(addr: string): boolean {
  const low = addr.toLowerCase();
  if (low === "::1" || low === "::") return true; // loopback + unspecified
  if (low.startsWith("fc") || low.startsWith("fd")) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(low)) return true; // link-local fe80::/10
  return false;
}

// Is this a private, loopback, link-local, ULA, CGNAT, or otherwise non-public address?
// (IPv4-mapped IPv6 is unwrapped so `::ffff:169.254.169.254` can't smuggle the metadata IP.)
export function isPrivateAddress(ip: string): boolean {
  let addr = ip;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) addr = mapped[1];
  if (net.isIPv4(addr)) return isPrivateIPv4(addr);
  if (net.isIPv6(addr)) return isPrivateIPv6(addr);
  return true; // unresolvable / unknown family → refuse
}

// SSRF guard: outbound attachment URLs come off a Cyborg message and are only supposed to
// be our own S3 assets, but the message API doesn't pin the host — a crafted attachment
// could point `url` at an internal address (e.g. the cloud metadata endpoint). Only ever
// fetch HTTPS hosts that resolve exclusively to public addresses.
export async function isSafePublicUrl(raw: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 literal brackets
  if (net.isIP(host)) return !isPrivateAddress(host);
  try {
    const resolved = await lookup(host, { all: true });
    if (resolved.length === 0) return false;
    return resolved.every((r) => !isPrivateAddress(r.address));
  } catch {
    return false;
  }
}

async function downloadCapped(url: string, cap: number): Promise<Buffer | null> {
  if (!(await isSafePublicUrl(url))) {
    console.error("[slack] outbound file: refusing non-public/non-https attachment url");
    return null;
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    // `redirect: "error"` so a 30x can't bounce past the host check to an internal address.
    const res = await fetch(url, { redirect: "error" });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > cap) {
      await res.body?.cancel();
      return null;
    }
    reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch (err) {
    // intentional: best-effort cleanup — cancelling an already-erroring reader isn't actionable.
    await reader?.cancel().catch(() => {});
    console.error("[slack] outbound file download failed", err);
    return null;
  }
}

/**
 * Upload each Cyborg attachment to the linked Slack channel (best-effort). For every file:
 * skip an over-cap `size` up front, download the bytes from our S3 with the SAME
 * MAX_ATTACHMENT_BYTES streamed cap the inbound path uses, then upload via the injected
 * uploader (Slack external-upload flow) into `channelId` under `threadTs`. A per-file
 * download/upload failure is logged and skipped — it NEVER throws, so the (committed)
 * text mirror is never rolled back by a bad attachment.
 */
async function uploadAttachmentsToSlack(
  uploader: SlackFileUploader,
  token: string,
  channelId: string,
  threadTs: string | undefined,
  attachments: OutboundAttachment[],
): Promise<void> {
  for (const att of attachments) {
    try {
      // Cheap pre-cap on the stored size before spending a download.
      if (att.size > MAX_ATTACHMENT_BYTES) {
        console.error(`[slack] outbound file "${att.name}": stored size over cap, skipped`);
        continue;
      }
      const data = await downloadCapped(att.url, MAX_ATTACHMENT_BYTES);
      if (!data || data.length === 0) continue;
      await uploader.uploadFile(token, {
        channelId,
        ...(threadTs ? { threadTs } : {}),
        filename: att.name,
        data,
      });
    } catch (err) {
      console.error(`[slack] outbound file "${att.name}" upload failed (skipped)`, err);
    }
  }
}

// ─── Outbound REACTION mirror (Cyborg → Slack) ───────────────────────────────

/** The Slack reaction surface, injected so the emit is unit-testable without network. */
export interface SlackReactor {
  addReaction(token: string, args: ReactionArgs): Promise<void>;
  removeReaction(token: string, args: ReactionArgs): Promise<void>;
}

/** The Cyborg reaction-change fields the outbound reaction emit needs (lifted from the
 * `cyborg:reaction` handler after toggleReaction). */
export interface OutboundReaction {
  workspaceId: string;
  cyborgChannelId: string;
  /** The Cyborg message the reaction is on (resolved to a Slack ts via message_integrations). */
  messageId: string;
  /** The Cyborg reaction key — a raw Unicode emoji char (e.g. "👍"), mapped to a Slack name. */
  emoji: string;
  /** Whether the reaction was added or removed (from toggleReaction's result). */
  action: "added" | "removed";
}

/** Why an outbound reaction mirror was skipped or completed. "added"/"removed" mean a
 * Slack reactions.add/remove was actually called. */
export type OutboundReactionOutcome =
  | "added"
  | "removed"
  | "not-configured"
  | "not-mirrored" // the Cyborg message has no Slack mapping (or wrong provider).
  | "pending" // the mapping's external_id is still a pending: sentinel (mid-claim / file-only).
  | "unmapped-emoji" // no Slack name for this emoji (custom/uncurated) — nothing to post.
  | "no-link"
  | "inbound-only"
  | "no-token";

/**
 * Mirror a Cyborg reaction add/remove to its linked Slack channel via reactions.add /
 * reactions.remove (as the bot). Best-effort + echo-guarded + tenant-scoped:
 *   - resolves the Slack ts from the Cyborg message id (message_integrations); an
 *     unmirrored / still-pending message is a no-op;
 *   - maps the Unicode emoji to a Slack reaction name (an uncurated emoji is a no-op);
 *   - enforces the slack_channel_links workspace/team scope (only ever reacts on the
 *     correctly-linked channel) + a bidirectional (non-inbound) link;
 *   - arms the reaction echo guard BEFORE the API call so the reaction_added/removed
 *     event Slack delivers for our own bot reaction is dropped inbound (same-instance
 *     fast path), with the per-install bot-identity check as the authoritative guard.
 * Throws only when the injected reactor rejects — the relay hook wraps in void … .catch().
 */
export async function mirrorReactionToSlack(
  pg: PgSync,
  r: OutboundReaction,
  reactor: SlackReactor = slackAdapter,
): Promise<OutboundReactionOutcome> {
  if (!isSlackConfigured()) return "not-configured";

  const map = await pg.getMessageIntegrationByMessageId(r.messageId);
  if (!map || map.provider !== SLACK_PROVIDER) return "not-mirrored";
  // A pending: sentinel means the outbound create is still mid-claim (or a file-only
  // message with no chat ts) — there's no real Slack ts to react on.
  if (map.externalId.startsWith("pending:")) return "pending";

  const slackName = emojiToSlackName(r.emoji);
  if (!slackName) return "unmapped-emoji";

  const link = await pg.getSlackChannelLinkByCyborgChannel(r.cyborgChannelId);
  if (!link) return "no-link";
  if (link.syncDirection === "inbound") return "inbound-only";

  const installation = await pg.getIntegrationInstallationById(link.installationId);
  if (!installation?.accessToken) return "no-token";

  // Echo guard: arm BEFORE the API call, keyed by the CYBORG emoji so it survives Slack's
  // reaction-name aliasing. The reaction_added/removed event Slack delivers for our own
  // reactions.add/remove is dropped inbound by consumePostedReaction (same-instance fast
  // path); the authoritative cross-instance guard is the per-install bot-identity check in
  // routes/slack.ts (event.user === installation.botUserId).
  markPostedReaction(map.externalId, r.emoji, r.action);
  if (installation.botUserId) rememberOurBotUserId(installation.botUserId);

  const args: ReactionArgs = {
    channelId: link.slackChannelId,
    ts: map.externalId,
    name: slackName,
  };
  if (r.action === "added") {
    await reactor.addReaction(installation.accessToken, args);
    return "added";
  }
  await reactor.removeReaction(installation.accessToken, args);
  return "removed";
}

// ─── Outbound EDIT / DELETE mirrors (WAVE 2.1) ───────────────────────────────

/** The Slack edit surface, injected so the emit is unit-testable without network. */
export interface SlackEditor {
  updateMessage(token: string, args: UpdateMessageArgs): Promise<void>;
}

/** The Slack delete surface, injected so the emit is unit-testable without network. */
export interface SlackDeleter {
  deleteMessage(token: string, args: DeleteMessageArgs): Promise<void>;
}

/** Why an outbound edit mirror was skipped or completed. "updated" means a Slack
 * chat.update was actually made. */
export type OutboundEditOutcome =
  | "updated"
  | "empty-text" // chat.update requires a non-empty body.
  | "not-configured" // SLACK_* secrets absent — feature inert.
  | "not-mirrored" // this Cyborg message has no Slack mapping (or wrong provider).
  | "pending" // the mapping's external_id is still a pending: sentinel (mid-claim).
  | "no-link" // the Cyborg channel has no Slack link.
  | "inbound-only" // link is inbound-only — we don't own the Slack side.
  | "no-token"; // installation has no bot token.

/** Why an outbound delete mirror was skipped or completed. "deleted" means a Slack
 * chat.delete was actually made. */
export type OutboundDeleteOutcome =
  | "deleted"
  | "not-configured"
  | "not-mirrored"
  | "pending"
  | "no-link"
  | "inbound-only"
  | "no-token";

/** The Cyborg channel-message edit fields the outbound edit emit needs. */
export interface OutboundEdit {
  workspaceId: string;
  cyborgChannelId: string;
  messageId: string;
  text: string;
}

/** The Cyborg channel-message delete fields the outbound delete emit needs. */
export interface OutboundDelete {
  workspaceId: string;
  cyborgChannelId: string;
  messageId: string;
}

/**
 * Mirror a Cyborg message edit to its linked Slack channel via chat.update.
 * Best-effort + echo-guarded:
 *   - looks up the message_integrations mapping by Cyborg message id;
 *   - gates on isSlackConfigured() + a live installation token + a bidirectional link;
 *   - arms the echo guard BEFORE the API call so the message_changed Slack delivers for
 *     our own update is dropped inbound by consumePostedTs (same-instance fast path) or
 *     by the authoritative per-install bot-identity check in routes/slack.ts.
 * Throws only when the injected editor rejects — the relay hook wraps in void … .catch().
 */
export async function mirrorEditToSlack(
  pg: PgSync,
  edit: OutboundEdit,
  editor: SlackEditor = slackAdapter,
): Promise<OutboundEditOutcome> {
  if (!edit.text.trim()) return "empty-text";
  if (!isSlackConfigured()) return "not-configured";

  const map = await pg.getMessageIntegrationByMessageId(edit.messageId);
  if (!map || map.provider !== SLACK_PROVIDER) return "not-mirrored";
  // The pending: sentinel means the outbound create is still mid-claim — no real ts yet.
  if (map.externalId.startsWith("pending:")) return "pending";

  const link = await pg.getSlackChannelLinkByCyborgChannel(edit.cyborgChannelId);
  if (!link) return "no-link";
  if (link.syncDirection === "inbound") return "inbound-only";

  const installation = await pg.getIntegrationInstallationById(link.installationId);
  if (!installation?.accessToken) return "no-token";

  // Echo guard: arm BEFORE the API call. The message_changed event Slack delivers for
  // our own chat.update is dropped inbound by consumePostedTs (same-instance fast path);
  // the authoritative cross-instance guard is the per-install bot-identity check in
  // routes/slack.ts (installation.botUserId === msg.userId via shared Postgres).
  markPostedTs(map.externalId);
  if (installation.botUserId) rememberOurBotUserId(installation.botUserId);

  await editor.updateMessage(installation.accessToken, {
    channelId: link.slackChannelId,
    ts: map.externalId,
    text: edit.text,
  });
  return "updated";
}

/**
 * Mirror a Cyborg message delete to its linked Slack channel via chat.delete.
 * Best-effort + echo-guarded (same gating as mirrorEditToSlack, minus the empty-text check).
 * The message_integrations mapping is intentionally left intact after the delete — it is
 * harmless and removing it could break future thread resolution for replies.
 * Arms the echo guard BEFORE the API call for the same reason as mirrorEditToSlack.
 */
export async function mirrorDeleteToSlack(
  pg: PgSync,
  del: OutboundDelete,
  deleter: SlackDeleter = slackAdapter,
): Promise<OutboundDeleteOutcome> {
  if (!isSlackConfigured()) return "not-configured";

  const map = await pg.getMessageIntegrationByMessageId(del.messageId);
  if (!map || map.provider !== SLACK_PROVIDER) return "not-mirrored";
  if (map.externalId.startsWith("pending:")) return "pending";

  const link = await pg.getSlackChannelLinkByCyborgChannel(del.cyborgChannelId);
  if (!link) return "no-link";
  if (link.syncDirection === "inbound") return "inbound-only";

  const installation = await pg.getIntegrationInstallationById(link.installationId);
  if (!installation?.accessToken) return "no-token";

  // Echo guard: arm BEFORE the API call. The message_deleted event Slack delivers for
  // our own chat.delete is dropped inbound by consumePostedTs (same-instance fast path);
  // the authoritative cross-instance guard is the per-install bot-identity check in
  // routes/slack.ts (installation.botUserId === msg.userId via shared Postgres).
  markPostedTs(map.externalId);
  if (installation.botUserId) rememberOurBotUserId(installation.botUserId);

  await deleter.deleteMessage(installation.accessToken, {
    channelId: link.slackChannelId,
    ts: map.externalId,
  });
  return "deleted";
}
