import { Hono } from "hono";
import type { Context } from "hono";
import type { PgSync } from "../db/pg-sync.js";
import type { RelayEnv, RequireAuth } from "./types.js";

export interface WorkspaceRestRoutesDeps {
  pg: PgSync;
  requireAuth: RequireAuth;
}

// Read-only, authenticated workspace REST endpoints — the SvelteKit app's
// non-WS fetches (initial workspace/channel/message/member/daemon/cybo loads).
// Extracted from relay-standalone.ts as a self-contained Hono sub-app
// (issue #53, continues #177/#217). Behaviour-preserving: identical paths +
// membership gate. The factory takes a non-null `pg` (the caller asserts it
// once at the mount site), so the 6 handlers need no per-call `pg!`.
export function createWorkspaceRestRoutes(deps: WorkspaceRestRoutesDeps): Hono<RelayEnv> {
  const { pg, requireAuth } = deps;
  const app = new Hono<RelayEnv>();

  // Gate a workspace-scoped read: the caller must be a member AND the workspace
  // must not be DISABLED by a superadmin. Returns a 403 Response to send on
  // denial, or null when access is allowed. Membership is checked FIRST so a
  // non-member can't probe whether a workspace exists/is disabled (no info leak);
  // a real member of a disabled workspace is then rejected — this is the REST
  // mirror of the WS `subscribe_workspace` disable gate, so a disabled org's data
  // can't be read over HTTP either. Shared by every `:id/*` handler below.
  async function denyWorkspaceRead(c: Context<RelayEnv>, wid: string): Promise<Response | null> {
    if (!(await pg.isMember(wid, c.get("userId")))) return c.json({ error: "not a member" }, 403);
    if (await pg.isWorkspaceDisabled(wid)) {
      return c.json({ error: "This workspace has been disabled by an administrator." }, 403);
    }
    return null;
  }

  app.get("/api/workspaces", requireAuth, async (c) => {
    // getWorkspacesForUser already excludes disabled workspaces, so a disabled
    // org never appears in the list.
    const workspaces = await pg.getWorkspacesForUser(c.get("userId"));
    return c.json({
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        role: w.role,
      })),
    });
  });

  app.get("/api/workspaces/:id/channels", requireAuth, async (c) => {
    const wid = c.req.param("id");
    const denied = await denyWorkspaceRead(c, wid);
    if (denied) return denied;
    return c.json({ channels: await pg.getChannels(wid) });
  });

  app.get("/api/workspaces/:id/messages", requireAuth, async (c) => {
    const wid = c.req.param("id");
    const denied = await denyWorkspaceRead(c, wid);
    if (denied) return denied;
    const channelId = c.req.query("channelId");
    if (!channelId) return c.json({ error: "channelId required" }, 400);
    const before = c.req.query("before") ?? undefined;
    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    return c.json({
      messages: await pg.getMessages({ channelId, before, limit }),
    });
  });

  app.get("/api/workspaces/:id/members", requireAuth, async (c) => {
    const wid = c.req.param("id");
    const denied = await denyWorkspaceRead(c, wid);
    if (denied) return denied;
    return c.json({ members: await pg.getMembers(wid) });
  });

  app.get("/api/workspaces/:id/daemons", requireAuth, async (c) => {
    const wid = c.req.param("id");
    const denied = await denyWorkspaceRead(c, wid);
    if (denied) return denied;
    return c.json({ daemons: await pg.getDaemonsForWorkspace(wid) });
  });

  app.get("/api/workspaces/:id/cybos", requireAuth, async (c) => {
    const wid = c.req.param("id");
    const denied = await denyWorkspaceRead(c, wid);
    if (denied) return denied;
    return c.json({ cybos: await pg.getCybos(wid) });
  });

  return app;
}
