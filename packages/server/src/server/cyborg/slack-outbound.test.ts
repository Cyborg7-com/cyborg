import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  markPostedTs,
  consumePostedTs,
  rememberOurBotUserId,
  isOurBotUserId,
  mirrorChannelMessageToSlack,
  _resetSlackEchoGuardForTest,
  type OutboundChannelMessage,
  type SlackPoster,
} from "./slack-outbound.js";
import type {
  PgSync,
  StoredSlackChannelLink,
  StoredIntegrationInstallation,
} from "./db/pg-sync.js";
import type { PostMessageArgs } from "./integrations/types.js";

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
