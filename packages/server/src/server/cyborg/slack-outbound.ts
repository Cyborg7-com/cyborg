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
import type { PostMessageArgs, PostMessageResult } from "./integrations/types.js";

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

// Drop expired markers so the Map can't grow unbounded across a long-lived relay.
function pruneEcho(now: number): void {
  for (const [ts, exp] of postedTs) {
    if (exp <= now) postedTs.delete(ts);
  }
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

/** TEST-ONLY: clear the echo registries between cases. */
export function _resetSlackEchoGuardForTest(): void {
  postedTs.clear();
  ourBotUserIds.clear();
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
  text: string;
  /** The parent Cyborg message id for a thread reply, else null (→ thread root). */
  parentId: string | null;
}

/** The Slack post surface, injected so the emit is unit-testable without network.
 * The default is the real `slackAdapter`. */
export interface SlackPoster {
  postMessage(token: string, args: PostMessageArgs): Promise<PostMessageResult>;
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
 * echo guard. Throws only if the injected poster rejects AND the caller doesn't wrap
 * it — the relay hook wraps in `void … .catch()`, so it never blocks the post path.
 */
export async function mirrorChannelMessageToSlack(
  pg: PgSync,
  msg: OutboundChannelMessage,
  poster: SlackPoster = slackAdapter,
): Promise<OutboundOutcome> {
  // Inbound-echo guard (direction 1): a message authored by a `slack:` synthetic
  // guest IS an inbound mirror — re-posting it would loop it straight back to Slack.
  if (msg.fromId.startsWith(`${SLACK_PROVIDER}:`)) return "synthetic-author";
  if (msg.fromType === "system") return "system-author";
  if (!msg.text || !msg.text.trim()) return "empty-text";
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

  try {
    // Thread resolution: a reply posts under the Slack thread root its PARENT was mapped
    // to. An unmapped parent (the root predates the link), or a parent still mid-claim
    // (its external_id is the `pending:<id>` sentinel, not yet a real Slack ts) → a
    // top-level post. (Keep "pending:" in sync with claimMessageIntegration.)
    let threadTs: string | undefined;
    if (msg.parentId) {
      const parentMap = await pg.getMessageIntegrationByMessageId(msg.parentId);
      const parentExternal = parentMap?.externalId;
      threadTs =
        parentExternal && !parentExternal.startsWith("pending:") ? parentExternal : undefined;
    }

    const res = await poster.postMessage(installation.accessToken, {
      channelId: link.slackChannelId,
      text: msg.text,
      ...(threadTs ? { threadTs } : {}),
    });

    // Echo guard: the per-install bot identity is the AUTHORITATIVE cross-instance guard
    // (routes/slack.ts reads it from shared Postgres); the in-memory ts + user-id sets
    // are same-instance fast-paths only.
    markPostedTs(res.ts);
    if (installation.botUserId) rememberOurBotUserId(installation.botUserId);

    // Fill the claimed row with the real Slack ts so future threads resolve under it.
    await pg.upsertMessageIntegration({
      messageId: msg.messageId,
      workspaceId: msg.workspaceId,
      provider: SLACK_PROVIDER,
      externalId: res.ts,
      externalThreadId: threadTs ?? null,
    });
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
