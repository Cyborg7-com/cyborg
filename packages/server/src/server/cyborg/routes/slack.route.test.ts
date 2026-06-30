import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handleInboundMessage, rehostSlackFile, type SlackRoutesDeps } from "./slack.js";
import { MAX_ATTACHMENT_BYTES } from "./assets.js";
import { markPostedTs, _resetSlackEchoGuardForTest } from "../slack-outbound.js";
import type {
  PgSync,
  StoredSlackChannelLink,
  StoredIntegrationInstallation,
  StoredSlackUserMap,
  StoredMessageIntegration,
} from "../db/pg-sync.js";
import type { ParsedInboundMessage, ParsedInboundFile } from "../integrations/types.js";
import type { WorkspaceRelay } from "../workspace-relay.js";

beforeEach(() => _resetSlackEchoGuardForTest());

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

interface FakeState {
  link?: StoredSlackChannelLink | null;
  install?: StoredIntegrationInstallation | null;
  userMap?: StoredSlackUserMap | null;
  threadParent?: StoredMessageIntegration | null;
  // Slack ts values already recorded in message_integrations (durable inbound dedupe):
  // the dedupe gate probes getMessageIntegrationByExternal(provider, msg.ts) and SKIPs
  // when a row exists. Distinct from threadParent (probed by threadTs) so one fake can
  // serve both lookups without cross-talk.
  seenTs?: Set<string>;
  injects: InjectCall[];
  ensuredUsers: { id: string; email: string; name?: string | null }[];
  userMapUpserts: { syntheticUserId: string; slackUserId: string; displayName?: string | null }[];
  msgIntegrationUpserts: {
    messageId: string;
    externalId: string;
    externalThreadId: string | null;
  }[];
}

function makeDeps(state: FakeState): {
  pg: PgSync;
  relay: WorkspaceRelay;
  deps: SlackRoutesDeps;
} {
  const pg = {
    async getSlackChannelLinkBySlackChannel() {
      return state.link === undefined ? LINK : state.link;
    },
    async getIntegrationInstallationById() {
      return state.install ?? null;
    },
    async getSlackUserMap() {
      return state.userMap ?? null;
    },
    async ensureUser(id: string, email: string, name?: string | null) {
      state.ensuredUsers.push({ id, email, name });
    },
    async upsertSlackUserMap(opts: {
      syntheticUserId: string;
      slackUserId: string;
      displayName?: string | null;
    }) {
      state.userMapUpserts.push({
        syntheticUserId: opts.syntheticUserId,
        slackUserId: opts.slackUserId,
        displayName: opts.displayName,
      });
    },
    async getMessageIntegrationByExternal(_provider: string, externalId: string) {
      // The dedupe gate probes by msg.ts; thread resolution probes by threadTs. Answer
      // each by the arg so a threadParent fixture doesn't accidentally trip the dedupe.
      if (state.seenTs?.has(externalId)) {
        return {
          messageId: "existing_cyborg_msg",
          workspaceId: "ws_1",
          provider: "slack",
          externalId,
          externalThreadId: null,
          createdAt: 0,
        };
      }
      if (state.threadParent && externalId === state.threadParent.externalId) {
        return state.threadParent;
      }
      return null;
    },
    async upsertMessageIntegration(opts: {
      messageId: string;
      externalId: string;
      externalThreadId?: string | null;
    }) {
      state.msgIntegrationUpserts.push({
        messageId: opts.messageId,
        externalId: opts.externalId,
        externalThreadId: opts.externalThreadId ?? null,
      });
    },
  } as unknown as PgSync;

  const relay = {
    injectMessage(workspaceId: string, message: Record<string, unknown>, fromId?: string) {
      state.injects.push({ workspaceId, message, fromId });
      return 1;
    },
  } as unknown as WorkspaceRelay;

  const deps: SlackRoutesDeps = {
    pg,
    relay,
    s3Client: null,
    s3Bucket: undefined,
    s3Region: "us-east-1",
  };
  return { pg, relay, deps };
}

function inbound(over: Partial<ParsedInboundMessage> = {}): ParsedInboundMessage {
  return {
    kind: "message",
    teamId: "T1",
    channelId: "C_SLACK",
    userId: "U1",
    text: "hello from slack",
    ts: "1700000000.000100",
    threadTs: null,
    botId: null,
    eventId: "Ev1",
    ...over,
  };
}

function newState(over: Partial<FakeState> = {}): FakeState {
  return {
    injects: [],
    ensuredUsers: [],
    userMapUpserts: [],
    msgIntegrationUpserts: [],
    ...over,
  };
}

describe("handleInboundMessage — inbound Slack → injectMessage mapping", () => {
  it("injects with a synthetic author, ensures the user + map, and records the ts back-link", async () => {
    const state = newState(); // no installation → token null → no network resolveUser
    const { pg, relay, deps } = makeDeps(state);
    await handleInboundMessage(pg, relay, deps, inbound());

    // ONE injected channel-message broadcast into the BOUND Cyborg channel.
    expect(state.injects).toHaveLength(1);
    const { workspaceId, message, fromId } = state.injects[0]!;
    expect(workspaceId).toBe("ws_1");
    expect(fromId).toBe("slack:T1:U1"); // synthetic author id
    expect(message.type).toBe("cyborg:channel_message_broadcast");
    const p = message.payload as Record<string, unknown>;
    expect(p).toMatchObject({
      channelId: "ch_cyborg",
      fromId: "slack:T1:U1",
      fromType: "human",
      fromName: "U1", // token null → degrades to the Slack user id
      text: "hello from slack",
      parentId: null,
      source: "slack",
    });
    expect(p.createdAt).toBe(1700000000000); // ts seconds.micros → epoch ms (.000100 = 0.1ms)

    // synthetic guest user + map persisted (first sight).
    expect(state.ensuredUsers).toEqual([
      { id: "slack:T1:U1", email: "slack_T1_U1@remote.local", name: "U1" },
    ]);
    expect(state.userMapUpserts).toEqual([
      { syntheticUserId: "slack:T1:U1", slackUserId: "U1", displayName: "U1" },
    ]);

    // message_integrations back-link: cyborg msg id ↔ Slack ts.
    expect(state.msgIntegrationUpserts).toHaveLength(1);
    expect(state.msgIntegrationUpserts[0]).toMatchObject({
      externalId: "1700000000.000100",
      externalThreadId: null,
    });
    // the injected message id is the SAME id recorded in the back-link.
    expect(state.msgIntegrationUpserts[0]!.messageId).toBe(p.id);
  });

  it("threads a reply under the parent resolved from thread_ts", async () => {
    const state = newState({
      threadParent: {
        messageId: "parent_cyborg_msg",
        workspaceId: "ws_1",
        provider: "slack",
        externalId: "1700000000.000000",
        externalThreadId: null,
        createdAt: 0,
      },
    });
    const { pg, relay, deps } = makeDeps(state);
    await handleInboundMessage(
      pg,
      relay,
      deps,
      inbound({ ts: "1700000002.000000", threadTs: "1700000000.000000" }),
    );
    const p = state.injects[0]!.message.payload as Record<string, unknown>;
    expect(p.parentId).toBe("parent_cyborg_msg");
    expect(state.msgIntegrationUpserts[0]!.externalThreadId).toBe("1700000000.000000");
  });

  it("reuses the cached display name for a known Slack user (no re-ensure)", async () => {
    const state = newState({
      install: {
        id: "ins_1",
        workspaceId: "ws_1",
        provider: "slack",
        externalId: "T1",
        config: {},
        accessToken: "xoxb-token",
        botUserId: "UBOT",
        scopes: null,
        installedBy: "u1",
        createdAt: 0,
      },
      userMap: {
        id: "slku_1",
        workspaceId: "ws_1",
        slackTeamId: "T1",
        slackUserId: "U1",
        syntheticUserId: "slack:T1:U1",
        displayName: "Ada Lovelace",
        createdAt: 0,
      },
    });
    const { pg, relay, deps } = makeDeps(state);
    await handleInboundMessage(pg, relay, deps, inbound());
    const p = state.injects[0]!.message.payload as Record<string, unknown>;
    expect(p.fromName).toBe("Ada Lovelace");
    // already known → no second ensureUser / map upsert (and no network resolveUser).
    expect(state.ensuredUsers).toHaveLength(0);
    expect(state.userMapUpserts).toHaveLength(0);
  });
});

describe("handleInboundMessage — echo guard + skips", () => {
  it("drops a message whose ts WE just posted (outbound echo)", async () => {
    const state = newState();
    const { pg, relay, deps } = makeDeps(state);
    markPostedTs("1700000000.000100"); // we posted this exact ts outbound
    await handleInboundMessage(pg, relay, deps, inbound({ ts: "1700000000.000100" }));
    expect(state.injects).toHaveLength(0);
  });

  it("drops a bot message authored by OUR bot (identity guard)", async () => {
    const state = newState({
      install: {
        id: "ins_1",
        workspaceId: "ws_1",
        provider: "slack",
        externalId: "T1",
        config: {},
        accessToken: "xoxb-token",
        botUserId: "UBOT",
        scopes: null,
        installedBy: "u1",
        createdAt: 0,
      },
    });
    const { pg, relay, deps } = makeDeps(state);
    await handleInboundMessage(pg, relay, deps, inbound({ userId: "UBOT", botId: "B1" }));
    expect(state.injects).toHaveLength(0);
  });

  it("does not mirror an edit/delete (parsed-but-deferred for WAVE 2a)", async () => {
    const state = newState();
    const { pg, relay, deps } = makeDeps(state);
    await handleInboundMessage(pg, relay, deps, inbound({ kind: "message_changed" }));
    await handleInboundMessage(pg, relay, deps, inbound({ kind: "message_deleted" }));
    expect(state.injects).toHaveLength(0);
  });

  it("skips a channel that isn't Slack-linked", async () => {
    const state = newState({ link: null });
    const { pg, relay, deps } = makeDeps(state);
    await handleInboundMessage(pg, relay, deps, inbound());
    expect(state.injects).toHaveLength(0);
  });

  it("skips a message with no authoring user", async () => {
    const state = newState();
    const { pg, relay, deps } = makeDeps(state);
    await handleInboundMessage(pg, relay, deps, inbound({ userId: null }));
    expect(state.injects).toHaveLength(0);
  });

  it("skips a redelivery whose ts is already recorded (durable cross-instance dedupe)", async () => {
    // The in-memory seenEventIds map clears on restart / doesn't span relay instances;
    // the message_integrations (provider, ts) row in shared Postgres is the restart-proof
    // guard. A ts already recorded → no second inject.
    const state = newState({ seenTs: new Set(["1700000000.000100"]) });
    const { pg, relay, deps } = makeDeps(state);
    await handleInboundMessage(pg, relay, deps, inbound({ ts: "1700000000.000100" }));
    expect(state.injects).toHaveLength(0);
    expect(state.msgIntegrationUpserts).toHaveLength(0);
  });
});

// FIX 2: the inbound file re-host fetches an attacker-influenceable url_private from the
// (HMAC-verified) webhook. These pin the SSRF allowlist (no fetch for a non-Slack/non-
// HTTPS URL), the OOM cap (declared + streamed), and the stream-leak cancel on non-OK.
function slackFile(over: Partial<ParsedInboundFile> = {}): ParsedInboundFile {
  return {
    id: "F1",
    name: "pic.png",
    mimetype: "image/png",
    urlPrivate: "https://files.slack.com/files-pri/T1-F1/pic.png",
    size: 1234,
    ...over,
  };
}

// Minimal Response stand-in: rehostSlackFile only touches ok/status/headers.get +
// body.getReader()/body.cancel(). Cast avoids depending on the global Response ctor.
function fakeResponse(opts: {
  ok: boolean;
  status?: number;
  contentLength?: string | null;
  chunks?: Uint8Array[];
  bodyCancel?: () => Promise<void>;
}): Response {
  const chunks = opts.chunks ?? [];
  let i = 0;
  const reader = {
    read: async () =>
      i < chunks.length ? { done: false, value: chunks[i++]! } : { done: true, value: undefined },
    cancel: async () => {},
  };
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    headers: {
      get: (k: string) => (k.toLowerCase() === "content-length" ? (opts.contentLength ?? null) : null),
    },
    body: { getReader: () => reader, cancel: opts.bodyCancel ?? (async () => {}) },
  } as unknown as Response;
}

describe("rehostSlackFile — SSRF + size-cap + leak hardening", () => {
  const deps: SlackRoutesDeps = {
    pg: {} as unknown as PgSync,
    relay: {} as unknown as WorkspaceRelay,
    s3Client: null,
    s3Bucket: undefined,
    s3Region: "us-east-1",
  };
  afterEach(() => vi.unstubAllGlobals());

  it("refuses a non-Slack host without fetching (SSRF)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const out = await rehostSlackFile(slackFile({ urlPrivate: "https://evil.example.com/x" }), "x", deps);
    expect(out).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an http (non-TLS) Slack URL without fetching (SSRF)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const out = await rehostSlackFile(slackFile({ urlPrivate: "http://files.slack.com/x" }), "x", deps);
    expect(out).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an internal-metadata-IP URL without fetching (SSRF)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const out = await rehostSlackFile(
      slackFile({ urlPrivate: "https://169.254.169.254/latest/meta-data/" }),
      "x",
      deps,
    );
    expect(out).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an over-cap declared Content-Length up front and cancels the body", async () => {
    const cancel = vi.fn(async () => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse({ ok: true, contentLength: String(MAX_ATTACHMENT_BYTES + 1), bodyCancel: cancel }),
      ),
    );
    const out = await rehostSlackFile(slackFile(), "x", deps);
    expect(out).toBeNull();
    expect(cancel).toHaveBeenCalled();
  });

  it("aborts a body that streams past the cap (lying/absent Content-Length)", async () => {
    const oversize = new Uint8Array(MAX_ATTACHMENT_BYTES + 1024);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse({ ok: true, contentLength: null, chunks: [oversize] })),
    );
    const out = await rehostSlackFile(slackFile(), "x", deps);
    expect(out).toBeNull();
  });

  it("cancels the body on a non-OK response (no stream leak)", async () => {
    const cancel = vi.fn(async () => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse({ ok: false, status: 403, bodyCancel: cancel })),
    );
    const out = await rehostSlackFile(slackFile(), "x", deps);
    expect(out).toBeNull();
    expect(cancel).toHaveBeenCalled();
  });
});
