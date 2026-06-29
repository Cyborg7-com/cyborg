import { Hono } from "hono";
import type { Logger } from "pino";
import { logError } from "@cyborg7/observability/node";
import type { PgSync } from "../db/pg-sync.js";
import { validateUserToken } from "../relay-auth.js";
import type { RateLimiter } from "../rate-limiter.js";
import type { RelayEnv } from "./types.js";

// Field caps mirror the web beacon (packages/observability/src/web/client-error.ts)
// and v1's /api/client-error: message <= 4000, stack <= 12000.
const MAX_MESSAGE = 4000;
const MAX_STACK = 12000;

// Hard cap on the request body. The endpoint is public/best-effort-auth, so an
// unauthenticated client could otherwise stream a multi-MB body and OOM the relay
// while c.req.json() buffers it. The legit payload is tiny (message <= 4000 +
// stack <= 12000 + a few small fields), so 100 KB is comfortably generous; we
// gate on Content-Length BEFORE parsing to reject oversized bodies up front.
const MAX_BODY_BYTES = 100 * 1024;

// Per-action rate-limit budget for the (unauthenticated-by-default) client-log
// ingest. Keyed by token (when present) or the forwarded client IP. Generous
// enough for a burst of window.onerror / unhandledrejection beacons after a bad
// deploy, tight enough that a single client can't flood Logfire. "client_log" is
// not one of RateLimiter's DEFAULT_LIMITS, so we pass it as an override.
const CLIENT_LOG_LIMIT = { maxRequests: 30, windowMs: 60_000 };

export interface ClientLogRoutesDeps {
  pg: PgSync | null;
  // The relay's structured logger — every client error is mirrored here for ops
  // visibility, exactly like v1's console.error.
  relayLog: Logger;
  // Shared per-instance limiter (constructed in relay-standalone.ts).
  rateLimiter: RateLimiter;
}

// The web payload (ClientErrorPayload). Loose by design: frontends may attach
// arbitrary extra context (pathname, href, userAgent, componentStack, …) which
// we forward to Logfire as-is.
interface ClientLogPayload {
  source?: string;
  message?: string;
  stack?: string | null;
  platform?: string;
  version?: string;
  workspaceId?: string | null;
  [key: string]: unknown;
}

// Derive a stable rate-limit key: prefer the verified user (so an authed client
// gets its own budget), else the forwarded client IP, else a shared bucket.
function rateLimitKey(authedUserId: string | null, forwardedFor: string | undefined): string {
  if (authedUserId) return `user:${authedUserId}`;
  const ip = forwardedFor?.split(",")[0]?.trim();
  return ip ? `ip:${ip}` : "anon";
}

// Best-effort auth: the beacon is sent WITHOUT credentials (CORS-safe, survives
// unload), so most calls are anonymous. When a Bearer token IS present and
// resolves to a verified member of the claimed workspace, we attach the trusted
// workspace to the Logfire context — mirroring v1's policy (log regardless; only
// trust a workspace when the caller is a verified member of it).
async function resolveTrustedContext(
  pg: PgSync | null,
  authHeader: string | undefined,
  claimedWorkspaceId: string | null | undefined,
): Promise<{ userId: string | null; trustedWorkspaceId: string | null }> {
  if (!authHeader?.startsWith("Bearer ") || !pg) {
    return { userId: null, trustedWorkspaceId: null };
  }
  const decoded = validateUserToken(authHeader.slice(7));
  if (!decoded) return { userId: null, trustedWorkspaceId: null };
  const user = await pg.getUserByEmail(decoded.email);
  if (!user) return { userId: null, trustedWorkspaceId: null };
  let trustedWorkspaceId: string | null = null;
  if (claimedWorkspaceId && (await pg.isMember(claimedWorkspaceId, user.id))) {
    trustedWorkspaceId = claimedWorkspaceId;
  }
  return { userId: user.id, trustedWorkspaceId };
}

/**
 * POST /api/cyborg/client-log — frontend telemetry proxy.
 *
 * Frontends never ship the Logfire write token; they beacon client-side errors
 * here (see @cyborg7/observability/web → reportClientError) and the relay emits
 * the Logfire exception server-side. Accepts the web payload, clamps message /
 * stack sizes, rate-limits per token-or-IP, emits `logError("ui.client", …)`, and
 * mirrors to the relay logger. Auth is best-effort: it logs regardless and only
 * attaches a trusted workspace when the caller is a verified member.
 */
export function createClientLogRoutes(deps: ClientLogRoutesDeps): Hono<RelayEnv> {
  const { pg, relayLog, rateLimiter } = deps;
  const app = new Hono<RelayEnv>();

  app.post("/api/cyborg/client-log", async (c) => {
    // Reject oversized bodies BEFORE buffering/parsing. The Content-Length gate is
    // the cheap first line of defense against a multi-MB body OOMing the relay; we
    // never call c.req.json() on a body we've already decided to drop.
    const contentLength = Number(c.req.header("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return c.json({ error: "payload too large" }, 413);
    }

    let payload: ClientLogPayload;
    try {
      payload = (await c.req.json()) as ClientLogPayload;
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    // Must be a plain object: arrays are `typeof "object"` too, so exclude them
    // explicitly (an array payload has no message/stack/workspaceId fields).
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return c.json({ error: "invalid payload" }, 400);
    }

    const authHeader = c.req.header("authorization");
    const claimedWorkspaceId = payload.workspaceId ?? null;
    const { userId, trustedWorkspaceId } = await resolveTrustedContext(
      pg,
      authHeader,
      claimedWorkspaceId,
    );

    // Rate-limit AFTER resolving the user so authed callers get their own budget.
    const key = rateLimitKey(userId, c.req.header("x-forwarded-for"));
    const { allowed, retryAfterMs } = rateLimiter.check(key, "client_log", {
      client_log: CLIENT_LOG_LIMIT,
    });
    if (!allowed) {
      if (retryAfterMs) c.header("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
      return c.json({ error: "rate limited" }, 429);
    }

    const { source: rawSource, message: rawMessage, stack: rawStack, ...rest } = payload;
    const source = (typeof rawSource === "string" && rawSource) || "client";
    const message = String(rawMessage ?? "Unknown client error").slice(0, MAX_MESSAGE);
    const stack = rawStack ? String(rawStack).slice(0, MAX_STACK) : null;
    const platform = typeof payload.platform === "string" ? payload.platform : undefined;
    const version = typeof payload.version === "string" ? payload.version : undefined;

    // Reconstruct an Error so Logfire records a proper exception with the client
    // stack (logError serializes it through the Logfire reportError API).
    const error = new Error(message);
    error.name = source;
    // ALWAYS overwrite the stack. `new Error(message)` captures THIS relay frame —
    // leaving it would misattribute the client's error to the relay in Logfire. Use
    // the client stack verbatim when present, else a placeholder (never the relay's).
    error.stack = stack ?? "No client stack trace";

    // Everything else the frontend attached (pathname, href, userAgent,
    // componentStack, …) plus the shaped fields becomes the Logfire context.
    const ctx: Record<string, unknown> = {
      ...rest,
      source,
      platform,
      version,
      // Only the VERIFIED workspace — never the unverified client claim.
      workspaceId: trustedWorkspaceId,
    };

    logError("ui.client", error, ctx);
    // Mirror for ops visibility (same intent as v1's console.error). The relay
    // logger's pino→Logfire bridge would otherwise also fire, but logError above
    // is the canonical exception; this line keeps the relay's own log stream
    // complete. Pass the message as a string (not `err`) so the bridge doesn't
    // double-report the same exception.
    relayLog.error({ source, platform, version, workspaceId: trustedWorkspaceId }, message);

    return c.json({ ok: true });
  });

  return app;
}
