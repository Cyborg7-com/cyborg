import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Hono, type Context, type Next } from "hono";
import {
  signSlackOAuthState,
  verifySlackOAuthState,
  createSlackOAuthRoutes,
  exchangeAndStoreSlackInstall,
} from "./slack-oauth.js";
import type { PgSync } from "../db/pg-sync.js";
import type { RelayEnv } from "./types.js";

// Mock the Slack Web API so the OAuth token exchange never touches the network.
// vi.hoisted runs BEFORE imports, so the shared spy is reachable both inside the
// vi.mock factory AND in the test bodies. WebClient is `new`'d inside
// exchangeAndStoreSlackInstall, so the factory returns a REAL constructor (a
// `function`, not an arrow) exposing only the `oauth.v2.access` surface this route
// calls. Harmless for the state-sign + channel-links suites, which never touch it.
const { mockOauthAccess } = vi.hoisted(() => ({ mockOauthAccess: vi.fn() }));
vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn().mockImplementation(function () {
    return { oauth: { v2: { access: mockOauthAccess } } };
  }),
}));

// Module-scope no-op so console spies pass a reference (not an inline callback) —
// keeps the deeply-nested describe → it → spy chain under oxlint max-nested-callbacks.
function noop(): void {}

// The signed OAuth `state` is the load-bearing security primitive of this route: the
// PUBLIC callback trusts ONLY a state our server minted (via /config, after an isMember
// check) before writing a credential-bearing install row. These tests pin the HMAC
// round-trip + the tamper/forge rejections that keep an attacker from attributing a bot
// token to a workspace they aren't a member of.

const PRIOR_SECRET = process.env.SLACK_CLIENT_SECRET;

beforeAll(() => {
  process.env.SLACK_CLIENT_SECRET = "test-slack-client-secret-abc123";
});

afterAll(() => {
  if (PRIOR_SECRET === undefined) delete process.env.SLACK_CLIENT_SECRET;
  else process.env.SLACK_CLIENT_SECRET = PRIOR_SECRET;
});

describe("slack OAuth state sign/verify", () => {
  it("round-trips a valid {workspaceId, userId}", () => {
    const state = signSlackOAuthState({ workspaceId: "ws_1", userId: "user_1" });
    expect(verifySlackOAuthState(state)).toEqual({ workspaceId: "ws_1", userId: "user_1" });
  });

  it("rejects a tampered payload (HMAC no longer matches)", () => {
    const state = signSlackOAuthState({ workspaceId: "ws_1", userId: "user_1" });
    const [, sig] = state.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ workspaceId: "ws_victim", userId: "attacker" }),
    ).toString("base64url");
    expect(verifySlackOAuthState(`${forgedBody}.${sig}`)).toBeNull();
  });

  it("rejects a malformed / unsigned state", () => {
    expect(verifySlackOAuthState("")).toBeNull();
    expect(verifySlackOAuthState("not-a-signed-state")).toBeNull();
    expect(verifySlackOAuthState("ws_1")).toBeNull();
  });

  it("rejects a state signed with a different secret", () => {
    const state = signSlackOAuthState({ workspaceId: "ws_1", userId: "user_1" });
    process.env.SLACK_CLIENT_SECRET = "a-different-secret";
    expect(verifySlackOAuthState(state)).toBeNull();
    process.env.SLACK_CLIENT_SECRET = "test-slack-client-secret-abc123";
  });
});

// POST /api/slack/channel-links cross-tenant guards. slack_channel_links carries a
// GLOBAL unique on slackChannelId and createSlackChannelLink upserts on it WITHOUT
// re-checking workspaceId — so without a guard a member of workspace B could pass a
// slackChannelId already owned by workspace A (with their own B-valid install + channel)
// and silently re-point A's row. These pin the 409 (foreign-channel claim) and the 400
// (team mismatch), driving the REAL Hono app with a typed-fake pg + a stub requireAuth.
const WS = "ws_caller";
const OTHER_WS = "ws_victim";
const INSTALL_ID = "ins_1";
const INSTALL_TEAM = "T_caller";
const CYBORG_CHANNEL = "ch_1";

interface ChannelLinkFake {
  // The link returned by getSlackChannelLinkBySlackChannel (the pre-upsert BOLA probe).
  existingLink?: { workspaceId: string } | null;
  // Records of createSlackChannelLink calls (asserted to be absent on a reject).
  created: Array<Record<string, unknown>>;
}

function makeChannelLinkApp(fake: ChannelLinkFake) {
  const requireAuth = async (c: Context<RelayEnv>, next: Next) => {
    c.set("userId", "u_caller");
    c.set("userEmail", "u_caller@e2e.dev");
    await next();
  };
  const pg = {
    async isMember(workspaceId: string, userId: string) {
      return workspaceId === WS && userId === "u_caller";
    },
    async getIntegrationInstallationById(id: string) {
      return id === INSTALL_ID
        ? { id, workspaceId: WS, provider: "slack", externalId: INSTALL_TEAM }
        : null;
    },
    async getChannel(id: string) {
      return id === CYBORG_CHANNEL ? { id, workspace_id: WS } : null;
    },
    async getSlackChannelLinkBySlackChannel() {
      return fake.existingLink ?? null;
    },
    async createSlackChannelLink(opts: Record<string, unknown>) {
      fake.created.push(opts);
      return "slkl_new";
    },
  } as unknown as PgSync;
  return createSlackOAuthRoutes({ pg, requireAuth });
}

function postChannelLink(
  app: ReturnType<typeof makeChannelLinkApp>,
  body: Record<string, unknown>,
) {
  return app.request("/api/slack/channel-links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  workspaceId: WS,
  installationId: INSTALL_ID,
  cyborgChannelId: CYBORG_CHANNEL,
  slackChannelId: "C_SLACK",
  slackTeamId: INSTALL_TEAM,
};

describe("POST /api/slack/channel-links — cross-tenant guards", () => {
  it("rejects (409) claiming a Slack channel already linked to ANOTHER workspace", async () => {
    const fake: ChannelLinkFake = { existingLink: { workspaceId: OTHER_WS }, created: [] };
    const res = await postChannelLink(makeChannelLinkApp(fake), VALID_BODY);
    expect(res.status).toBe(409);
    expect(fake.created).toHaveLength(0); // never reached the upsert that would steal the row
  });

  it("rejects (400) when slackTeamId does not match the installation's team", async () => {
    const fake: ChannelLinkFake = { existingLink: null, created: [] };
    const res = await postChannelLink(makeChannelLinkApp(fake), {
      ...VALID_BODY,
      slackTeamId: "T_forged",
    });
    expect(res.status).toBe(400);
    expect(fake.created).toHaveLength(0);
  });

  it("allows a SAME-workspace re-link (existing link owned by the caller's workspace)", async () => {
    const fake: ChannelLinkFake = { existingLink: { workspaceId: WS }, created: [] };
    const res = await postChannelLink(makeChannelLinkApp(fake), VALID_BODY);
    expect(res.status).toBe(200);
    expect(fake.created).toHaveLength(1);
  });

  it("allows a first-time link (no existing row) with a matching team", async () => {
    const fake: ChannelLinkFake = { existingLink: null, created: [] };
    const res = await postChannelLink(makeChannelLinkApp(fake), VALID_BODY);
    expect(res.status).toBe(200);
    expect(fake.created).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Route-level coverage: the OAuth token exchange, the PUBLIC callback redirect
// matrix + open-redirect hardening, the token-strip invariant on GET /installations,
// the stable redirect_uri on /config, and the BOLA guards on the two DELETE routes.
// All drive the REAL exported code (exchangeAndStoreSlackInstall / the Hono app from
// createSlackOAuthRoutes) over a typed-fake pg with @slack/web-api mocked — no network,
// fully deterministic.
// ──────────────────────────────────────────────────────────────────────────────

const APP_URL = "https://app.cyborg7.com";
const USER_ID = "u_member";

// Slack is "configured" only when all four secrets are present (slack-app.ts). The
// PUBLIC callback and /config both gate on it, so these route tests set the full set.
// SLACK_CLIENT_SECRET is already set by the top-level beforeAll and stays set for the
// whole file, so the signed `state` minted here verifies inside the callback with the
// same key. CYBORG_APP_URL pins the stable redirect base; SLACK_OAUTH_CALLBACK_BASE is
// cleared so the callback base falls through to CYBORG_APP_URL (byte-identical between
// /config's install URL and the callback's token-exchange redirect_uri).
const ROUTE_ENV_KEYS = [
  "SLACK_CLIENT_ID",
  "SLACK_SIGNING_SECRET",
  "SLACK_APP_ID",
  "CYBORG_APP_URL",
  "SLACK_OAUTH_CALLBACK_BASE",
] as const;

describe("slack-oauth routes — exchange, callback, installations, config, deletes", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ROUTE_ENV_KEYS) saved[k] = process.env[k];
    process.env.SLACK_CLIENT_ID = "test-slack-client-id";
    process.env.SLACK_SIGNING_SECRET = "test-slack-signing-secret";
    process.env.SLACK_APP_ID = "A_TEST";
    process.env.CYBORG_APP_URL = APP_URL;
    delete process.env.SLACK_OAUTH_CALLBACK_BASE;
    mockOauthAccess.mockReset();
  });
  afterEach(() => {
    for (const k of ROUTE_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // ── item 1: exchangeAndStoreSlackInstall — driven directly through a one-route
  //    wrapper app that surfaces the boolean return, with the fake pg recording the
  //    upsert so we can assert exactly what was (or was not) persisted. ──
  describe("exchangeAndStoreSlackInstall — token exchange + persist", () => {
    const STATE = { workspaceId: WS, userId: USER_ID };

    function makeExchangeApp(pg: PgSync, code: string) {
      const app = new Hono<RelayEnv>();
      app.get("/__exchange", async (c) => {
        const result = await exchangeAndStoreSlackInstall(c, pg, STATE, code);
        return c.json({ result });
      });
      return app;
    }

    function makePg(upserts: Array<Record<string, unknown>>): PgSync {
      return {
        async upsertIntegrationInstallation(opts: Record<string, unknown>) {
          upserts.push(opts);
          return String(opts.id);
        },
      } as unknown as PgSync;
    }

    async function runExchange(pg: PgSync, code = "code_abc"): Promise<boolean> {
      const res = await makeExchangeApp(pg, code).request("/__exchange");
      return ((await res.json()) as { result: boolean }).result;
    }

    it("(a) {ok:false, error:'invalid_code'} → false, upsert NOT called", async () => {
      const upserts: Array<Record<string, unknown>> = [];
      mockOauthAccess.mockResolvedValue({ ok: false, error: "invalid_code" });
      expect(await runExchange(makePg(upserts))).toBe(false);
      expect(upserts).toHaveLength(0);
    });

    it("(b) ok:true but missing team.id → false, upsert NOT called", async () => {
      const upserts: Array<Record<string, unknown>> = [];
      mockOauthAccess.mockResolvedValue({ ok: true, access_token: "xoxb-1" });
      expect(await runExchange(makePg(upserts))).toBe(false);
      expect(upserts).toHaveLength(0);
    });

    it("(b') ok:true but missing access_token → false, upsert NOT called", async () => {
      const upserts: Array<Record<string, unknown>> = [];
      mockOauthAccess.mockResolvedValue({ ok: true, team: { id: "T1" } });
      expect(await runExchange(makePg(upserts))).toBe(false);
      expect(upserts).toHaveLength(0);
    });

    it("(c) full valid response → true, upsert carries teamId/token/botUser/scopes/installedBy", async () => {
      const upserts: Array<Record<string, unknown>> = [];
      mockOauthAccess.mockResolvedValue({
        ok: true,
        team: { id: "T_full", name: "Acme" },
        access_token: "xoxb-full",
        bot_user_id: "B123",
        scope: "chat:write,users:read",
      });
      expect(await runExchange(makePg(upserts))).toBe(true);
      expect(upserts).toHaveLength(1);
      expect(upserts[0]).toMatchObject({
        workspaceId: WS,
        provider: "slack",
        externalId: "T_full",
        accessToken: "xoxb-full",
        botUserId: "B123",
        scopes: "chat:write,users:read",
        installedBy: USER_ID,
        config: { teamName: "Acme" },
      });
    });

    it("(d) valid but bot_user_id null → still stored (botUserId:null) + console.warn canary fires", async () => {
      const upserts: Array<Record<string, unknown>> = [];
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(noop);
      mockOauthAccess.mockResolvedValue({
        ok: true,
        team: { id: "T_nobot" },
        access_token: "xoxb-x",
        scope: "chat:write",
      });
      expect(await runExchange(makePg(upserts))).toBe(true);
      expect(upserts).toHaveLength(1);
      expect(upserts[0]).toMatchObject({ externalId: "T_nobot", botUserId: null });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("no bot_user_id");
      warnSpy.mockRestore();
    });
  });

  // ── item 2 + 4a: GET /api/slack/oauth/callback — the PUBLIC redirect matrix and
  //    open-redirect hardening. The callback is unauthenticated; requireAuth is a
  //    pass-through here (it never runs for this route anyway). ──
  describe("GET /api/slack/oauth/callback — redirect matrix + open-redirect hardening", () => {
    function makePg(upserts: Array<Record<string, unknown>>): PgSync {
      return {
        async upsertIntegrationInstallation(opts: Record<string, unknown>) {
          upserts.push(opts);
          return String(opts.id);
        },
      } as unknown as PgSync;
    }

    function callbackApp(upserts: Array<Record<string, unknown>>) {
      const requireAuth = async (_c: Context<RelayEnv>, next: Next) => {
        await next();
      };
      return createSlackOAuthRoutes({ pg: makePg(upserts), requireAuth });
    }

    function validState(): string {
      return signSlackOAuthState({ workspaceId: WS, userId: USER_ID });
    }

    function hit(
      app: ReturnType<typeof callbackApp>,
      state: string,
      extraHeaders: Record<string, string> = {},
    ): Promise<Response> {
      return app.request(
        `/api/slack/oauth/callback?code=code_abc&state=${encodeURIComponent(state)}`,
        { method: "GET", headers: extraHeaders },
      );
    }

    it("valid signed state + mocked success → 302 to the Slack integration page (?slack=connected)", async () => {
      const upserts: Array<Record<string, unknown>> = [];
      mockOauthAccess.mockResolvedValue({
        ok: true,
        team: { id: "T_ok", name: "Acme" },
        access_token: "xoxb-ok",
        bot_user_id: "B1",
        scope: "chat:write",
      });
      const res = await hit(callbackApp(upserts), validState());
      expect(res.status).toBe(302);
      const loc = res.headers.get("location") ?? "";
      expect(loc.startsWith(`${APP_URL}/`)).toBe(true);
      expect(loc.endsWith("/settings/integrations/slack?slack=connected")).toBe(true);
      expect(upserts).toHaveLength(1);
    });

    it("forged / unsigned state → 302 to root ?slack=oauth_error, no upsert, no token exchange", async () => {
      const upserts: Array<Record<string, unknown>> = [];
      const res = await hit(callbackApp(upserts), "forged.state");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${APP_URL}/?slack=oauth_error`);
      expect(upserts).toHaveLength(0);
      expect(mockOauthAccess).not.toHaveBeenCalled();
    });

    it("exchange that throws → 302 ?slack=oauth_error (caught, never a 500), no upsert", async () => {
      const upserts: Array<Record<string, unknown>> = [];
      const errorSpy = vi.spyOn(console, "error").mockImplementation(noop);
      mockOauthAccess.mockRejectedValue(new Error("network boom"));
      const res = await hit(callbackApp(upserts), validState());
      expect(res.status).toBe(302);
      const loc = res.headers.get("location") ?? "";
      expect(loc.endsWith("/settings/integrations/slack?slack=oauth_error")).toBe(true);
      expect(upserts).toHaveLength(0);
      errorSpy.mockRestore();
    });

    it("ignores an attacker X-Forwarded-Host and redirects to the CYBORG_APP_URL origin", async () => {
      const upserts: Array<Record<string, unknown>> = [];
      mockOauthAccess.mockResolvedValue({
        ok: true,
        team: { id: "T_ok" },
        access_token: "xoxb-ok",
        bot_user_id: "B1",
        scope: "chat:write",
      });
      const res = await hit(callbackApp(upserts), validState(), {
        "X-Forwarded-Host": "evil.example.com",
        "X-Forwarded-Proto": "https",
      });
      expect(res.status).toBe(302);
      const loc = res.headers.get("location") ?? "";
      expect(loc.startsWith(`${APP_URL}/`)).toBe(true);
      expect(loc).not.toContain("evil.example.com");
    });
  });

  // ── item 3: GET /api/slack/installations — the access_token (bot token) is STRIPPED
  //    from the client projection; membership guards the read. ──
  describe("GET /api/slack/installations — token-strip invariant + membership", () => {
    const ROW = {
      id: "intg_1",
      workspaceId: WS,
      provider: "slack",
      externalId: "T1",
      config: { teamName: "Acme" },
      accessToken: "xoxb-SECRET-NEVER-LEAK",
      botUserId: "B1",
      scopes: "chat:write,users:read",
      installedBy: USER_ID,
      createdAt: 123,
    };

    function makeApp(callerIsMember: boolean) {
      const requireAuth = async (c: Context<RelayEnv>, next: Next) => {
        c.set("userId", USER_ID);
        c.set("userEmail", `${USER_ID}@e2e.dev`);
        await next();
      };
      const pg = {
        async isMember(workspaceId: string, userId: string) {
          return callerIsMember && workspaceId === WS && userId === USER_ID;
        },
        async listIntegrationInstallations() {
          return [ROW];
        },
      } as unknown as PgSync;
      return createSlackOAuthRoutes({ pg, requireAuth });
    }

    it("member → 200 and the row is projected WITHOUT accessToken (keeps botUserId/scopes/config)", async () => {
      const res = await makeApp(true).request(`/api/slack/installations?workspaceId=${WS}`);
      expect(res.status).toBe(200);
      const { installations } = (await res.json()) as {
        installations: Array<Record<string, unknown>>;
      };
      expect(installations).toHaveLength(1);
      expect("accessToken" in installations[0]).toBe(false);
      expect(installations[0]).toMatchObject({
        id: "intg_1",
        botUserId: "B1",
        scopes: "chat:write,users:read",
        config: { teamName: "Acme" },
      });
    });

    it("non-member → 403", async () => {
      const res = await makeApp(false).request(`/api/slack/installations?workspaceId=${WS}`);
      expect(res.status).toBe(403);
    });

    it("missing workspaceId → 400", async () => {
      const res = await makeApp(true).request(`/api/slack/installations`);
      expect(res.status).toBe(400);
    });
  });

  // ── item 4b: GET /api/slack/config — the install URL's redirect_uri is built from
  //    the stable configured base (CYBORG_APP_URL), byte-identical to the callback
  //    path, and never from an attacker-influenceable X-Forwarded-Host. ──
  describe("GET /api/slack/config — stable, byte-identical redirect_uri", () => {
    function makeApp() {
      const requireAuth = async (c: Context<RelayEnv>, next: Next) => {
        c.set("userId", USER_ID);
        c.set("userEmail", `${USER_ID}@e2e.dev`);
        await next();
      };
      const pg = {
        async isMember(workspaceId: string, userId: string) {
          return workspaceId === WS && userId === USER_ID;
        },
      } as unknown as PgSync;
      return createSlackOAuthRoutes({ pg, requireAuth });
    }

    it("installUrl redirect_uri === CYBORG_APP_URL + the callback path, ignoring X-Forwarded-Host", async () => {
      const res = await makeApp().request(`/api/slack/config?workspaceId=${WS}`, {
        method: "GET",
        headers: { "X-Forwarded-Host": "evil.example.com", "X-Forwarded-Proto": "https" },
      });
      expect(res.status).toBe(200);
      const { configured, installUrl } = (await res.json()) as {
        configured: boolean;
        installUrl: string;
      };
      expect(configured).toBe(true);
      expect(installUrl).not.toContain("evil.example.com");
      const redirectUri = new URL(installUrl).searchParams.get("redirect_uri");
      expect(redirectUri).toBe(`${APP_URL}/api/slack/oauth/callback`);
    });
  });

  // ── item 5: BOLA on the two DELETE routes — a target owned by ANOTHER workspace is
  //    a 404 and the delete fn is never called; a same-workspace target deletes. ──
  describe("DELETE /api/slack/installation/:id — BOLA (workspace ownership)", () => {
    function makeApp(installWorkspaceId: string | null, deletes: string[]) {
      const requireAuth = async (c: Context<RelayEnv>, next: Next) => {
        c.set("userId", USER_ID);
        c.set("userEmail", `${USER_ID}@e2e.dev`);
        await next();
      };
      const pg = {
        async isMember(workspaceId: string, userId: string) {
          return workspaceId === WS && userId === USER_ID;
        },
        async getIntegrationInstallationById(id: string) {
          return installWorkspaceId === null
            ? null
            : { id, workspaceId: installWorkspaceId, provider: "slack" };
        },
        async deleteIntegrationInstallation(id: string) {
          deletes.push(id);
        },
      } as unknown as PgSync;
      return createSlackOAuthRoutes({ pg, requireAuth });
    }

    it("target owned by ANOTHER workspace → 404, delete NOT called", async () => {
      const deletes: string[] = [];
      const res = await makeApp(OTHER_WS, deletes).request(
        `/api/slack/installation/intg_x?workspaceId=${WS}`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(404);
      expect(deletes).toHaveLength(0);
    });

    it("target in the caller's workspace → 200, delete called", async () => {
      const deletes: string[] = [];
      const res = await makeApp(WS, deletes).request(
        `/api/slack/installation/intg_x?workspaceId=${WS}`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(200);
      expect(deletes).toEqual(["intg_x"]);
    });
  });

  describe("DELETE /api/slack/channel-link/:id — BOLA (workspace ownership)", () => {
    function makeApp(workspaceLinks: Array<{ id: string }>, deletes: string[]) {
      const requireAuth = async (c: Context<RelayEnv>, next: Next) => {
        c.set("userId", USER_ID);
        c.set("userEmail", `${USER_ID}@e2e.dev`);
        await next();
      };
      const pg = {
        async isMember(workspaceId: string, userId: string) {
          return workspaceId === WS && userId === USER_ID;
        },
        async listSlackChannelLinksForWorkspace() {
          return workspaceLinks;
        },
        async deleteSlackChannelLink(id: string) {
          deletes.push(id);
        },
      } as unknown as PgSync;
      return createSlackOAuthRoutes({ pg, requireAuth });
    }

    it("a link id NOT in the caller's workspace list → 404, delete NOT called", async () => {
      const deletes: string[] = [];
      const res = await makeApp([{ id: "slkl_mine" }], deletes).request(
        `/api/slack/channel-link/slkl_foreign?workspaceId=${WS}`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(404);
      expect(deletes).toHaveLength(0);
    });

    it("a link id in the caller's workspace list → 200, delete called", async () => {
      const deletes: string[] = [];
      const res = await makeApp([{ id: "slkl_mine" }], deletes).request(
        `/api/slack/channel-link/slkl_mine?workspaceId=${WS}`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(200);
      expect(deletes).toEqual(["slkl_mine"]);
    });
  });
});
