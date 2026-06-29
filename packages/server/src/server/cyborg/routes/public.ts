import { Hono } from "hono";
import type { PgSync } from "../db/pg-sync.js";
import type { RelayEnv } from "./types.js";

export interface PublicRoutesDeps {
  pg: PgSync | null;
  // Relay status, injected so this module doesn't close over relay internals.
  startedAt: number;
  getConnectedDaemons: () => string[];
  getRedisOnlineDaemons: () => Promise<string[]>;
  guestCount: () => number;
  hasRedis: boolean;
}

// Public, unauthenticated endpoints: the relay health probe and the invite
// landing lookup (hit BEFORE sign-in). Extracted from relay-standalone.ts as a
// Hono sub-app (issue #53, continues #177/#217). Behaviour-preserving.
export function createPublicRoutes(deps: PublicRoutesDeps): Hono<RelayEnv> {
  const { pg, startedAt, getConnectedDaemons, getRedisOnlineDaemons, guestCount, hasRedis } = deps;
  const app = new Hono<RelayEnv>();

  app.get("/api/health", async (c) => {
    const onlineFromRedis = await getRedisOnlineDaemons();
    return c.json({
      status: "ok",
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      daemons: getConnectedDaemons(),
      daemonsRedis: onlineFromRedis,
      guests: guestCount(),
      pg: !!pg,
      redis: hasRedis,
    });
  });

  // GET /api/invite/:token — the invite link's landing page hits this BEFORE the
  // user is signed in, so it must be reachable without the WS/JWT. Returns the
  // invite's status + workspace name (no membership data) so the UI can render
  // "You've been invited to {workspace}" and route to sign-in/up + accept.
  app.get("/api/invite/:token", async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const token = c.req.param("token");
    const invite = await pg.getInvitation(token);
    if (!invite) {
      return c.json({
        workspace: null,
        invitedEmail: null,
        status: "invalid" as const,
        expiresAt: null,
      });
    }
    const ws = await pg.getWorkspaceById(invite.workspaceId);
    let status: "pending" | "accepted" | "expired";
    if (invite.acceptedAt) status = "accepted";
    else if (invite.expiresAt.getTime() < Date.now()) status = "expired";
    else status = "pending";
    return c.json({
      workspace: ws ? { id: ws.id, name: ws.name } : null,
      invitedEmail: invite.email,
      status,
      expiresAt: invite.expiresAt.getTime(),
    });
  });

  return app;
}
