import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  handleInboundMessage,
  handleInboundReaction,
  rehostSlackFile,
  type SlackRoutesDeps,
} from "./slack.js";
import { slackAdapter } from "../integrations/slack-adapter.js";
import { MAX_ATTACHMENT_BYTES } from "./assets.js";
import {
  markPostedTs,
  markPostedReaction,
  _resetSlackEchoGuardForTest,
} from "../slack-outbound.js";
import type {
  PgSync,
  StoredSlackChannelLink,
  StoredIntegrationInstallation,
  StoredSlackUserMap,
  StoredMessageIntegration,
} from "../db/pg-sync.js";
import type {
  ParsedInboundMessage,
  ParsedInboundFile,
  ParsedInboundReaction,
} from "../integrations/types.js";
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
  // serve both lookups without cross-talk. Shorthand for "recorded under the default
  // LINK workspace (ws_1)" — the only workspace the legacy cases use.
  seenTs?: Set<string>;
  // Per-workspace reverse-lookup store: workspaceId → the set of Slack ts recorded
  // UNDER THAT workspace. Lets a test place a ts under a DIFFERENT workspace than the
  // link's to prove getMessageIntegrationByExternal is tenant-scoped (a foreign-tenant
  // row must NOT resolve for this link's workspace).
  seenTsByWorkspace?: Map<string, Set<string>>;
  // Every (provider, externalId, workspaceId) tuple the reverse lookup was called with,
  // so a test can assert the workspaceId the resolver was scoped to.
  msgIntegrationLookups: { provider: string; externalId: string; workspaceId: string }[];
  injects: InjectCall[];
  ensuredUsers: { id: string; email: string; name?: string | null; imageUrl?: string | null }[];
  // The stored users row getUserById returns (for the avatar-backfill path). null = absent.
  storedUser?: { id: string; email: string; name: string | null; imageUrl: string | null } | null;
  userMapUpserts: { syntheticUserId: string; slackUserId: string; displayName?: string | null }[];
  msgIntegrationUpserts: {
    messageId: string;
    externalId: string;
    externalThreadId: string | null;
  }[];
  textUpdates: { messageId: string; text: string }[];
  deletes: string[];
  reactionAdds: { messageId: string; userId: string; userName: string; emoji: string }[];
  reactionRemoves: { messageId: string; userId: string; emoji: string }[];
  // Whether addReaction/removeReaction report a change (false = already in target state).
  reactionChanged?: boolean;
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
    async getUserById() {
      return state.storedUser ?? null;
    },
    async upsertSyntheticUser(
      id: string,
      email: string,
      name: string | null,
      imageUrl: string | null,
    ) {
      state.ensuredUsers.push({ id, email, name, imageUrl });
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
    async getMessageIntegrationByExternal(
      provider: string,
      externalId: string,
      workspaceId: string,
    ) {
      // Record every lookup so a test can assert the workspace it was scoped to.
      state.msgIntegrationLookups.push({ provider, externalId, workspaceId });
      // TENANT-SCOPED reverse lookup: a ts resolves to a mapping only UNDER the same
      // workspace it was recorded in. The dedupe gate probes by msg.ts; thread
      // resolution probes by threadTs. `seenTs` is shorthand for the default LINK
      // workspace (ws_1); `seenTsByWorkspace` overrides per workspace so a foreign-tenant
      // row does not resolve for this link's workspace.
      const scoped = state.seenTsByWorkspace?.get(workspaceId)?.has(externalId) ?? false;
      const legacy = workspaceId === "ws_1" && (state.seenTs?.has(externalId) ?? false);
      if (scoped || legacy) {
        return {
          messageId: "existing_cyborg_msg",
          workspaceId,
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
    async updateMessageText(messageId: string, text: string) {
      state.textUpdates.push({ messageId, text });
      return true;
    },
    async deleteMessage(messageId: string) {
      state.deletes.push(messageId);
      return true;
    },
    async addReaction(
      _workspaceId: string,
      messageId: string,
      userId: string,
      userName: string,
      emoji: string,
    ) {
      state.reactionAdds.push({ messageId, userId, userName, emoji });
      return state.reactionChanged ?? true;
    },
    async removeReaction(_workspaceId: string, messageId: string, userId: string, emoji: string) {
      state.reactionRemoves.push({ messageId, userId, emoji });
      return state.reactionChanged ?? true;
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
    msgIntegrationLookups: [],
    textUpdates: [],
    deletes: [],
    reactionAdds: [],
    reactionRemoves: [],
    ...over,
  };
}

function reaction(over: Partial<ParsedInboundReaction> = {}): ParsedInboundReaction {
  return {
    action: "added",
    teamId: "T1",
    channelId: "C_SLACK",
    userId: "U1",
    reaction: "thumbsup",
    messageTs: "1700000000.000100",
    eventId: "Ev1",
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

    // synthetic guest user + map persisted (first sight); no token → imageUrl null.
    expect(state.ensuredUsers).toEqual([
      { id: "slack:T1:U1", email: "slack_T1_U1@remote.local", name: "U1", imageUrl: null },
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
    // already known → no second upsertSyntheticUser / map upsert (and no network resolveUser).
    expect(state.ensuredUsers).toHaveLength(0);
    expect(state.userMapUpserts).toHaveLength(0);
  });

  it("calls upsertSyntheticUser with name + imageUrl when resolveUser returns an avatar", async () => {
    // Provide an installation with a token so the resolve path runs.
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
      userMap: null, // no cached map → resolve path runs
    });
    const spy = vi
      .spyOn(slackAdapter, "resolveUser")
      .mockResolvedValue({ name: "Ada Lovelace", imageUrl: "https://slack/img_512.png" });
    const { pg, relay, deps } = makeDeps(state);
    await handleInboundMessage(pg, relay, deps, inbound());
    expect(spy).toHaveBeenCalledWith("xoxb-token", "U1");
    expect(state.ensuredUsers).toEqual([
      {
        id: "slack:T1:U1",
        email: "slack_T1_U1@remote.local",
        name: "Ada Lovelace",
        imageUrl: "https://slack/img_512.png",
      },
    ]);
    vi.restoreAllMocks();
  });

  it("backfills a KNOWN guest's avatar when the stored user has no image", async () => {
    // The regression: a guest created before the avatar was captured is frozen — the map
    // exists so the resolve path was skipped forever, leaving image_url NULL. With a token
    // + a stored image-less user, we re-resolve ONCE and update.
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
      storedUser: {
        id: "slack:T1:U1",
        email: "slack_T1_U1@remote.local",
        name: "Ada Lovelace",
        imageUrl: null, // frozen: never captured
      },
    });
    const spy = vi
      .spyOn(slackAdapter, "resolveUser")
      .mockResolvedValue({ name: "Ada Lovelace", imageUrl: "https://slack/img_512.png" });
    const { pg, relay, deps } = makeDeps(state);
    await handleInboundMessage(pg, relay, deps, inbound());
    expect(spy).toHaveBeenCalledWith("xoxb-token", "U1");
    expect(state.ensuredUsers).toEqual([
      {
        id: "slack:T1:U1",
        email: "slack_T1_U1@remote.local",
        name: "Ada Lovelace",
        imageUrl: "https://slack/img_512.png",
      },
    ]);
    vi.restoreAllMocks();
  });

  it("writes an empty-string sentinel (not null) + keeps the stored name when resolve yields no avatar", async () => {
    // The Gemini-caught storm: if resolveUser returns imageUrl:null (no custom avatar OR a
    // transient users.info failure, which also returns name=userId), we must NOT leave
    // image_url NULL — else every later message re-hits users.info. We write "" (falsy, UI
    // shows initials; non-null, so no retry) and KEEP the stored display name (never clobber
    // it with the userId fallback).
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
      storedUser: {
        id: "slack:T1:U1",
        email: "slack_T1_U1@remote.local",
        name: "Ada Lovelace",
        imageUrl: null,
      },
    });
    // resolveUser's failure/no-avatar shape: name falls back to the raw user id, image null.
    vi.spyOn(slackAdapter, "resolveUser").mockResolvedValue({ name: "U1", imageUrl: null });
    const { pg, relay, deps } = makeDeps(state);
    await handleInboundMessage(pg, relay, deps, inbound());
    expect(state.ensuredUsers).toEqual([
      {
        id: "slack:T1:U1",
        email: "slack_T1_U1@remote.local",
        name: "Ada Lovelace", // stored name preserved, NOT clobbered with "U1"
        imageUrl: "", // sentinel: attempted, none — stops the retry loop
      },
    ]);
    vi.restoreAllMocks();
  });

  it("does NOT re-resolve a known guest that already has an avatar (cheap short-circuit)", async () => {
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
      storedUser: {
        id: "slack:T1:U1",
        email: "slack_T1_U1@remote.local",
        name: "Ada Lovelace",
        imageUrl: "https://slack/existing.png", // already has an avatar
      },
    });
    const spy = vi.spyOn(slackAdapter, "resolveUser");
    const { pg, relay, deps } = makeDeps(state);
    await handleInboundMessage(pg, relay, deps, inbound());
    expect(spy).not.toHaveBeenCalled();
    expect(state.ensuredUsers).toHaveLength(0);
    vi.restoreAllMocks();
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

  it("inbound edit: updates the mirrored Cyborg message text and injects an edit broadcast", async () => {
    // seenTs makes getMessageIntegrationByExternal return the mapping for the ts.
    const state = newState({ seenTs: new Set(["1700000000.000100"]) });
    const { pg, relay, deps } = makeDeps(state);
    await handleInboundMessage(
      pg,
      relay,
      deps,
      inbound({ kind: "message_changed", ts: "1700000000.000100", text: "edited body" }),
    );
    // updateMessageText was called with the mapped Cyborg message id and the new text.
    expect(state.textUpdates).toEqual([{ messageId: "existing_cyborg_msg", text: "edited body" }]);
    // An edit broadcast was injected into the workspace.
    expect(state.injects).toHaveLength(1);
    expect(state.injects[0]!.message.type).toBe("cyborg:edit_message_broadcast");
    const p = state.injects[0]!.message.payload as Record<string, unknown>;
    expect(p.messageId).toBe("existing_cyborg_msg");
    expect(p.text).toBe("edited body");
    // No create-path inject (no channel_message_broadcast).
    const createInjects = state.injects.filter(
      (i) => i.message.type === "cyborg:channel_message_broadcast",
    );
    expect(createInjects).toHaveLength(0);
  });

  it("inbound delete: soft-deletes the mirrored Cyborg message and injects a delete broadcast", async () => {
    const state = newState({ seenTs: new Set(["1700000000.000100"]) });
    const { pg, relay, deps } = makeDeps(state);
    await handleInboundMessage(
      pg,
      relay,
      deps,
      inbound({ kind: "message_deleted", ts: "1700000000.000100" }),
    );
    expect(state.deletes).toEqual(["existing_cyborg_msg"]);
    expect(state.injects).toHaveLength(1);
    expect(state.injects[0]!.message.type).toBe("cyborg:delete_message_broadcast");
    const p = state.injects[0]!.message.payload as Record<string, unknown>;
    expect(p.messageId).toBe("existing_cyborg_msg");
  });

  it("inbound edit of an unmapped ts: no update and no inject", async () => {
    // No seenTs → getMessageIntegrationByExternal returns null → nothing to update.
    const state = newState();
    const { pg, relay, deps } = makeDeps(state);
    await handleInboundMessage(
      pg,
      relay,
      deps,
      inbound({ kind: "message_changed", ts: "9999999999.000000", text: "unknown" }),
    );
    expect(state.textUpdates).toHaveLength(0);
    expect(state.injects).toHaveLength(0);
  });

  it("echo-guard drops our OWN bot's message_changed (bot-identity guard)", async () => {
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
      seenTs: new Set(["1700000000.000100"]),
    });
    const { pg, relay, deps } = makeDeps(state);
    // A message_changed event authored by our own bot (userId === botUserId, botId set).
    await handleInboundMessage(
      pg,
      relay,
      deps,
      inbound({ kind: "message_changed", userId: "UBOT", botId: "B1", ts: "1700000000.000100" }),
    );
    // Dropped by isOurOwnEcho before reaching the edit path.
    expect(state.textUpdates).toHaveLength(0);
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
      get: (k: string) =>
        k.toLowerCase() === "content-length" ? (opts.contentLength ?? null) : null,
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
    const out = await rehostSlackFile(
      slackFile({ urlPrivate: "https://evil.example.com/x" }),
      "x",
      deps,
    );
    expect(out).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an http (non-TLS) Slack URL without fetching (SSRF)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const out = await rehostSlackFile(
      slackFile({ urlPrivate: "http://files.slack.com/x" }),
      "x",
      deps,
    );
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
        fakeResponse({
          ok: true,
          contentLength: String(MAX_ATTACHMENT_BYTES + 1),
          bodyCancel: cancel,
        }),
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

// Inbound Slack reaction → apply on the mirrored Cyborg message as the synthetic author.
const INSTALL_WITH_BOT: StoredIntegrationInstallation = {
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
};

describe("handleInboundReaction — Slack → Cyborg reaction apply", () => {
  it("applies reaction_added as the synthetic author and broadcasts", async () => {
    // seenTs makes getMessageIntegrationByExternal resolve the ts → Cyborg message id.
    const state = newState({ seenTs: new Set(["1700000000.000100"]) });
    const { pg, relay } = makeDeps(state);
    await handleInboundReaction(pg, relay, reaction());

    // Applied via the idempotent addReaction, mapping "thumbsup" → "👍", as slack:T1:U1.
    expect(state.reactionAdds).toEqual([
      { messageId: "existing_cyborg_msg", userId: "slack:T1:U1", userName: "U1", emoji: "👍" },
    ]);
    expect(state.reactionRemoves).toHaveLength(0);
    // A reaction_broadcast was injected with the synthetic author + mapped emoji.
    expect(state.injects).toHaveLength(1);
    expect(state.injects[0]!.message.type).toBe("cyborg:reaction_broadcast");
    const p = state.injects[0]!.message.payload as Record<string, unknown>;
    expect(p).toMatchObject({
      messageId: "existing_cyborg_msg",
      userId: "slack:T1:U1",
      emoji: "👍",
      action: "added",
    });
  });

  it("applies reaction_removed via removeReaction", async () => {
    const state = newState({ seenTs: new Set(["1700000000.000100"]) });
    const { pg, relay } = makeDeps(state);
    await handleInboundReaction(pg, relay, reaction({ action: "removed", reaction: "heart" }));
    expect(state.reactionRemoves).toEqual([
      { messageId: "existing_cyborg_msg", userId: "slack:T1:U1", emoji: "❤️" },
    ]);
    expect(state.reactionAdds).toHaveLength(0);
    const p = state.injects[0]!.message.payload as Record<string, unknown>;
    expect(p).toMatchObject({ emoji: "❤️", action: "removed" });
  });

  it("drops our OWN bot's reaction (identity echo guard)", async () => {
    const state = newState({ install: INSTALL_WITH_BOT, seenTs: new Set(["1700000000.000100"]) });
    const { pg, relay } = makeDeps(state);
    await handleInboundReaction(pg, relay, reaction({ userId: "UBOT" }));
    expect(state.reactionAdds).toHaveLength(0);
    expect(state.injects).toHaveLength(0);
  });

  it("drops the echo of our OWN outbound reaction (reaction marker, alias-proof)", async () => {
    const state = newState({ seenTs: new Set(["1700000000.000100"]) });
    const { pg, relay } = makeDeps(state);
    // We just applied 👍 added on this ts outbound; Slack echoes it back as "+1".
    markPostedReaction("1700000000.000100", "👍", "added");
    await handleInboundReaction(pg, relay, reaction({ reaction: "+1" }));
    expect(state.reactionAdds).toHaveLength(0);
    expect(state.injects).toHaveLength(0);
  });

  it("no-ops for a custom / uncurated emoji (no Cyborg key)", async () => {
    const state = newState({ seenTs: new Set(["1700000000.000100"]) });
    const { pg, relay } = makeDeps(state);
    await handleInboundReaction(pg, relay, reaction({ reaction: "party_blob_custom" }));
    expect(state.reactionAdds).toHaveLength(0);
    expect(state.injects).toHaveLength(0);
  });

  it("no-ops when the reacted-to message was never mirrored (no mapping)", async () => {
    // No seenTs → getMessageIntegrationByExternal returns null.
    const state = newState();
    const { pg, relay } = makeDeps(state);
    await handleInboundReaction(pg, relay, reaction());
    expect(state.reactionAdds).toHaveLength(0);
    expect(state.injects).toHaveLength(0);
  });

  it("does not broadcast when the reaction was already in the target state (idempotent)", async () => {
    const state = newState({ seenTs: new Set(["1700000000.000100"]), reactionChanged: false });
    const { pg, relay } = makeDeps(state);
    await handleInboundReaction(pg, relay, reaction());
    // addReaction was attempted but reported no change → no broadcast.
    expect(state.reactionAdds).toHaveLength(1);
    expect(state.injects).toHaveLength(0);
  });

  it("skips a channel that isn't Slack-linked", async () => {
    const state = newState({ link: null });
    const { pg, relay } = makeDeps(state);
    await handleInboundReaction(pg, relay, reaction());
    expect(state.reactionAdds).toHaveLength(0);
    expect(state.injects).toHaveLength(0);
  });

  it("skips an outbound-only link (no Slack→Cyborg mirroring)", async () => {
    const state = newState({
      link: { ...LINK, syncDirection: "outbound" },
      seenTs: new Set(["1700000000.000100"]),
    });
    const { pg, relay } = makeDeps(state);
    await handleInboundReaction(pg, relay, reaction());
    expect(state.reactionAdds).toHaveLength(0);
    expect(state.injects).toHaveLength(0);
  });
});

// A working fake S3 client so the REAL uploadBufferToS3 succeeds for an inline-safe type
// (image/png). send() resolves; rehostSlackFile then returns the persisted attachment.
function fakeS3Client(): NonNullable<SlackRoutesDeps["s3Client"]> {
  return {
    async send() {
      return {};
    },
  } as unknown as NonNullable<SlackRoutesDeps["s3Client"]>;
}

describe("reverse lookup is tenant-scoped — a foreign-workspace ts does not resolve", () => {
  it("inbound EDIT whose ts exists only under a DIFFERENT workspace: no update, no inject, scoped to link.workspaceId", async () => {
    // The ts is recorded under "ws_other", but the link lives in "ws_1". The reverse
    // lookup must query ws_1 (no row there) → an edit of a message we never mirrored.
    const state = newState({
      seenTsByWorkspace: new Map([["ws_other", new Set(["1700000000.000100"])]]),
    });
    const { pg, relay, deps } = makeDeps(state);
    await handleInboundMessage(
      pg,
      relay,
      deps,
      inbound({ kind: "message_changed", ts: "1700000000.000100", text: "edited body" }),
    );
    expect(state.textUpdates).toHaveLength(0);
    expect(state.injects).toHaveLength(0);
    // The resolver was queried with the LINK's workspace ("ws_1"), NOT the foreign one.
    expect(state.msgIntegrationLookups).toEqual([
      { provider: "slack", externalId: "1700000000.000100", workspaceId: "ws_1" },
    ]);
  });

  it("inbound REACTION whose ts exists only under a DIFFERENT workspace: no apply, no inject, scoped to link.workspaceId", async () => {
    const state = newState({
      seenTsByWorkspace: new Map([["ws_other", new Set(["1700000000.000100"])]]),
    });
    const { pg, relay } = makeDeps(state);
    await handleInboundReaction(pg, relay, reaction());
    expect(state.reactionAdds).toHaveLength(0);
    expect(state.injects).toHaveLength(0);
    expect(state.msgIntegrationLookups).toEqual([
      { provider: "slack", externalId: "1700000000.000100", workspaceId: "ws_1" },
    ]);
  });
});

describe("handleInboundMessage — file attachments on the broadcast payload", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("re-hosts an inbound file and injects one attachment on the payload", async () => {
    // Cached user map so ensureSyntheticAuthor short-circuits (no resolveUser network),
    // and a token (from the install) so buildAttachments actually runs the re-host.
    const state = newState({
      install: INSTALL_WITH_BOT,
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
    const s3deps: SlackRoutesDeps = { ...deps, s3Client: fakeS3Client(), s3Bucket: "bkt" };
    const bytes = new Uint8Array([1, 2, 3, 4, 5]); // 5 actual bytes streamed
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse({ ok: true, contentLength: "5", chunks: [bytes] })),
    );

    await handleInboundMessage(pg, relay, s3deps, inbound({ files: [slackFile()] }));

    expect(state.injects).toHaveLength(1);
    const p = state.injects[0]!.message.payload as Record<string, unknown>;
    const attachments = p.attachments as {
      key: string;
      name: string;
      type: string;
      size: number;
      url: string;
    }[];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ name: "pic.png", type: "image/png", size: 5 });
    expect(attachments[0]!.key).toMatch(/^slack-files\/.+\.png$/);
  });

  it("injects attachments:null for a text-only message (no files)", async () => {
    const state = newState();
    const { pg, relay, deps } = makeDeps(state);
    await handleInboundMessage(pg, relay, deps, inbound());
    const p = state.injects[0]!.message.payload as Record<string, unknown>;
    expect(p.attachments).toBeNull();
  });
});

describe("rehostSlackFile — success path (stream → S3 → persisted attachment)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the ACTUAL streamed byte length (not Slack's advisory size) and fetches with the bot token + no redirect", async () => {
    const deps: SlackRoutesDeps = {
      pg: {} as unknown as PgSync,
      relay: {} as unknown as WorkspaceRelay,
      s3Client: fakeS3Client(),
      s3Bucket: "bkt",
      s3Region: "us-east-1",
    };
    const bytes = new Uint8Array([10, 20, 30, 40]); // 4 actual bytes
    const fetchSpy = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      fakeResponse({ ok: true, contentLength: "4", chunks: [bytes] }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    // Slack's advisory file.size (999999) is deliberately wrong — the re-host must use
    // the streamed length instead.
    const out = await rehostSlackFile(slackFile({ size: 999999 }), "xoxb-TOK", deps);

    expect(out).not.toBeNull();
    expect(out).toMatchObject({ name: "pic.png", type: "image/png", size: 4 });
    expect(out!.size).not.toBe(999999); // NOT Slack's advisory size
    expect(out!.key).toMatch(/^slack-files\/.+\.png$/);
    expect(out!.url).toContain("bkt.s3.us-east-1.amazonaws.com");

    // Fetched exactly once, from the Slack host, with the bot token and redirect:"error".
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://files.slack.com/files-pri/T1-F1/pic.png");
    expect(init!.redirect).toBe("error");
    expect(init!.headers).toMatchObject({ Authorization: "Bearer xoxb-TOK" });
  });
});

describe("handleInboundMessage — outbound-only link skips a MESSAGE", () => {
  it("does not inject or upsert for an inbound message on an outbound-only link", async () => {
    const state = newState({ link: { ...LINK, syncDirection: "outbound" } });
    const { pg, relay, deps } = makeDeps(state);
    await handleInboundMessage(pg, relay, deps, inbound());
    expect(state.injects).toHaveLength(0);
    expect(state.msgIntegrationUpserts).toHaveLength(0);
    // Returned before the reverse lookup even runs (direction gate is earliest).
    expect(state.msgIntegrationLookups).toHaveLength(0);
  });
});

describe("handleInboundMessage — same-instance echo of our OWN edit/delete (consumePostedTs)", () => {
  it("drops an inbound message_changed whose ts WE posted, even with botId null / no install", async () => {
    // A mapping EXISTS for this ts (seenTs), yet the same-instance ts marker must drop
    // the edit before the edit path — proving it works without any bot identity.
    const state = newState({ seenTs: new Set(["1700000000.000100"]) });
    const { pg, relay, deps } = makeDeps(state);
    markPostedTs("1700000000.000100");
    await handleInboundMessage(
      pg,
      relay,
      deps,
      inbound({ kind: "message_changed", ts: "1700000000.000100", text: "edited", botId: null }),
    );
    expect(state.textUpdates).toHaveLength(0);
    expect(state.injects).toHaveLength(0);
  });

  it("drops an inbound message_deleted whose ts WE posted, even with botId null / no install", async () => {
    const state = newState({ seenTs: new Set(["1700000000.000100"]) });
    const { pg, relay, deps } = makeDeps(state);
    markPostedTs("1700000000.000100");
    await handleInboundMessage(
      pg,
      relay,
      deps,
      inbound({ kind: "message_deleted", ts: "1700000000.000100", botId: null }),
    );
    expect(state.deletes).toHaveLength(0);
    expect(state.injects).toHaveLength(0);
  });
});
