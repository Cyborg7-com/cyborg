import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createSlackRoutes, _resetSlackEventDedupeForTest, type SlackRoutesDeps } from "./slack.js";
import { _resetSlackEchoGuardForTest } from "../slack-outbound.js";
import type { PgSync, StoredSlackChannelLink } from "../db/pg-sync.js";
import type { WorkspaceRelay } from "../workspace-relay.js";

// Drive the REAL public Slack Events receiver end-to-end via the Hono app
// (createSlackRoutes → app.request), the same HTTP-endpoint idiom github.route.test.ts
// uses. These pin the signature gate, the url_verification handshake, the 200-ack +
// async fire-and-forget inbound handling, the event_id dedupe, and the pg-null ack.
//
// The signing secret is read from process.env by getSlackSigningSecret() at REQUEST
// time, so each test sets a known value and signs bodies with the adapter's HMAC v0
// scheme (verifyWebhook: `v0=` + hex(HMAC-SHA256(secret, `v0:${ts}:${rawBody}`))).

const SIGNING_SECRET = "test-slack-signing-secret";
const ORIGINAL_SECRET = process.env.SLACK_SIGNING_SECRET;

const LINK: StoredSlackChannelLink = {
  id: "lnk_1",
  workspaceId: "ws_1",
  installationId: "ins_1",
  cyborgChannelId: "ch_cyborg",
  slackChannelId: "C_SLACK",
  slackTeamId: "T1",
  syncDirection: "bidirectional",
  createdBy: "u1",
  createdAt: 0,
};

interface InjectCall {
  workspaceId: string;
  message: Record<string, unknown>;
  fromId?: string;
}

// A minimal typed-fake pg that resolves the bound channel link and answers every
// lookup the single-message mirror path makes (no install, first-sight user, no
// existing mapping) so ONE inbound message injects exactly once. `over.pg` lets a
// test force pg=null (the DB-absent ack path); omitting it uses the default fake.
function makeDeps(over: { pg?: PgSync | null } = {}): {
  deps: SlackRoutesDeps;
  injects: InjectCall[];
} {
  const injects: InjectCall[] = [];
  const defaultPg = {
    async getSlackChannelLinkBySlackChannel() {
      return LINK;
    },
    async getIntegrationInstallationById() {
      return null;
    },
    async getSlackUserMap() {
      return null;
    },
    async upsertSyntheticUser() {},
    async upsertSlackUserMap() {},
    async getMessageIntegrationByExternal() {
      return null;
    },
    async upsertMessageIntegration() {},
  } as unknown as PgSync;

  const relay = {
    injectMessage(workspaceId: string, message: Record<string, unknown>, fromId?: string) {
      injects.push({ workspaceId, message, fromId });
      return 1;
    },
  } as unknown as WorkspaceRelay;

  const deps: SlackRoutesDeps = {
    pg: over.pg === undefined ? defaultPg : over.pg,
    relay,
    s3Client: null,
    s3Bucket: undefined,
    s3Region: "us-east-1",
  };
  return { deps, injects };
}

// Slack signing-secret HMAC v0 headers over the EXACT raw body the route will read.
function signedHeaders(
  rawBody: string,
  opts: { secret?: string; timestamp?: string } = {},
): Record<string, string> {
  const secret = opts.secret ?? SIGNING_SECRET;
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  return {
    "Content-Type": "application/json",
    "x-slack-signature": signature,
    "x-slack-request-timestamp": timestamp,
  };
}

function post(
  app: ReturnType<typeof createSlackRoutes>,
  rawBody: string,
  headers: Record<string, string>,
): Promise<Response> {
  return app.request("/api/slack/events", { method: "POST", headers, body: rawBody });
}

// A Slack event_callback carrying one plain `message` event (subtype undefined → the
// mirror-a-create path). parseInbound normalizes it into one ParsedInboundMessage.
function messageEvent(over: { eventId?: string; ts?: string } = {}): Record<string, unknown> {
  return {
    type: "event_callback",
    team_id: "T1",
    event_id: over.eventId ?? "Ev1",
    event: {
      type: "message",
      channel: "C_SLACK",
      user: "U1",
      text: "hello from slack",
      ts: over.ts ?? "1700000000.000100",
    },
  };
}

// Let the fire-and-forget processInboundEvent settle (it runs AFTER the 200-ack).
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
  _resetSlackEventDedupeForTest();
  _resetSlackEchoGuardForTest();
});

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.SLACK_SIGNING_SECRET;
  else process.env.SLACK_SIGNING_SECRET = ORIGINAL_SECRET;
});

describe("POST /api/slack/events — signature gate", () => {
  it("rejects an UNSIGNED request with 401 (no HMAC headers)", async () => {
    const { deps, injects } = makeDeps();
    const app = createSlackRoutes(deps);
    const raw = JSON.stringify(messageEvent());
    const res = await app.request("/api/slack/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid signature" });
    await flush();
    expect(injects).toHaveLength(0);
  });

  it("rejects a WRONG-signature request with 401 (HMAC over a different secret)", async () => {
    const { deps, injects } = makeDeps();
    const app = createSlackRoutes(deps);
    const raw = JSON.stringify(messageEvent());
    const res = await post(app, raw, signedHeaders(raw, { secret: "the-WRONG-secret" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid signature" });
    await flush();
    expect(injects).toHaveLength(0);
  });
});

describe("POST /api/slack/events — url_verification handshake", () => {
  it("echoes the challenge for a correctly-signed url_verification (200)", async () => {
    const { deps } = makeDeps();
    const app = createSlackRoutes(deps);
    const raw = JSON.stringify({ type: "url_verification", challenge: "abc-123-challenge" });
    const res = await post(app, raw, signedHeaders(raw));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "abc-123-challenge" });
  });
});

describe("POST /api/slack/events — event delivery + dedupe", () => {
  it("acks a signed message event (200) and runs the inbound mirror once", async () => {
    const { deps, injects } = makeDeps();
    const app = createSlackRoutes(deps);
    const raw = JSON.stringify(messageEvent());
    const res = await post(app, raw, signedHeaders(raw));

    // Ack first (Slack's <3s window), then process asynchronously.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // The fire-and-forget handler injects exactly one channel-message broadcast.
    await vi.waitFor(() => expect(injects).toHaveLength(1));
    expect(injects[0]!.message.type).toBe("cyborg:channel_message_broadcast");
    expect(injects[0]!.workspaceId).toBe("ws_1");
    expect(injects[0]!.fromId).toBe("slack:T1:U1");
  });

  it("dedupes a redelivered event_id — the second delivery is a no-op", async () => {
    const { deps, injects } = makeDeps();
    const app = createSlackRoutes(deps);
    const raw = JSON.stringify(messageEvent({ eventId: "EvDup" }));

    const first = await post(app, raw, signedHeaders(raw));
    expect(first.status).toBe(200);
    await vi.waitFor(() => expect(injects).toHaveLength(1));

    // Same event_id, freshly re-signed (new timestamp) → the dedupe gate short-circuits
    // BEFORE any processing is scheduled, so no second inject.
    const second = await post(app, raw, signedHeaders(raw));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true });
    await flush();
    expect(injects).toHaveLength(1);
  });

  it("still 200-acks when pg is null (no DB to resolve links → no inject)", async () => {
    const { deps, injects } = makeDeps({ pg: null });
    const app = createSlackRoutes(deps);
    const raw = JSON.stringify(messageEvent());
    const res = await post(app, raw, signedHeaders(raw));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await flush();
    expect(injects).toHaveLength(0);
  });
});
