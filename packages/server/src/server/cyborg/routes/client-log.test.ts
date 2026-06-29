import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { createUserToken } from "../relay-auth.js";
import { RateLimiter } from "../rate-limiter.js";
import type { PgSync } from "../db/pg-sync.js";
import type { RelayEnv } from "./types.js";

// The route is a relay telemetry proxy: frontends beacon client errors here and
// the relay emits the Logfire exception SERVER-side (frontends never hold the
// write token). We mock the observability node entry so we can assert the
// canonical sink — logError — is invoked with the right scope + context, without
// standing up a real Logfire/OTel exporter. This is a behavior spy, not a
// re-implementation of the route.
const logError = vi.fn();
vi.mock("@cyborg7/observability/node", () => ({
  logError: (...args: unknown[]) => logError(...args),
}));

// Imported AFTER the mock is registered so the route binds to the spy.
const { createClientLogRoutes } = await import("./client-log.js");

const CLIENT_LOG_PATH = "/api/cyborg/client-log";
// Mirror the route's caps (packages/.../client-log.ts).
const MAX_MESSAGE = 4000;
const MAX_STACK = 12000;

// A minimal pino-shaped logger: the route mirrors every client error to it for
// ops visibility. We only need .error here; the others keep the type happy.
function makeRelayLog(): Logger {
  const noop = (() => undefined) as unknown as Logger["info"];
  return {
    error: vi.fn(),
    info: noop,
    warn: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    child: () => makeRelayLog(),
  } as unknown as Logger;
}

// A fake PgSync exposing only what resolveTrustedContext touches: getUserByEmail
// + isMember. The route is best-effort auth, so an unconfigured pg (null) or an
// unknown user simply yields no trusted workspace.
interface FakePgOptions {
  user?: { id: string; email: string } | null;
  memberOf?: Set<string>;
}
function makeFakePg(opts: FakePgOptions = {}): PgSync {
  const { user = null, memberOf = new Set<string>() } = opts;
  return {
    getUserByEmail: vi.fn(async (email: string) =>
      user && user.email === email
        ? { id: user.id, email: user.email, name: null, imageUrl: null, passwordHash: null }
        : null,
    ),
    isMember: vi.fn(async (workspaceId: string, userId: string) =>
      Boolean(user && userId === user.id && memberOf.has(workspaceId)),
    ),
  } as unknown as PgSync;
}

interface HarnessOptions {
  pg?: PgSync | null;
  rateLimiter?: RateLimiter;
  relayLog?: Logger;
}
function makeApp(opts: HarnessOptions = {}): {
  app: Hono<RelayEnv>;
  relayLog: Logger;
  rateLimiter: RateLimiter;
} {
  const relayLog = opts.relayLog ?? makeRelayLog();
  const rateLimiter = opts.rateLimiter ?? new RateLimiter();
  const pg = opts.pg === undefined ? makeFakePg() : opts.pg;
  const app = createClientLogRoutes({ pg, relayLog, rateLimiter });
  return { app, relayLog, rateLimiter };
}

function post(app: Hono<RelayEnv>, body: unknown, headers: Record<string, string> = {}) {
  return app.request(CLIENT_LOG_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  logError.mockClear();
});

describe("POST /api/cyborg/client-log — forwards client telemetry to logError", () => {
  it("emits ONE logError('ui.client', …) carrying source/platform/version + the client error", async () => {
    const { app, relayLog } = makeApp();
    const res = await post(app, {
      source: "window.onerror",
      message: "Cannot read properties of undefined",
      stack: "Error: boom\n  at foo (app.js:1:1)",
      platform: "web",
      version: "2.3.4",
      pathname: "/channels/general",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(logError).toHaveBeenCalledTimes(1);
    const [scope, err, ctx] = logError.mock.calls[0] as [string, Error, Record<string, unknown>];
    expect(scope).toBe("ui.client");
    // The reconstructed Error carries the client message + stack, named by source.
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Cannot read properties of undefined");
    expect(err.name).toBe("window.onerror");
    expect(err.stack).toBe("Error: boom\n  at foo (app.js:1:1)");
    // Shaped attributes are forwarded.
    expect(ctx.source).toBe("window.onerror");
    expect(ctx.platform).toBe("web");
    expect(ctx.version).toBe("2.3.4");
    // Arbitrary extra context is passed through verbatim.
    expect(ctx.pathname).toBe("/channels/general");

    // And it is mirrored to the relay logger for ops visibility.
    expect(relayLog.error).toHaveBeenCalledTimes(1);
  });

  it("defaults source to 'client' and message to a placeholder when absent", async () => {
    const { app } = makeApp();
    const res = await post(app, { platform: "web" });
    expect(res.status).toBe(200);

    expect(logError).toHaveBeenCalledTimes(1);
    const [, err, ctx] = logError.mock.calls[0] as [string, Error, Record<string, unknown>];
    expect(err.message).toBe("Unknown client error");
    expect(err.name).toBe("client");
    expect(ctx.source).toBe("client");
  });
});

describe("POST /api/cyborg/client-log — size clamping", () => {
  it("truncates an oversized message to 4000 chars before forwarding", async () => {
    const { app } = makeApp();
    const huge = "x".repeat(MAX_MESSAGE + 5000);
    const res = await post(app, { message: huge });
    expect(res.status).toBe(200);

    const [, err] = logError.mock.calls[0] as [string, Error, Record<string, unknown>];
    expect(err.message.length).toBe(MAX_MESSAGE);
  });

  it("truncates an oversized stack to 12000 chars before forwarding", async () => {
    const { app } = makeApp();
    const hugeStack = "s".repeat(MAX_STACK + 8000);
    const res = await post(app, { message: "boom", stack: hugeStack });
    expect(res.status).toBe(200);

    const [, err] = logError.mock.calls[0] as [string, Error, Record<string, unknown>];
    expect(err.stack).not.toBeNull();
    expect((err.stack ?? "").length).toBe(MAX_STACK);
  });

  it("substitutes a placeholder stack when the client sends none (no relay stack)", async () => {
    const { app } = makeApp();
    const res = await post(app, { message: "boom", stack: null });
    expect(res.status).toBe(200);
    const [, err] = logError.mock.calls[0] as [string, Error, Record<string, unknown>];
    // `new Error(message)` captures the relay's OWN stack; the route overwrites it
    // with a placeholder so the client error is never misattributed to the relay.
    expect(err.stack).toBe("No client stack trace");
    // And it never leaks a relay frame (this test file's path) into the exception.
    expect(err.stack).not.toContain("client-log.test");
  });

  it("uses a provided client stack verbatim (never the placeholder)", async () => {
    const { app } = makeApp();
    const clientStack = "Error: boom\n  at handler (https://app.example/x.js:9:1)";
    const res = await post(app, { message: "boom", stack: clientStack });
    expect(res.status).toBe(200);
    const [, err] = logError.mock.calls[0] as [string, Error, Record<string, unknown>];
    expect(err.stack).toBe(clientStack);
  });
});

describe("POST /api/cyborg/client-log — body-size guard (DoS protection)", () => {
  it("rejects with 413 when Content-Length exceeds the 100 KB cap (before parsing)", async () => {
    const { app } = makeApp();
    // A declared Content-Length over the cap is rejected up front; the actual body
    // is irrelevant because we never parse it.
    const res = await app.request(CLIENT_LOG_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(100 * 1024 + 1),
      },
      body: JSON.stringify({ message: "boom" }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload too large" });
    // Nothing was forwarded to Logfire.
    expect(logError).not.toHaveBeenCalled();
  });

  it("accepts a normal-sized body (Content-Length under the cap)", async () => {
    const { app } = makeApp();
    const res = await post(app, { message: "boom" });
    expect(res.status).toBe(200);
    expect(logError).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/cyborg/client-log — rate limiting", () => {
  it("returns 429 once the per-key budget (30/min) is exceeded", async () => {
    // Share one limiter and one client IP across the burst so they hit the same bucket.
    const rateLimiter = new RateLimiter();
    const { app } = makeApp({ rateLimiter, pg: null });
    const headers = { "x-forwarded-for": "203.0.113.7" };

    // 30 allowed.
    for (let i = 0; i < 30; i++) {
      const ok = await post(app, { message: `e${i}` }, headers);
      expect(ok.status).toBe(200);
    }
    // 31st is rejected.
    const limited = await post(app, { message: "overflow" }, headers);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate limited" });
    expect(limited.headers.get("retry-after")).toBeTruthy();

    // The over-limit request did NOT forward to Logfire.
    expect(logError).toHaveBeenCalledTimes(30);
  });

  it("keys the budget by client IP so distinct IPs do not share a bucket", async () => {
    const rateLimiter = new RateLimiter();
    const { app } = makeApp({ rateLimiter, pg: null });

    for (let i = 0; i < 30; i++) {
      await post(app, { message: "x" }, { "x-forwarded-for": "198.51.100.1" });
    }
    // A different IP still has its full budget.
    const other = await post(app, { message: "y" }, { "x-forwarded-for": "198.51.100.2" });
    expect(other.status).toBe(200);
  });
});

describe("POST /api/cyborg/client-log — best-effort auth", () => {
  it("anonymous (no token) call still logs (200) but attaches NO trusted workspace", async () => {
    const { app } = makeApp({ pg: makeFakePg() });
    const res = await post(app, {
      message: "boom",
      workspaceId: "ws-claimed-but-unverified",
    });
    expect(res.status).toBe(200);
    expect(logError).toHaveBeenCalledTimes(1);
    const [, , ctx] = logError.mock.calls[0] as [string, Error, Record<string, unknown>];
    // The unverified client claim is dropped — never trusted.
    expect(ctx.workspaceId).toBeNull();
  });

  it("a token with no pg (relay not DB-connected) logs but trusts nothing", async () => {
    const { app } = makeApp({ pg: null });
    const token = createUserToken("nobody@example.com");
    const res = await post(
      app,
      { message: "boom", workspaceId: "ws-1" },
      { authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(200);
    const [, , ctx] = logError.mock.calls[0] as [string, Error, Record<string, unknown>];
    expect(ctx.workspaceId).toBeNull();
  });

  it("a verified MEMBER token attaches the claimed workspace as trusted", async () => {
    const user = { id: "user-42", email: "member@example.com" };
    const pg = makeFakePg({ user, memberOf: new Set(["ws-trusted"]) });
    const { app } = makeApp({ pg });
    const token = createUserToken(user.email);

    const res = await post(
      app,
      { message: "boom", workspaceId: "ws-trusted" },
      { authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(200);
    const [, , ctx] = logError.mock.calls[0] as [string, Error, Record<string, unknown>];
    expect(ctx.workspaceId).toBe("ws-trusted");
  });

  it("a valid token whose user is NOT a member of the claimed workspace trusts nothing", async () => {
    const user = { id: "user-99", email: "outsider@example.com" };
    // Member of some other workspace, but NOT the one claimed.
    const pg = makeFakePg({ user, memberOf: new Set(["ws-other"]) });
    const { app } = makeApp({ pg });
    const token = createUserToken(user.email);

    const res = await post(
      app,
      { message: "boom", workspaceId: "ws-not-mine" },
      { authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(200);
    const [, , ctx] = logError.mock.calls[0] as [string, Error, Record<string, unknown>];
    expect(ctx.workspaceId).toBeNull();
  });

  it("a garbage Bearer token is ignored (logs anonymously, no crash)", async () => {
    const user = { id: "user-1", email: "x@example.com" };
    const pg = makeFakePg({ user, memberOf: new Set(["ws-1"]) });
    const { app } = makeApp({ pg });
    const res = await post(
      app,
      { message: "boom", workspaceId: "ws-1" },
      { authorization: "Bearer not-a-real-jwt" },
    );
    expect(res.status).toBe(200);
    const [, , ctx] = logError.mock.calls[0] as [string, Error, Record<string, unknown>];
    expect(ctx.workspaceId).toBeNull();
  });
});

describe("POST /api/cyborg/client-log — malformed input is handled gracefully (no 500)", () => {
  it("invalid JSON body → 400, not 500, and nothing is forwarded", async () => {
    const { app } = makeApp();
    const res = await post(app, "{not valid json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON" });
    expect(logError).not.toHaveBeenCalled();
  });

  it("a non-object scalar JSON body → 400 (and never 500)", async () => {
    const { app } = makeApp();
    const scalar = await post(app, "42");
    expect(scalar.status).toBe(400);
    expect(scalar.status).not.toBe(500);
    expect(logError).not.toHaveBeenCalled();
  });

  it("an array JSON body → 400 (typeof [] === 'object' must not slip through)", async () => {
    const { app } = makeApp();
    const arr = await post(app, [{ message: "boom" }]);
    expect(arr.status).toBe(400);
    expect(await arr.json()).toEqual({ error: "invalid payload" });
    expect(logError).not.toHaveBeenCalled();
  });

  it("an empty object body → 200 with placeholder message (no 500)", async () => {
    const { app } = makeApp();
    const res = await post(app, {});
    expect(res.status).toBe(200);
    expect(logError).toHaveBeenCalledTimes(1);
    const [, err] = logError.mock.calls[0] as [string, Error, Record<string, unknown>];
    expect(err.message).toBe("Unknown client error");
  });
});
