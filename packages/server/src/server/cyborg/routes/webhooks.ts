import { Hono } from "hono";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PgSync, StoredWebhookWithSecret } from "../db/pg-sync.js";
import type { WorkspaceRelay } from "../workspace-relay.js";
import { hashMcpToken } from "../mcp/token.js";
import { synthesizeReleaseCard, synthesizeEventCard, type MessageCard } from "../webhook-card.js";
import { fireWebhookCybo, type WebhookCyboFireResult } from "../webhook-cybo-fire.js";
import type { RelayEnv } from "./types.js";

export interface WebhookRoutesDeps {
  pg: PgSync | null;
  relay: WorkspaceRelay;
  // Mint a relay user JWT for the webhook creator, so a webhook-triggered fire is
  // forwarded to the daemon as a relay_rpc attributed to the creator (parity with
  // a mention forward, which reuses the guest's token). Optional: when absent (or
  // pg absent), webhook-triggered fires are skipped and only the card renders —
  // back-compat for callers/tests that don't wire the cybo-fire path.
  mintUserToken?: (email: string, name?: string | null) => string;
}

// Normalize a parsed body into a payload object. A bare string (valid JSON
// string, or non-JSON text) is treated as the text; anything else falls back to
// an empty object. Kept out of the route handler to avoid a nested ternary and
// to keep the handler's complexity within the lint budget.
function normalizePayload(body: unknown): Record<string, unknown> {
  if (typeof body === "string") return { text: body };
  if (typeof body === "object" && body) return body as Record<string, unknown>;
  return {};
}

// Constant-time compare of the GitHub `X-Hub-Signature-256` header against the
// HMAC-SHA256 of the raw body keyed by the webhook secret. GitHub sends
// `sha256=<hex>`. Returns true only on an exact, length-matched match — the
// timingSafeEqual call is itself length-guarded to avoid a throw on mismatch.
function verifySignature(rawBody: string, secret: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Decide whether an event passes the webhook's event selection. `release` mode
// only lets `release` through; `all` lets everything; `select` checks the
// allowlist. A webhook with no config row (legacy token-only) lets everything.
function eventAllowed(
  eventMode: string | null,
  events: string[],
  githubEvent: string | null,
): boolean {
  if (!eventMode || eventMode === "all") return true;
  if (eventMode === "release") return githubEvent === "release" || githubEvent === null;
  if (eventMode === "select") {
    if (events.length === 0) return true;
    return githubEvent === null || events.includes(githubEvent);
  }
  return true;
}

// The structured + fallback content a delivery turns into. `card` is null for a
// generic (non-release) post; `text` is always present.
interface BuiltMessage {
  text: string;
  card: MessageCard | null;
  fromName: string;
}

// Build the message content from the raw payload, branching on the GitHub event.
// A `release` (published/released) becomes a rich release card + a markdown text
// fallback; everything else uses the existing Slack-compatible `{text}` shape.
function buildMessage(
  githubEvent: string | null,
  payload: Record<string, unknown>,
): BuiltMessage | { error: string; status: 400 | 413 } | { ignored: true } {
  const WEBHOOK_MAX_TEXT = 16_000;

  // `ping` is GitHub's one-time setup handshake (no user activity) — acknowledge
  // it (2xx) without posting anything.
  if (githubEvent === "ping") return { ignored: true };

  // GitHub events → a rich card. `release` has its own (markdown changelog) card;
  // every other event goes through the generic synthesizer (PRs, issues, pushes,
  // CI, deploys, + a neutral fallback). A null result means "an event/action we
  // don't render" — ignore gracefully (GitHub payloads carry no top-level `text`,
  // so the generic path below would 400 and GitHub would disable the hook).
  if (githubEvent) {
    const synthesized =
      githubEvent === "release"
        ? synthesizeReleaseCard(payload)
        : synthesizeEventCard(githubEvent, payload);
    if (synthesized) {
      return {
        text: synthesized.text,
        card: synthesized.card,
        fromName: synthesized.fromName,
      };
    }
    return { ignored: true };
  }

  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) return { error: "missing text", status: 400 };
  if (text.length > WEBHOOK_MAX_TEXT) {
    return { error: `text exceeds ${WEBHOOK_MAX_TEXT} chars`, status: 413 };
  }
  const username =
    typeof payload.username === "string" && payload.username.trim()
      ? payload.username.trim().slice(0, 80)
      : "Webhook";
  return { text, card: null, fromName: username };
}

// A small allowlist of request headers worth keeping for the delivery log (the
// GitHub metadata + content type) — we never store the Authorization header.
function captureHeaders(c: {
  req: { header: (n: string) => string | undefined };
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [
    "x-github-event",
    "x-github-delivery",
    "x-hub-signature-256",
    "content-type",
    "user-agent",
  ]) {
    const v = c.req.header(name);
    if (v) out[name] = name === "x-hub-signature-256" ? "sha256=***" : v;
  }
  return out;
}

// Resolve the bearer credential to a write-scoped MCP token, enforcing the
// workspace master switch. Returns the token, or a JSON error response to send.
// Extracted to keep the route handler's cyclomatic complexity within budget.
async function resolveToken(
  pg: PgSync,
  c: {
    req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined };
  },
): Promise<
  | { token: NonNullable<Awaited<ReturnType<PgSync["getMcpTokenByHash"]>>> }
  | { error: string; status: 401 | 403 }
> {
  const authHeader = c.req.header("authorization");
  const rawToken =
    authHeader && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : (c.req.query("token") ?? "").trim();
  if (!rawToken) return { error: "missing token", status: 401 };

  const token = await pg.getMcpTokenByHash(hashMcpToken(rawToken));
  if (!token) return { error: "invalid or revoked token", status: 401 };
  if (!token.scopes.includes("write")) return { error: "token lacks write scope", status: 403 };
  if (!(await pg.getMcpEnabled(token.workspaceId))) {
    return { error: "external access is disabled for this workspace", status: 403 };
  }
  return { token };
}

// Authenticate an inbound webhook by EITHER a valid HMAC signature (keyed by the
// channel webhook's secret — exactly how GitHub authenticates, NO MCP token
// needed) OR a write-scoped MCP token (for secret-less webhooks / programmatic
// posters). Identity is the webhook (workspace + createdBy) on the signature path,
// the token on the token path. Extracted from the route handler to keep its
// cyclomatic complexity within budget.
async function authenticateWebhook(
  pg: PgSync,
  c: {
    req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined };
  },
  webhook: Awaited<ReturnType<PgSync["getActiveWebhookForChannel"]>>,
  rawBody: string,
): Promise<
  | { ok: true; workspaceId: string; fromId: string; tokenId: string | null }
  | { ok: false; status: 401 | 403; error: string }
> {
  const signatureHeader = c.req.header("x-hub-signature-256");
  const sigValid = !!webhook?.secret && verifySignature(rawBody, webhook.secret, signatureHeader);
  if (sigValid && webhook) {
    return { ok: true, workspaceId: webhook.workspaceId, fromId: webhook.createdBy, tokenId: null };
  }
  // No valid signature → fall back to token auth (a GitHub delivery carries none).
  const tokenResult = await resolveToken(pg, c);
  if ("token" in tokenResult) {
    return {
      ok: true,
      workspaceId: tokenResult.token.workspaceId,
      fromId: tokenResult.token.identityId,
      tokenId: tokenResult.token.id,
    };
  }
  // Neither authenticated. A present-but-invalid signature (secret configured +
  // header sent) reports "invalid signature"; otherwise the precise token error.
  if (webhook?.secret && signatureHeader) {
    return { ok: false, status: 401, error: "invalid signature" };
  }
  return { ok: false, status: tokenResult.status, error: tokenResult.error };
}

// Post the built message into the channel via the relay's inject path. Returns
// the new message id. Kept separate so the route handler stays small.
function injectWebhookMessage(
  relay: WorkspaceRelay,
  opts: { workspaceId: string; channelId: string; fromId: string; built: BuiltMessage },
): string {
  const messageId = randomUUID();
  relay.injectMessage(
    opts.workspaceId,
    {
      type: "cyborg:channel_message_broadcast",
      payload: {
        id: messageId,
        workspaceId: opts.workspaceId,
        channelId: opts.channelId,
        fromId: opts.fromId,
        fromType: "human",
        fromName: opts.built.fromName,
        toId: null,
        text: opts.built.text,
        mentions: null,
        parentId: null,
        attachments: null,
        // Structured release card (null for the generic path) — carried through
        // persist + broadcast so the client renders ReleaseCard.svelte. The
        // client derives the bot/repo avatar from the card (release author) and
        // the "webhook" source below, so a post never shows the token owner's face.
        card: opts.built.card,
        // Marks the message as an automation for persistence + the UI badge.
        source: "webhook",
        createdAt: Date.now(),
      },
    },
    opts.fromId,
  );
  return messageId;
}

// Webhook-triggered cybo fire (#620, scheduler phase 3). When the matched webhook
// row has `trigger_cybo_id` set, fire that cybo IN ADDITION to the card: forward a
// mention-shaped invoke to the owning daemon over the existing relay_rpc path (same
// DAEMON_FORWARD_TYPES transport the mention orchestrator uses), with the
// prompt_template rendered from the (escaped) event payload. Shares the runner's
// authority/license/overlap guards via webhook-cybo-fire.ts — it does NOT bypass
// them. Fire-and-forget + best-effort: a fire failure never blocks the card post
// (already injected) or the 2xx ack; the outcome is returned for the delivery log.
//
// Identity: the fire runs under the webhook CREATOR's authority (webhook.createdBy)
// — exactly who the card is attributed to — so the daemon's spawn re-validation and
// the relay-side scope/membership/license guards all check that one identity.
async function maybeFireTriggerCybo(
  deps: {
    pg: PgSync;
    relay: WorkspaceRelay;
    mintUserToken: (email: string, name?: string | null) => string;
  },
  opts: {
    webhook: StoredWebhookWithSecret;
    workspaceId: string;
    channelId: string;
    channelName: string;
    messageId: string;
    eventLabel: string;
    payload: Record<string, unknown>;
  },
): Promise<WebhookCyboFireResult | null> {
  const triggerCyboId = opts.webhook.triggerCyboId;
  if (!triggerCyboId) return null; // card-only webhook (today's behavior) — no fire.

  const creatorId = opts.webhook.createdBy;
  // The creator's email is needed to mint the relay JWT; their role to populate
  // the relay_rpc envelope (the daemon trusts the relay-resolved role). A missing
  // user (deleted account) → no fire, the card already posted.
  const creator = await deps.pg.getUserById(creatorId);
  if (!creator) {
    return { fired: false, reason: "creator_unauthorized" };
  }
  const role = (await deps.pg.getMemberRole(opts.workspaceId, creatorId)) ?? "member";
  const creatorToken = deps.mintUserToken(creator.email, creator.name);

  return fireWebhookCybo(
    {
      getCybos: (ws) => deps.pg.getCybos(ws),
      isWorkspaceMember: async (ws, userId) => (await deps.pg.getMemberRole(ws, userId)) !== null,
      getUserDaemonScopes: (ws, daemonId, userId) =>
        deps.pg.getUserDaemonScopes(ws, daemonId, userId),
      isLicensePaused: async (ws) => (await deps.pg.getLicenseStatus(ws)).state === "paused",
      getOnlineDaemonIds: () => deps.relay.getConnectedDaemons(),
      getDaemonProviders: (daemonId) => deps.relay.getDaemonProviders(daemonId),
      getWorkspaceSlashConfig: (ws) => deps.pg.getWorkspaceSlashConfig(ws),
      getDaemonsForWorkspace: (ws) => deps.pg.getDaemonsForWorkspace(ws),
      // Forward the mention-shaped invoke to the chosen daemon as a relay_rpc
      // attributed to the creator — identical envelope to the mention path
      // (bootstrap.ts maps guestId → authCtx.user.id and trusts `role`).
      forwardInvoke: (daemonId, invoke) =>
        deps.relay.sendToDaemonInWorkspace(
          opts.workspaceId,
          {
            type: "cyborg:relay_rpc",
            token: creatorToken,
            workspaceId: opts.workspaceId,
            guestId: creatorId,
            role,
            inner: { type: "cyborg:invoke_cybo_mention", ...invoke },
          },
          daemonId,
        ),
      log: (m) => console.log(m),
    },
    {
      workspaceId: opts.workspaceId,
      channelId: opts.channelId,
      channelName: opts.channelName,
      messageId: opts.messageId,
      triggerCyboId,
      promptTemplate: opts.webhook.promptTemplate,
      creatorId,
      eventLabel: opts.eventLabel,
      payload: opts.payload,
    },
  );
}

// Inbound webhooks. Extracted from relay-standalone.ts (compositor) as a mounted
// Hono sub-app — see `app.route("/", createWebhookRoutes(...))`.
//
// POST /api/webhooks/:channelId — PUBLIC (no requireAuth). An external service
// (CI, GitHub, a script) posts a JSON payload and it lands as a channel message.
// Authenticated by EITHER of:
//   1. A valid GitHub `X-Hub-Signature-256` HMAC over the raw body, keyed by the
//      channel's active webhook secret. This is all the in-app Integrations panel
//      hands a user (endpoint + signing secret), and is exactly how GitHub
//      webhooks authenticate — NO MCP token is required. Identity = the webhook
//      (its workspace + createdBy).
//   2. A `write`-scoped MCP token (`Authorization: Bearer cybo_mcp_…` OR `?token=`
//      — many senders can only put secrets in the URL), for secret-less webhooks
//      or programmatic posters. Identity = the token (its workspace + identity).
// In BOTH paths the channel must belong to the authenticated workspace (cross-
// tenant guard), so a signature for one channel can't post to another's. A
// configured secret with a present-but-invalid signature is rejected as
// `invalid signature`; an unsigned, tokenless request gets the token error.
export function createWebhookRoutes(deps: WebhookRoutesDeps): Hono<RelayEnv> {
  const { pg, relay } = deps;
  const app = new Hono<RelayEnv>();

  app.post("/api/webhooks/:channelId", async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);

    const channelId = c.req.param("channelId");

    // Read the RAW body first — the HMAC must be computed over the exact bytes
    // GitHub signed, so we can't re-serialize a parsed object. Parse it ONCE
    // here and reuse the result everywhere (delivery log + message build).
    const rawBody = await c.req.text().catch(() => "");
    const payload = normalizePayload(parseBody(rawBody));
    const githubEvent = (c.req.header("x-github-event") ?? "").trim() || null;
    // The active webhook config row for this channel (with secret), if any. When
    // present it drives signature verification + event filtering + the delivery
    // log. Absent = legacy token-only behavior (no secret, accept all events).
    const webhook = await pg.getActiveWebhookForChannel(channelId);

    // Record a delivery (best-effort) when a webhook config exists. Keyed to the
    // webhook's own workspace so even a pre-auth rejection is logged correctly.
    const logDelivery = (status: number, ok: boolean, responseBody: string): void => {
      if (!webhook) return;
      void pg
        .insertWebhookDelivery({
          id: randomUUID(),
          webhookId: webhook.id,
          channelId,
          workspaceId: webhook.workspaceId,
          event: githubEvent,
          action: extractAction(payload),
          requestHeaders: captureHeaders(c),
          requestBody: rawBody.slice(0, 64_000),
          responseStatus: status,
          responseBody: responseBody.slice(0, 4_000),
          ok,
        })
        .catch((err) => console.error("[webhooks] delivery log failed:", err));
      // The meaningful insert above already logs its own failure.
      // intentional: last-delivery timestamp is cosmetic.
      void pg.touchWebhookDelivery(webhook.id).catch(() => {});
    };

    // Authenticate on signature OR token (see authenticateWebhook). A valid HMAC
    // needs no MCP token; a secret-less webhook still requires one.
    const auth = await authenticateWebhook(pg, c, webhook, rawBody);
    if (!auth.ok) {
      logDelivery(auth.status, false, auth.error);
      return c.json({ error: auth.error }, auth.status);
    }
    const { workspaceId, fromId, tokenId } = auth;

    // Cross-tenant guard (BOTH paths): the channel must belong to the workspace
    // the credential authenticated, so a signature for one channel's webhook can't
    // post into another workspace's channel.
    const channel = await pg.getChannel(channelId);
    if (!channel || channel.workspace_id !== workspaceId) {
      logDelivery(404, false, "channel not found");
      return c.json({ error: "channel not found" }, 404);
    }

    // Event selection (only when a config row exists).
    if (webhook && !eventAllowed(webhook.eventMode, webhook.events, githubEvent)) {
      logDelivery(202, true, "event ignored by config");
      return c.json({ ok: true, ignored: true });
    }

    // Record usage for the "Last used" column — only when a token was actually
    // used (the signature path has no token to touch).
    if (tokenId) {
      void pg.touchMcpToken(tokenId).catch((err) => {
        console.error("[webhooks] failed to touch token:", err);
      });
    }

    // The event label for the fire prompt (and the default-template fallback):
    // the GitHub event name, else "message" for a generic {text} post.
    const eventLabel = githubEvent ?? "message";
    // Fire the trigger cybo (#620) when configured. Runs for BOTH the renderable
    // and the "ignored" (no card) cases — the cybo trigger is the point of the
    // webhook, independent of whether THIS event also renders a card. Skipped
    // entirely (returns null) when the webhook has no trigger_cybo_id, so a
    // card-only webhook is byte-for-byte the old behavior. Best-effort: never
    // blocks the ack; the outcome is folded into the delivery log.
    const fireTrigger = async (messageId: string): Promise<WebhookCyboFireResult | null> => {
      if (!webhook || !webhook.triggerCyboId || !deps.mintUserToken) return null;
      try {
        return await maybeFireTriggerCybo(
          { pg, relay, mintUserToken: deps.mintUserToken },
          {
            webhook,
            workspaceId,
            channelId,
            channelName: channel.name,
            messageId,
            eventLabel,
            payload,
          },
        );
      } catch (err) {
        console.error("[webhooks] trigger cybo fire failed:", err);
        return { fired: false, reason: "no_daemon" };
      }
    };
    // Fold a fire outcome into the delivery log body (visible, never dropped).
    const withFire = (base: Record<string, unknown>, fire: WebhookCyboFireResult | null): string =>
      JSON.stringify(fire ? { ...base, fire } : base);

    const built = buildMessage(githubEvent, payload);
    if ("error" in built) {
      logDelivery(built.status, false, built.error);
      return c.json({ error: built.error }, built.status);
    }
    if ("ignored" in built) {
      // Unsupported GitHub event/action — no card. Still fire the trigger cybo if
      // one is configured (the event matters even if we don't render it), then
      // acknowledge with a 2xx so GitHub keeps the delivery green.
      const fire = await fireTrigger(randomUUID());
      logDelivery(202, true, withFire({ ok: true, ignored: true }, fire));
      return c.json({ ok: true, ignored: true });
    }

    const messageId = injectWebhookMessage(relay, {
      workspaceId,
      channelId,
      fromId,
      built,
    });

    // Fire the cybo IN ADDITION to the card just injected, keyed to the card's
    // message id (the daemon's mentionInvocationGuard de-dups a replayed forward).
    const fire = await fireTrigger(messageId);
    logDelivery(200, true, withFire({ ok: true, messageId }, fire));
    return c.json({ ok: true, messageId });
  });

  return app;
}

// Best-effort parse of the raw body to a value (Slack-compatible: a non-JSON
// body becomes { text }). Kept out of the handler for complexity budget.
function parseBody(rawBody: string): unknown {
  if (!rawBody) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    return { text: rawBody };
  }
}

// Pull the GitHub `action` out of the already-parsed body for the delivery log.
// Takes the parsed payload (parsed once in the handler) so we never re-parse the
// raw string or assert types on untrusted JSON.
function extractAction(payload: Record<string, unknown>): string | null {
  const action = payload.action;
  return typeof action === "string" ? action : null;
}
