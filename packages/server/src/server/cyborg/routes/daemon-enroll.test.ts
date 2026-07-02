import { describe, it, expect, afterEach } from "vitest";
import { Hono, type Context, type Next } from "hono";
import { createDaemonEnrollRoutes } from "./daemon-enroll.js";
import { validateDaemonToken } from "../relay-auth.js";
import type { RelayEnv } from "./types.js";

// Build the enroll app with an injectable requireAuth: authed (sets userId) or not.
function makeApp(authedAs: string | null): Hono<RelayEnv> {
  const requireAuth = async (c: Context<RelayEnv>, next: Next) => {
    if (authedAs === null) return c.json({ error: "unauthorized" }, 401);
    c.set("userId", authedAs);
    await next();
  };
  const app = new Hono<RelayEnv>();
  app.route("/", createDaemonEnrollRoutes({ requireAuth }));
  return app;
}

describe("POST /api/cyborg/daemon/enroll (CYBORG-58)", () => {
  const orig = process.env.CYBORG7_DAEMON_TOKEN_SECRET;
  afterEach(() => {
    if (orig === undefined) delete process.env.CYBORG7_DAEMON_TOKEN_SECRET;
    else process.env.CYBORG7_DAEMON_TOKEN_SECRET = orig;
  });

  it("rejects an unauthenticated request", async () => {
    const res = await makeApp(null).request("/api/cyborg/daemon/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ daemonId: "srv_a" }),
    });
    expect(res.status).toBe(401);
  });

  it("400s on a null JSON body (valid JSON, must not TypeError)", async () => {
    const res = await makeApp("u_1").request("/api/cyborg/daemon/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    expect(res.status).toBe(400);
  });

  it("400s when daemonId is missing", async () => {
    const res = await makeApp("u_1").request("/api/cyborg/daemon/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("mints a daemon token bound to the AUTHENTICATED user (ignores any client owner)", async () => {
    process.env.CYBORG7_DAEMON_TOKEN_SECRET = "pinned-daemon-secret-hhhhhhhhhhhhhhhhhh";
    const res = await makeApp("u_real").request("/api/cyborg/daemon/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // A malicious client tries to set owner to someone else — must be ignored.
      body: JSON.stringify({ daemonId: "srv_z", owner: "u_victim" }),
    });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    // The returned token validates and its owner is the authenticated caller.
    expect(validateDaemonToken(token)).toEqual({ daemonId: "srv_z", ownerId: "u_real" });
  });
});
