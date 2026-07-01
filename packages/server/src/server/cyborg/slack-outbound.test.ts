import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  markPostedTs,
  consumePostedTs,
  consumePostedReaction,
  rememberOurBotUserId,
  isOurBotUserId,
  mirrorChannelMessageToSlack,
  mirrorEditToSlack,
  mirrorDeleteToSlack,
  mirrorReactionToSlack,
  resolveSenderIdentity,
  isPrivateAddress,
  isSafePublicUrl,
  _resetSlackEchoGuardForTest,
  type OutboundChannelMessage,
  type SlackPoster,
  type SlackEditor,
  type SlackDeleter,
  type SlackReactor,
  type SlackFileUploader,
} from "./slack-outbound.js";
import { MAX_ATTACHMENT_BYTES } from "./routes/assets.js";
import type {
  PgSync,
  StoredSlackChannelLink,
  StoredIntegrationInstallation,
} from "./db/pg-sync.js";
import type {
  PostMessageArgs,
  ReactionArgs,
  UpdateMessageArgs,
  UploadFileArgs,
  DeleteMessageArgs,
} from "./integrations/types.js";

// Mock node:dns/promises so isSafePublicUrl's DNS-resolution branch (a HOSTNAME url that
// must be resolved before the private-address check) is deterministic offline. The
// existing SSRF tests all use IP-LITERAL urls, so net.isIP() short-circuits before
// `lookup` and this mock never affects them.
const { mockDnsLookup } = vi.hoisted(() => ({ mockDnsLookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mockDnsLookup }));

beforeEach(() => _resetSlackEchoGuardForTest());

// ── echo guard (the two-sided loop breaker) ──

describe("echo guard — markPostedTs / consumePostedTs", () => {
  it("a ts WE posted is consumed exactly once (one outbound suppresses one inbound echo)", () => {
    markPostedTs("1700000000.000100");
    expect(consumePostedTs("1700000000.000100")).toBe(true);
    expect(consumePostedTs("1700000000.000100")).toBe(false);
  });

  it("an unknown ts is never treated as an echo", () => {
    expect(consumePostedTs("9999999999.999999")).toBe(false);
  });

  it("an expired marker is not a live echo (TTL window)", () => {
    const now = 1_000_000;
    markPostedTs("t.s", now);
    // 61s later (> 60s TTL) → the marker is stale.
    expect(consumePostedTs("t.s", now + 61_000)).toBe(false);
  });

  it("remembers our bot user id for the identity-based inbound guard", () => {
    expect(isOurBotUserId("UBOT")).toBe(false);
    rememberOurBotUserId("UBOT");
    expect(isOurBotUserId("UBOT")).toBe(true);
    expect(isOurBotUserId(null)).toBe(false);
  });
});

// ── mirrorChannelMessageToSlack (over a fake pg + injected poster) ──

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

const INSTALL: StoredIntegrationInstallation = {
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

interface FakePgState {
  link?: StoredSlackChannelLink | null;
  install?: StoredIntegrationInstallation | null;
  // messageId -> external (Slack) ts, for getMessageIntegrationByMessageId.
  mappingsByMessageId?: Record<string, string>;
  upserts: {
    messageId: string;
    externalId: string;
    externalThreadId: string | null;
  }[];
  // Fake user returned by getUserById (null = not found).
  user?: { id: string; email: string; name: string | null; imageUrl: string | null } | null;
  // Fake cybo returned by getCyboById (null = not found).
  cybo?: { name: string | null; avatar: string | null } | null;
}

function makePg(state: FakePgState): PgSync {
  // Models the message_integrations PK: a row exists either because it was pre-mapped
  // (mappingsByMessageId) or because it was just claimed. claimMessageIntegration's body
  // runs synchronously up to its return (no internal await), modeling the DB's atomic
  // INSERT … ON CONFLICT (message_id) DO NOTHING — so two interleaved mirror calls see a
  // single winner.
  const claimed = new Set<string>(Object.keys(state.mappingsByMessageId ?? {}));
  return {
    async getSlackChannelLinkByCyborgChannel() {
      return state.link === undefined ? LINK : state.link;
    },
    async getIntegrationInstallationById() {
      return state.install === undefined ? INSTALL : state.install;
    },
    claimMessageIntegration(opts: { messageId: string }) {
      if (claimed.has(opts.messageId)) return Promise.resolve(false);
      claimed.add(opts.messageId);
      return Promise.resolve(true);
    },
    async deleteMessageIntegration(messageId: string) {
      claimed.delete(messageId);
      if (state.mappingsByMessageId) delete state.mappingsByMessageId[messageId];
    },
    async getMessageIntegrationByMessageId(messageId: string) {
      const ext = state.mappingsByMessageId?.[messageId];
      return ext
        ? {
            messageId,
            workspaceId: "ws_1",
            provider: "slack",
            externalId: ext,
            externalThreadId: null,
            createdAt: 0,
          }
        : null;
    },
    async getUserById(_id: string) {
      return state.user === undefined ? null : state.user;
    },
    async getCyboById(_id: string) {
      if (!state.cybo) return null;
      // Minimal shape — resolveSenderIdentity only reads name + avatar.
      return state.cybo as unknown as NonNullable<Awaited<ReturnType<PgSync["getCyboById"]>>>;
    },
    async upsertMessageIntegration(opts: {
      messageId: string;
      externalId: string;
      externalThreadId?: string | null;
    }) {
      state.upserts.push({
        messageId: opts.messageId,
        externalId: opts.externalId,
        externalThreadId: opts.externalThreadId ?? null,
      });
    },
  } as unknown as PgSync;
}

function recordingPoster(ts = "1700000000.000200"): {
  poster: SlackPoster;
  calls: { token: string; args: PostMessageArgs }[];
} {
  const calls: { token: string; args: PostMessageArgs }[] = [];
  return {
    calls,
    poster: {
      async postMessage(token: string, args: PostMessageArgs) {
        calls.push({ token, args });
        return { ts };
      },
    },
  };
}

function msg(over: Partial<OutboundChannelMessage> = {}): OutboundChannelMessage {
  return {
    workspaceId: "ws_1",
    cyborgChannelId: "ch_cyborg",
    messageId: "m_1",
    fromId: "user_human",
    fromType: "human",
    text: "hello slack",
    parentId: null,
    ...over,
  };
}

describe("mirrorChannelMessageToSlack — gating + echo guard", () => {
  beforeEach(() => {
    process.env.SLACK_CLIENT_ID = "cid";
    process.env.SLACK_CLIENT_SECRET = "csecret";
    process.env.SLACK_SIGNING_SECRET = "ssecret";
    process.env.SLACK_APP_ID = "A1";
  });
  afterEach(() => {
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_APP_ID;
  });

  it("never re-posts a `slack:` synthetic author (the inbound-echo guard)", async () => {
    const { poster, calls } = recordingPoster();
    const pg = makePg({ upserts: [] });
    expect(await mirrorChannelMessageToSlack(pg, msg({ fromId: "slack:T1:U9" }), poster)).toBe(
      "synthetic-author",
    );
    expect(calls).toHaveLength(0);
  });

  it("skips a system message", async () => {
    const { poster, calls } = recordingPoster();
    expect(
      await mirrorChannelMessageToSlack(
        makePg({ upserts: [] }),
        msg({ fromType: "system" }),
        poster,
      ),
    ).toBe("system-author");
    expect(calls).toHaveLength(0);
  });

  it("skips an empty body (Slack rejects it)", async () => {
    const { poster } = recordingPoster();
    expect(
      await mirrorChannelMessageToSlack(makePg({ upserts: [] }), msg({ text: "   " }), poster),
    ).toBe("empty-text");
  });

  it("is inert when Slack isn't configured", async () => {
    delete process.env.SLACK_CLIENT_ID;
    const { poster, calls } = recordingPoster();
    expect(await mirrorChannelMessageToSlack(makePg({ upserts: [] }), msg(), poster)).toBe(
      "not-configured",
    );
    expect(calls).toHaveLength(0);
  });

  it("skips a channel with no Slack link", async () => {
    const { poster } = recordingPoster();
    expect(
      await mirrorChannelMessageToSlack(makePg({ link: null, upserts: [] }), msg(), poster),
    ).toBe("no-link");
  });

  it("does not write back on an inbound-only link", async () => {
    const { poster, calls } = recordingPoster();
    const pg = makePg({ link: { ...LINK, syncDirection: "inbound" }, upserts: [] });
    expect(await mirrorChannelMessageToSlack(pg, msg(), poster)).toBe("inbound-only");
    expect(calls).toHaveLength(0);
  });

  it("skips an installation with no bot token", async () => {
    const { poster } = recordingPoster();
    const pg = makePg({ install: { ...INSTALL, accessToken: null }, upserts: [] });
    expect(await mirrorChannelMessageToSlack(pg, msg(), poster)).toBe("no-token");
  });

  it("is idempotent — a message already mapped is never double-posted", async () => {
    const { poster, calls } = recordingPoster();
    const pg = makePg({ mappingsByMessageId: { m_1: "1700000000.000050" }, upserts: [] });
    expect(await mirrorChannelMessageToSlack(pg, msg(), poster)).toBe("already-mirrored");
    expect(calls).toHaveLength(0);
  });

  it("two concurrent re-broadcasts of the SAME message post EXACTLY once (atomic claim)", async () => {
    const { poster, calls } = recordingPoster("1700000000.000321");
    const pg = makePg({ upserts: [] });
    const outcomes = await Promise.all([
      mirrorChannelMessageToSlack(pg, msg(), poster),
      mirrorChannelMessageToSlack(pg, msg(), poster),
    ]);
    // exactly one wins the claim + posts; the other is dropped without a network post.
    expect(outcomes.filter((o) => o === "posted")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "already-mirrored")).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("releases the claim when the post fails, so a retry can re-mirror", async () => {
    const failing: SlackPoster = {
      async postMessage() {
        throw new Error("network down");
      },
    };
    const pg = makePg({ upserts: [] });
    await expect(mirrorChannelMessageToSlack(pg, msg(), failing)).rejects.toThrow("network down");
    // claim released → a retry with a working poster now actually posts.
    const { poster, calls } = recordingPoster("1700000000.000555");
    expect(await mirrorChannelMessageToSlack(pg, msg(), poster)).toBe("posted");
    expect(calls).toHaveLength(1);
  });

  it("when BOTH the post AND the claim-release fail, throws the ORIGINAL post error and logs the release failure", async () => {
    const failing: SlackPoster = {
      async postMessage() {
        throw new Error("network down");
      },
    };
    // A pg whose deleteMessageIntegration ALSO throws (a second DB failure). The release
    // error must NOT mask or replace the original post error.
    const pg = makePg({ upserts: [] });
    const releaseError = new Error("db connection lost");
    (pg as unknown as { deleteMessageIntegration: () => Promise<void> }).deleteMessageIntegration =
      () => Promise.reject(releaseError);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The propagated error is the ORIGINAL post failure, never the release failure.
      await expect(mirrorChannelMessageToSlack(pg, msg(), failing)).rejects.toThrow("network down");
      // …and the release failure was surfaced (logged), not silently swallowed.
      expect(errorSpy).toHaveBeenCalledWith(
        "[slack] failed to release outbound claim after post failure",
        expect.objectContaining({ err: releaseError, messageId: "m_1" }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("mirrorChannelMessageToSlack — the post + records", () => {
  beforeEach(() => {
    process.env.SLACK_CLIENT_ID = "cid";
    process.env.SLACK_CLIENT_SECRET = "csecret";
    process.env.SLACK_SIGNING_SECRET = "ssecret";
    process.env.SLACK_APP_ID = "A1";
  });
  afterEach(() => {
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_APP_ID;
  });

  it("posts to the linked Slack channel, marks the ts echo guard, and records the mapping", async () => {
    const { poster, calls } = recordingPoster("1700000000.000777");
    const state: FakePgState = { upserts: [] };
    expect(await mirrorChannelMessageToSlack(makePg(state), msg(), poster)).toBe("posted");
    // posted to the Slack channel id (not the Cyborg one), with the body, no thread.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      token: "xoxb-token",
      args: { channelId: "C_SLACK", text: "hello slack" },
    });
    // recorded the Cyborg-message ↔ Slack-ts back-link.
    expect(state.upserts).toEqual([
      { messageId: "m_1", externalId: "1700000000.000777", externalThreadId: null },
    ]);
    // the posted ts is now an echo guard entry (inbound will drop the bot's own event)…
    expect(consumePostedTs("1700000000.000777")).toBe(true);
    // …and the bot user-id was remembered for the identity guard.
    expect(isOurBotUserId("UBOT")).toBe(true);
  });

  it("threads a reply under the parent's mapped Slack ts", async () => {
    const { poster, calls } = recordingPoster("1700000000.000999");
    const state: FakePgState = {
      mappingsByMessageId: { parent_m: "1700000000.000111" }, // the parent's Slack ts
      upserts: [],
    };
    const outcome = await mirrorChannelMessageToSlack(
      makePg(state),
      msg({ messageId: "child_m", parentId: "parent_m" }),
      poster,
    );
    expect(outcome).toBe("posted");
    expect(calls[0]?.args).toEqual({
      channelId: "C_SLACK",
      text: "hello slack",
      threadTs: "1700000000.000111",
    });
    expect(state.upserts[0]).toEqual({
      messageId: "child_m",
      externalId: "1700000000.000999",
      externalThreadId: "1700000000.000111",
    });
  });
});

// ── per-sender identity (resolveSenderIdentity + mirrorChannelMessageToSlack integration) ──

const INSTALL_WITH_CUSTOMIZE: StoredIntegrationInstallation = {
  ...INSTALL,
  scopes: "chat:write,chat:write.customize",
};

describe("resolveSenderIdentity — unit", () => {
  it("returns {} when scopes is null (gate off)", async () => {
    const pg = makePg({
      upserts: [],
      user: { id: "u1", email: "a@b.com", name: "Ada", imageUrl: "https://slack/ada.png" },
    });
    const result = await resolveSenderIdentity(pg, msg({ fromType: "human", fromId: "u1" }), null);
    expect(result).toEqual({});
  });

  it("returns {} when chat:write.customize is absent from scopes", async () => {
    const pg = makePg({
      upserts: [],
      user: { id: "u1", email: "a@b.com", name: "Ada", imageUrl: "https://slack/ada.png" },
    });
    const result = await resolveSenderIdentity(
      pg,
      msg({ fromType: "human", fromId: "u1" }),
      "chat:write",
    );
    expect(result).toEqual({});
  });

  it("resolves human name + http avatar when customize scope present", async () => {
    const pg = makePg({
      upserts: [],
      user: { id: "u1", email: "a@b.com", name: "Ada", imageUrl: "https://slack/ada.png" },
    });
    const result = await resolveSenderIdentity(
      pg,
      msg({ fromType: "human", fromId: "u1", fromName: "Ada" }),
      "chat:write,chat:write.customize",
    );
    expect(result).toEqual({ username: "Ada", iconUrl: "https://slack/ada.png" });
  });

  it("omits iconUrl when avatar is an emoji (not http)", async () => {
    const pg = makePg({ upserts: [], cybo: { name: "Rick", avatar: "🤖" } });
    const result = await resolveSenderIdentity(
      pg,
      msg({ fromType: "agent", fromId: "cyb_1", fromName: "Rick" }),
      "chat:write,chat:write.customize",
    );
    expect(result).toEqual({ username: "Rick" });
    expect(result).not.toHaveProperty("iconUrl");
  });

  it("returns {} on lookup error (never throws)", async () => {
    const pg = makePg({ upserts: [] });
    (pg as unknown as { getUserById: () => Promise<never> }).getUserById = () =>
      Promise.reject(new Error("db down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await resolveSenderIdentity(
        pg,
        msg({ fromType: "human", fromId: "u1", fromName: "Ada" }),
        "chat:write,chat:write.customize",
      );
      expect(result).toEqual({});
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("mirrorChannelMessageToSlack — per-sender identity", () => {
  beforeEach(() => {
    process.env.SLACK_CLIENT_ID = "cid";
    process.env.SLACK_CLIENT_SECRET = "csecret";
    process.env.SLACK_SIGNING_SECRET = "ssecret";
    process.env.SLACK_APP_ID = "A1";
  });
  afterEach(() => {
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_APP_ID;
  });

  it("posts with username + iconUrl for a human sender when chat:write.customize is in scope", async () => {
    const { poster, calls } = recordingPoster();
    const state: FakePgState = {
      install: INSTALL_WITH_CUSTOMIZE,
      upserts: [],
      user: { id: "u1", email: "ada@test.com", name: "Ada", imageUrl: "https://slack/ada.png" },
    };
    const outcome = await mirrorChannelMessageToSlack(
      makePg(state),
      msg({ fromType: "human", fromId: "u1", fromName: "Ada" }),
      poster,
    );
    expect(outcome).toBe("posted");
    expect(calls[0]?.args).toEqual({
      channelId: "C_SLACK",
      text: "hello slack",
      username: "Ada",
      iconUrl: "https://slack/ada.png",
    });
  });

  it("posts with username + iconUrl for a cybo sender when chat:write.customize is in scope", async () => {
    const { poster, calls } = recordingPoster();
    const state: FakePgState = {
      install: INSTALL_WITH_CUSTOMIZE,
      upserts: [],
      cybo: { name: "Rick", avatar: "https://cdn/rick.png" },
    };
    const outcome = await mirrorChannelMessageToSlack(
      makePg(state),
      msg({ fromType: "agent", fromId: "cyb_1", fromName: "Rick" }),
      poster,
    );
    expect(outcome).toBe("posted");
    expect(calls[0]?.args).toEqual({
      channelId: "C_SLACK",
      text: "hello slack",
      username: "Rick",
      iconUrl: "https://cdn/rick.png",
    });
  });

  it("posts with username but no iconUrl when cybo avatar is an emoji", async () => {
    const { poster, calls } = recordingPoster();
    const state: FakePgState = {
      install: INSTALL_WITH_CUSTOMIZE,
      upserts: [],
      cybo: { name: "Rick", avatar: "🤖" },
    };
    await mirrorChannelMessageToSlack(
      makePg(state),
      msg({ fromType: "agent", fromId: "cyb_1", fromName: "Rick" }),
      poster,
    );
    expect(calls[0]?.args).toMatchObject({ username: "Rick" });
    expect(calls[0]?.args).not.toHaveProperty("iconUrl");
  });

  it("posts WITHOUT username/iconUrl when chat:write.customize is absent (scope gate)", async () => {
    const { poster, calls } = recordingPoster();
    const state: FakePgState = {
      install: { ...INSTALL, scopes: "chat:write" },
      upserts: [],
      user: { id: "u1", email: "ada@test.com", name: "Ada", imageUrl: "https://slack/ada.png" },
    };
    await mirrorChannelMessageToSlack(
      makePg(state),
      msg({ fromType: "human", fromId: "u1", fromName: "Ada" }),
      poster,
    );
    expect(calls[0]?.args).not.toHaveProperty("username");
    expect(calls[0]?.args).not.toHaveProperty("iconUrl");
  });

  it("posts WITHOUT username/iconUrl when getUserById returns null and no fromName (fallback)", async () => {
    const { poster, calls } = recordingPoster();
    const state: FakePgState = {
      install: INSTALL_WITH_CUSTOMIZE,
      upserts: [],
      user: null,
    };
    await mirrorChannelMessageToSlack(
      makePg(state),
      msg({ fromType: "human", fromId: "u1" }),
      poster,
    );
    expect(calls[0]?.args).not.toHaveProperty("username");
    expect(calls[0]?.args).not.toHaveProperty("iconUrl");
  });
});

// ── mirrorEditToSlack / mirrorDeleteToSlack (WAVE 2.1) ───────────────────────

function recordingEditor(): {
  editor: SlackEditor;
  calls: { token: string; args: UpdateMessageArgs }[];
} {
  const calls: { token: string; args: UpdateMessageArgs }[] = [];
  return {
    calls,
    editor: {
      async updateMessage(token: string, args: UpdateMessageArgs) {
        calls.push({ token, args });
      },
    },
  };
}

function recordingDeleter(): {
  deleter: SlackDeleter;
  calls: { token: string; args: DeleteMessageArgs }[];
} {
  const calls: { token: string; args: DeleteMessageArgs }[] = [];
  return {
    calls,
    deleter: {
      async deleteMessage(token: string, args: DeleteMessageArgs) {
        calls.push({ token, args });
      },
    },
  };
}

describe("mirrorEditToSlack — gating + echo guard", () => {
  beforeEach(() => {
    process.env.SLACK_CLIENT_ID = "cid";
    process.env.SLACK_CLIENT_SECRET = "csecret";
    process.env.SLACK_SIGNING_SECRET = "ssecret";
    process.env.SLACK_APP_ID = "A1";
  });
  afterEach(() => {
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_APP_ID;
  });

  it("calls editor.updateMessage, returns 'updated', arms the echo guard", async () => {
    const { editor, calls } = recordingEditor();
    const state: FakePgState = {
      mappingsByMessageId: { m_1: "1700000000.000111" },
      upserts: [],
    };
    const outcome = await mirrorEditToSlack(
      makePg(state),
      { workspaceId: "ws_1", cyborgChannelId: "ch_cyborg", messageId: "m_1", text: "edited" },
      editor,
    );
    expect(outcome).toBe("updated");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      token: "xoxb-token",
      args: { channelId: "C_SLACK", ts: "1700000000.000111", text: "edited" },
    });
    // Echo guard: the ts is now marked so the inbound message_changed echo is suppressed.
    expect(consumePostedTs("1700000000.000111")).toBe(true);
    // Bot user-id is remembered for the identity-based inbound guard.
    expect(isOurBotUserId("UBOT")).toBe(true);
  });

  it("returns 'not-mirrored' when the message has no mapping", async () => {
    const { editor, calls } = recordingEditor();
    const outcome = await mirrorEditToSlack(
      makePg({ upserts: [] }),
      { workspaceId: "ws_1", cyborgChannelId: "ch_cyborg", messageId: "m_unknown", text: "x" },
      editor,
    );
    expect(outcome).toBe("not-mirrored");
    expect(calls).toHaveLength(0);
  });

  it("returns 'inbound-only' for an inbound-only link without calling the editor", async () => {
    const { editor, calls } = recordingEditor();
    const state: FakePgState = {
      link: { ...LINK, syncDirection: "inbound" },
      mappingsByMessageId: { m_1: "1700000000.000111" },
      upserts: [],
    };
    const outcome = await mirrorEditToSlack(
      makePg(state),
      { workspaceId: "ws_1", cyborgChannelId: "ch_cyborg", messageId: "m_1", text: "x" },
      editor,
    );
    expect(outcome).toBe("inbound-only");
    expect(calls).toHaveLength(0);
  });

  it("returns 'empty-text' without calling the editor when text is blank", async () => {
    const { editor, calls } = recordingEditor();
    const outcome = await mirrorEditToSlack(
      makePg({ upserts: [] }),
      { workspaceId: "ws_1", cyborgChannelId: "ch_cyborg", messageId: "m_1", text: "   " },
      editor,
    );
    expect(outcome).toBe("empty-text");
    expect(calls).toHaveLength(0);
  });

  it("returns 'not-configured' when Slack secrets are absent, without calling the editor", async () => {
    delete process.env.SLACK_CLIENT_ID;
    const { editor, calls } = recordingEditor();
    const state: FakePgState = { mappingsByMessageId: { m_1: "1700000000.000111" }, upserts: [] };
    const outcome = await mirrorEditToSlack(
      makePg(state),
      { workspaceId: "ws_1", cyborgChannelId: "ch_cyborg", messageId: "m_1", text: "edited" },
      editor,
    );
    expect(outcome).toBe("not-configured");
    expect(calls).toHaveLength(0);
  });

  it("returns 'pending' for a still-pending mapping, without calling the editor", async () => {
    const { editor, calls } = recordingEditor();
    const state: FakePgState = { mappingsByMessageId: { m_1: "pending:m_1" }, upserts: [] };
    const outcome = await mirrorEditToSlack(
      makePg(state),
      { workspaceId: "ws_1", cyborgChannelId: "ch_cyborg", messageId: "m_1", text: "edited" },
      editor,
    );
    expect(outcome).toBe("pending");
    expect(calls).toHaveLength(0);
  });

  it("returns 'no-link' when the channel has no Slack link, without calling the editor", async () => {
    const { editor, calls } = recordingEditor();
    const state: FakePgState = {
      link: null,
      mappingsByMessageId: { m_1: "1700000000.000111" },
      upserts: [],
    };
    const outcome = await mirrorEditToSlack(
      makePg(state),
      { workspaceId: "ws_1", cyborgChannelId: "ch_cyborg", messageId: "m_1", text: "edited" },
      editor,
    );
    expect(outcome).toBe("no-link");
    expect(calls).toHaveLength(0);
  });

  it("returns 'no-token' when the installation has no bot token, without calling the editor", async () => {
    const { editor, calls } = recordingEditor();
    const state: FakePgState = {
      install: { ...INSTALL, accessToken: null },
      mappingsByMessageId: { m_1: "1700000000.000111" },
      upserts: [],
    };
    const outcome = await mirrorEditToSlack(
      makePg(state),
      { workspaceId: "ws_1", cyborgChannelId: "ch_cyborg", messageId: "m_1", text: "edited" },
      editor,
    );
    expect(outcome).toBe("no-token");
    expect(calls).toHaveLength(0);
  });
});

describe("mirrorDeleteToSlack — gating + echo guard", () => {
  beforeEach(() => {
    process.env.SLACK_CLIENT_ID = "cid";
    process.env.SLACK_CLIENT_SECRET = "csecret";
    process.env.SLACK_SIGNING_SECRET = "ssecret";
    process.env.SLACK_APP_ID = "A1";
  });
  afterEach(() => {
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_APP_ID;
  });

  it("calls deleter.deleteMessage, returns 'deleted', arms the echo guard", async () => {
    const { deleter, calls } = recordingDeleter();
    const state: FakePgState = {
      mappingsByMessageId: { m_1: "1700000000.000111" },
      upserts: [],
    };
    const outcome = await mirrorDeleteToSlack(
      makePg(state),
      { workspaceId: "ws_1", cyborgChannelId: "ch_cyborg", messageId: "m_1" },
      deleter,
    );
    expect(outcome).toBe("deleted");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      token: "xoxb-token",
      args: { channelId: "C_SLACK", ts: "1700000000.000111" },
    });
    // Echo guard armed so the inbound message_deleted echo is suppressed.
    expect(consumePostedTs("1700000000.000111")).toBe(true);
    expect(isOurBotUserId("UBOT")).toBe(true);
  });

  it("returns 'not-mirrored' when the message has no mapping", async () => {
    const { deleter, calls } = recordingDeleter();
    const outcome = await mirrorDeleteToSlack(
      makePg({ upserts: [] }),
      { workspaceId: "ws_1", cyborgChannelId: "ch_cyborg", messageId: "m_unknown" },
      deleter,
    );
    expect(outcome).toBe("not-mirrored");
    expect(calls).toHaveLength(0);
  });

  it("returns 'not-configured' when Slack secrets are absent, without calling the deleter", async () => {
    delete process.env.SLACK_CLIENT_ID;
    const { deleter, calls } = recordingDeleter();
    const state: FakePgState = { mappingsByMessageId: { m_1: "1700000000.000111" }, upserts: [] };
    const outcome = await mirrorDeleteToSlack(
      makePg(state),
      { workspaceId: "ws_1", cyborgChannelId: "ch_cyborg", messageId: "m_1" },
      deleter,
    );
    expect(outcome).toBe("not-configured");
    expect(calls).toHaveLength(0);
  });

  it("returns 'pending' for a still-pending mapping, without calling the deleter", async () => {
    const { deleter, calls } = recordingDeleter();
    const state: FakePgState = { mappingsByMessageId: { m_1: "pending:m_1" }, upserts: [] };
    const outcome = await mirrorDeleteToSlack(
      makePg(state),
      { workspaceId: "ws_1", cyborgChannelId: "ch_cyborg", messageId: "m_1" },
      deleter,
    );
    expect(outcome).toBe("pending");
    expect(calls).toHaveLength(0);
  });

  it("returns 'no-link' when the channel has no Slack link, without calling the deleter", async () => {
    const { deleter, calls } = recordingDeleter();
    const state: FakePgState = {
      link: null,
      mappingsByMessageId: { m_1: "1700000000.000111" },
      upserts: [],
    };
    const outcome = await mirrorDeleteToSlack(
      makePg(state),
      { workspaceId: "ws_1", cyborgChannelId: "ch_cyborg", messageId: "m_1" },
      deleter,
    );
    expect(outcome).toBe("no-link");
    expect(calls).toHaveLength(0);
  });

  it("returns 'inbound-only' for an inbound-only link, without calling the deleter", async () => {
    const { deleter, calls } = recordingDeleter();
    const state: FakePgState = {
      link: { ...LINK, syncDirection: "inbound" },
      mappingsByMessageId: { m_1: "1700000000.000111" },
      upserts: [],
    };
    const outcome = await mirrorDeleteToSlack(
      makePg(state),
      { workspaceId: "ws_1", cyborgChannelId: "ch_cyborg", messageId: "m_1" },
      deleter,
    );
    expect(outcome).toBe("inbound-only");
    expect(calls).toHaveLength(0);
  });

  it("returns 'no-token' when the installation has no bot token, without calling the deleter", async () => {
    const { deleter, calls } = recordingDeleter();
    const state: FakePgState = {
      install: { ...INSTALL, accessToken: null },
      mappingsByMessageId: { m_1: "1700000000.000111" },
      upserts: [],
    };
    const outcome = await mirrorDeleteToSlack(
      makePg(state),
      { workspaceId: "ws_1", cyborgChannelId: "ch_cyborg", messageId: "m_1" },
      deleter,
    );
    expect(outcome).toBe("no-token");
    expect(calls).toHaveLength(0);
  });
});

// ── mirrorReactionToSlack (Cyborg → Slack reaction sync + echo guard) ─────────

function recordingReactor(): {
  reactor: SlackReactor;
  adds: { token: string; args: ReactionArgs }[];
  removes: { token: string; args: ReactionArgs }[];
} {
  const adds: { token: string; args: ReactionArgs }[] = [];
  const removes: { token: string; args: ReactionArgs }[] = [];
  return {
    adds,
    removes,
    reactor: {
      async addReaction(token: string, args: ReactionArgs) {
        adds.push({ token, args });
      },
      async removeReaction(token: string, args: ReactionArgs) {
        removes.push({ token, args });
      },
    },
  };
}

describe("mirrorReactionToSlack — gating + echo guard", () => {
  beforeEach(() => {
    process.env.SLACK_CLIENT_ID = "cid";
    process.env.SLACK_CLIENT_SECRET = "csecret";
    process.env.SLACK_SIGNING_SECRET = "ssecret";
    process.env.SLACK_APP_ID = "A1";
  });
  afterEach(() => {
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_APP_ID;
  });

  it("adds the mapped reaction on Slack, arms the echo guard (keyed by emoji)", async () => {
    const { reactor, adds, removes } = recordingReactor();
    const pg = makePg({ mappingsByMessageId: { m_1: "1700000000.000111" }, upserts: [] });
    const outcome = await mirrorReactionToSlack(
      pg,
      {
        workspaceId: "ws_1",
        cyborgChannelId: "ch_cyborg",
        messageId: "m_1",
        emoji: "👍",
        action: "added",
      },
      reactor,
    );
    expect(outcome).toBe("added");
    expect(removes).toHaveLength(0);
    // Slack name is resolved from the Unicode emoji ("👍" → "+1").
    expect(adds).toEqual([
      { token: "xoxb-token", args: { channelId: "C_SLACK", ts: "1700000000.000111", name: "+1" } },
    ]);
    // Echo guard armed, keyed by the CYBORG emoji + ts + direction (alias-proof).
    expect(consumePostedReaction("1700000000.000111", "👍", "added")).toBe(true);
    expect(isOurBotUserId("UBOT")).toBe(true);
  });

  it("removes the mapped reaction on Slack and arms the removed-direction guard", async () => {
    const { reactor, adds, removes } = recordingReactor();
    const pg = makePg({ mappingsByMessageId: { m_1: "1700000000.000111" }, upserts: [] });
    const outcome = await mirrorReactionToSlack(
      pg,
      {
        workspaceId: "ws_1",
        cyborgChannelId: "ch_cyborg",
        messageId: "m_1",
        emoji: "❤️",
        action: "removed",
      },
      reactor,
    );
    expect(outcome).toBe("removed");
    expect(adds).toHaveLength(0);
    expect(removes).toEqual([
      {
        token: "xoxb-token",
        args: { channelId: "C_SLACK", ts: "1700000000.000111", name: "heart" },
      },
    ]);
    expect(consumePostedReaction("1700000000.000111", "❤️", "removed")).toBe(true);
  });

  it("no-ops 'not-mirrored' when the Cyborg message has no Slack mapping", async () => {
    const { reactor, adds } = recordingReactor();
    const outcome = await mirrorReactionToSlack(
      makePg({ upserts: [] }),
      {
        workspaceId: "ws_1",
        cyborgChannelId: "ch_cyborg",
        messageId: "m_x",
        emoji: "👍",
        action: "added",
      },
      reactor,
    );
    expect(outcome).toBe("not-mirrored");
    expect(adds).toHaveLength(0);
  });

  it("no-ops 'pending' when the mapping is still a pending sentinel", async () => {
    const { reactor, adds } = recordingReactor();
    const pg = makePg({ mappingsByMessageId: { m_1: "pending:m_1" }, upserts: [] });
    const outcome = await mirrorReactionToSlack(
      pg,
      {
        workspaceId: "ws_1",
        cyborgChannelId: "ch_cyborg",
        messageId: "m_1",
        emoji: "👍",
        action: "added",
      },
      reactor,
    );
    expect(outcome).toBe("pending");
    expect(adds).toHaveLength(0);
  });

  it("no-ops 'unmapped-emoji' for a custom/uncurated emoji (never posts a bad name)", async () => {
    const { reactor, adds } = recordingReactor();
    const pg = makePg({ mappingsByMessageId: { m_1: "1700000000.000111" }, upserts: [] });
    const outcome = await mirrorReactionToSlack(
      pg,
      {
        workspaceId: "ws_1",
        cyborgChannelId: "ch_cyborg",
        messageId: "m_1",
        emoji: "🫥",
        action: "added",
      },
      reactor,
    );
    expect(outcome).toBe("unmapped-emoji");
    expect(adds).toHaveLength(0);
  });

  it("does not write back on an inbound-only link", async () => {
    const { reactor, adds } = recordingReactor();
    const pg = makePg({
      link: { ...LINK, syncDirection: "inbound" },
      mappingsByMessageId: { m_1: "1700000000.000111" },
      upserts: [],
    });
    const outcome = await mirrorReactionToSlack(
      pg,
      {
        workspaceId: "ws_1",
        cyborgChannelId: "ch_cyborg",
        messageId: "m_1",
        emoji: "👍",
        action: "added",
      },
      reactor,
    );
    expect(outcome).toBe("inbound-only");
    expect(adds).toHaveLength(0);
  });

  it("is inert when Slack isn't configured", async () => {
    delete process.env.SLACK_CLIENT_ID;
    const { reactor, adds } = recordingReactor();
    const pg = makePg({ mappingsByMessageId: { m_1: "1700000000.000111" }, upserts: [] });
    const outcome = await mirrorReactionToSlack(
      pg,
      {
        workspaceId: "ws_1",
        cyborgChannelId: "ch_cyborg",
        messageId: "m_1",
        emoji: "👍",
        action: "added",
      },
      reactor,
    );
    expect(outcome).toBe("not-configured");
    expect(adds).toHaveLength(0);
  });

  it("no-ops 'no-link' when the channel has no Slack link (reactor not called)", async () => {
    const { reactor, adds } = recordingReactor();
    const pg = makePg({
      link: null,
      mappingsByMessageId: { m_1: "1700000000.000111" },
      upserts: [],
    });
    const outcome = await mirrorReactionToSlack(
      pg,
      {
        workspaceId: "ws_1",
        cyborgChannelId: "ch_cyborg",
        messageId: "m_1",
        emoji: "👍",
        action: "added",
      },
      reactor,
    );
    expect(outcome).toBe("no-link");
    expect(adds).toHaveLength(0);
  });

  it("no-ops 'no-token' when the installation has no bot token (reactor not called)", async () => {
    const { reactor, adds } = recordingReactor();
    const pg = makePg({
      install: { ...INSTALL, accessToken: null },
      mappingsByMessageId: { m_1: "1700000000.000111" },
      upserts: [],
    });
    const outcome = await mirrorReactionToSlack(
      pg,
      {
        workspaceId: "ws_1",
        cyborgChannelId: "ch_cyborg",
        messageId: "m_1",
        emoji: "👍",
        action: "added",
      },
      reactor,
    );
    expect(outcome).toBe("no-token");
    expect(adds).toHaveLength(0);
  });
});

// ── outbound FILE mirror (mirrorChannelMessageToSlack attachments) ────────────

function recordingUploader(): {
  uploader: SlackFileUploader;
  calls: { token: string; args: UploadFileArgs }[];
} {
  const calls: { token: string; args: UploadFileArgs }[] = [];
  return {
    calls,
    uploader: {
      async uploadFile(token: string, args: UploadFileArgs) {
        calls.push({ token, args });
      },
    },
  };
}

// A minimal fetch Response for downloadCapped: it reads ok/headers.get(content-length)
// + body.getReader()/body.cancel(). One chunk of `bytes`.
function fakeDownload(opts: {
  ok?: boolean;
  contentLength?: string | null;
  bytes?: Uint8Array;
}): Response {
  const chunks = opts.bytes ? [opts.bytes] : [];
  let i = 0;
  const reader = {
    read: async () =>
      i < chunks.length ? { done: false, value: chunks[i++]! } : { done: true, value: undefined },
    cancel: async () => {},
  };
  return {
    ok: opts.ok ?? true,
    status: opts.ok === false ? 500 : 200,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "content-length" ? (opts.contentLength ?? null) : null,
    },
    body: { getReader: () => reader, cancel: async () => {} },
  } as unknown as Response;
}

// A literal public-IP host (RFC5737 TEST-NET-3) so the SSRF guard's net.isIP() path
// passes WITHOUT a real DNS lookup — keeps these download tests deterministic offline.
// The SSRF rejection paths (private IP, http, metadata) are covered directly in the
// downloadCapped SSRF-guard describe block below.
function attachment(over: Partial<{ url: string; name: string; type: string; size: number }> = {}) {
  return {
    url: "https://203.0.113.10/slack-out/pic.png",
    name: "pic.png",
    type: "image/png",
    size: 2048,
    ...over,
  };
}

describe("mirrorChannelMessageToSlack — outbound file attachments", () => {
  beforeEach(() => {
    process.env.SLACK_CLIENT_ID = "cid";
    process.env.SLACK_CLIENT_SECRET = "csecret";
    process.env.SLACK_SIGNING_SECRET = "ssecret";
    process.env.SLACK_APP_ID = "A1";
  });
  afterEach(() => {
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_APP_ID;
    vi.unstubAllGlobals();
  });

  it("posts the text AND uploads each attachment to the linked channel", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeDownload({ ok: true, bytes })),
    );
    const { poster, calls: posts } = recordingPoster("1700000000.000700");
    const { uploader, calls: uploads } = recordingUploader();
    const outcome = await mirrorChannelMessageToSlack(
      makePg({ upserts: [] }),
      msg({ messageId: "m_f", attachments: [attachment()] }),
      poster,
      uploader,
    );
    expect(outcome).toBe("posted");
    expect(posts).toHaveLength(1); // text still posted
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.token).toBe("xoxb-token");
    expect(uploads[0]?.args.channelId).toBe("C_SLACK");
    expect(uploads[0]?.args.filename).toBe("pic.png");
    expect(Buffer.from(uploads[0]!.args.data)).toEqual(Buffer.from(bytes));
  });

  it("uploads under the same thread_ts the threaded text used", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeDownload({ ok: true, bytes: new Uint8Array([9]) })),
    );
    const { poster } = recordingPoster("1700000000.000900");
    const { uploader, calls: uploads } = recordingUploader();
    const pg = makePg({ mappingsByMessageId: { parent_m: "1700000000.000111" }, upserts: [] });
    await mirrorChannelMessageToSlack(
      pg,
      msg({ messageId: "child_m", parentId: "parent_m", attachments: [attachment()] }),
      poster,
      uploader,
    );
    expect(uploads[0]?.args.threadTs).toBe("1700000000.000111");
  });

  it("skips an attachment whose STORED size is over the cap (no download, no upload)", async () => {
    const fetchSpy = vi.fn(async () => fakeDownload({ ok: true, bytes: new Uint8Array([1]) }));
    vi.stubGlobal("fetch", fetchSpy);
    const { poster } = recordingPoster();
    const { uploader, calls: uploads } = recordingUploader();
    await mirrorChannelMessageToSlack(
      makePg({ upserts: [] }),
      msg({ attachments: [attachment({ size: MAX_ATTACHMENT_BYTES + 1 })] }),
      poster,
      uploader,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
  });

  it("aborts an attachment whose body streams past the cap (no upload; text still posts)", async () => {
    const oversize = new Uint8Array(MAX_ATTACHMENT_BYTES + 16);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeDownload({ ok: true, contentLength: null, bytes: oversize })),
    );
    const { poster, calls: posts } = recordingPoster();
    const { uploader, calls: uploads } = recordingUploader();
    // size within the cheap pre-check so the stream cap is what trips.
    const outcome = await mirrorChannelMessageToSlack(
      makePg({ upserts: [] }),
      msg({ attachments: [attachment({ size: 1024 })] }),
      poster,
      uploader,
    );
    expect(outcome).toBe("posted");
    expect(posts).toHaveLength(1);
    expect(uploads).toHaveLength(0);
  });

  it("NEVER uploads an inbound (slack: synthetic) message's rehosted files (echo guard)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { poster } = recordingPoster();
    const { uploader, calls: uploads } = recordingUploader();
    const outcome = await mirrorChannelMessageToSlack(
      makePg({ upserts: [] }),
      msg({ fromId: "slack:T1:U9", attachments: [attachment()] }),
      poster,
      uploader,
    );
    expect(outcome).toBe("synthetic-author");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
  });

  it("attachment-only (empty text) uploads the file without a text post, no mapping fill", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeDownload({ ok: true, bytes: new Uint8Array([7]) })),
    );
    const { poster, calls: posts } = recordingPoster();
    const { uploader, calls: uploads } = recordingUploader();
    const state: FakePgState = { upserts: [] };
    const outcome = await mirrorChannelMessageToSlack(
      makePg(state),
      msg({ messageId: "m_only", text: "   ", attachments: [attachment()] }),
      poster,
      uploader,
    );
    expect(outcome).toBe("posted");
    expect(posts).toHaveLength(0); // no chat.postMessage for an empty body
    expect(uploads).toHaveLength(1);
    // claim stays pending → no real-ts mapping written (edit/delete/reaction no-op on it).
    expect(state.upserts).toHaveLength(0);
  });

  it("catches + logs + skips a file whose uploader throws, without failing the text mirror", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeDownload({ ok: true, bytes: new Uint8Array([1, 2, 3]) })),
    );
    const { poster, calls: posts } = recordingPoster("1700000000.000800");
    const throwingUploader: SlackFileUploader = {
      async uploadFile() {
        throw new Error("slack upload 500");
      },
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const outcome = await mirrorChannelMessageToSlack(
        makePg({ upserts: [] }),
        msg({ messageId: "m_upfail", attachments: [attachment()] }),
        poster,
        throwingUploader,
      );
      // The committed text mirror is never rolled back by a bad attachment.
      expect(outcome).toBe("posted");
      expect(posts).toHaveLength(1);
      // The per-file failure was logged, not thrown.
      expect(errorSpy).toHaveBeenCalledWith(
        '[slack] outbound file "pic.png" upload failed (skipped)',
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("outbound file SSRF guard", () => {
  describe("isPrivateAddress", () => {
    it("rejects the cloud metadata IP + IPv4 private/loopback/CGNAT ranges", () => {
      for (const ip of [
        "169.254.169.254", // link-local + cloud metadata
        "127.0.0.1", // loopback
        "10.0.0.5", // private
        "172.16.0.1", // private
        "172.31.255.255", // private (upper bound)
        "192.168.1.1", // private
        "100.64.0.1", // CGNAT
        "0.0.0.0", // "this host"
        "224.0.0.1", // multicast
        "240.0.0.1", // reserved
      ]) {
        expect(isPrivateAddress(ip)).toBe(true);
      }
    });

    it("rejects IPv6 loopback/ULA/link-local + IPv4-mapped metadata", () => {
      for (const ip of [
        "::1",
        "::",
        "fc00::1",
        "fd12:3456::1",
        "fe80::1",
        "::ffff:169.254.169.254",
      ]) {
        expect(isPrivateAddress(ip)).toBe(true);
      }
    });

    it("allows genuine public addresses", () => {
      for (const ip of ["8.8.8.8", "1.1.1.1", "203.0.113.10", "2606:4700:4700::1111"]) {
        expect(isPrivateAddress(ip)).toBe(false);
      }
    });

    it("rejects anything that isn't a valid IP", () => {
      expect(isPrivateAddress("not-an-ip")).toBe(true);
      expect(isPrivateAddress("")).toBe(true);
    });
  });

  describe("isSafePublicUrl", () => {
    it("rejects non-https schemes", async () => {
      expect(await isSafePublicUrl("http://203.0.113.10/x.png")).toBe(false);
      expect(await isSafePublicUrl("ftp://203.0.113.10/x.png")).toBe(false);
      expect(await isSafePublicUrl("file:///etc/passwd")).toBe(false);
    });

    it("rejects a literal private/metadata IP host (no DNS)", async () => {
      expect(await isSafePublicUrl("https://169.254.169.254/latest/meta-data/")).toBe(false);
      expect(await isSafePublicUrl("https://127.0.0.1/x")).toBe(false);
      expect(await isSafePublicUrl("https://10.0.0.1/x")).toBe(false);
      expect(await isSafePublicUrl("https://[::1]/x")).toBe(false);
      expect(await isSafePublicUrl("https://[fd00::1]/x")).toBe(false);
    });

    it("allows a literal public IP host (no DNS)", async () => {
      expect(await isSafePublicUrl("https://203.0.113.10/slack-out/pic.png")).toBe(true);
      expect(await isSafePublicUrl("https://8.8.8.8/x")).toBe(true);
    });

    it("rejects a garbage url", async () => {
      expect(await isSafePublicUrl("not a url")).toBe(false);
    });
  });

  // The DNS-rebinding branch: a HOSTNAME (not an IP literal) is resolved via dns.lookup
  // and every resolved address must be public. mockDnsLookup stands in for the resolver.
  describe("isSafePublicUrl — DNS resolution of a hostname", () => {
    beforeEach(() => mockDnsLookup.mockReset());

    it("rejects when the hostname resolves to a private address", async () => {
      mockDnsLookup.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
      expect(await isSafePublicUrl("https://assets.example.com/pic.png")).toBe(false);
    });

    it("rejects when the hostname resolves to a MIX of public + private addresses", async () => {
      mockDnsLookup.mockResolvedValue([
        { address: "8.8.8.8", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ]);
      expect(await isSafePublicUrl("https://assets.example.com/pic.png")).toBe(false);
    });

    it("rejects when the hostname resolves to nothing (empty result)", async () => {
      mockDnsLookup.mockResolvedValue([]);
      expect(await isSafePublicUrl("https://assets.example.com/pic.png")).toBe(false);
    });

    it("allows when the hostname resolves ONLY to public addresses", async () => {
      mockDnsLookup.mockResolvedValue([
        { address: "203.0.113.10", family: 4 },
        { address: "8.8.8.8", family: 4 },
      ]);
      expect(await isSafePublicUrl("https://assets.example.com/pic.png")).toBe(true);
    });
  });
});
