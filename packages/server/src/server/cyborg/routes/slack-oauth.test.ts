import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Context, Next } from "hono";
import { signSlackOAuthState, verifySlackOAuthState, createSlackOAuthRoutes } from "./slack-oauth.js";
import type { PgSync } from "../db/pg-sync.js";
import type { RelayEnv } from "./types.js";

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

function postChannelLink(app: ReturnType<typeof makeChannelLinkApp>, body: Record<string, unknown>) {
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
