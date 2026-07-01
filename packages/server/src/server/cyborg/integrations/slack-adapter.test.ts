import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { slackAdapter, SLACK_PROVIDER } from "./slack-adapter.js";

// vi.hoisted creates shared state that is accessible BOTH inside the vi.mock factory
// (which runs before imports) AND in the test body. This is the reliable pattern for
// mocking a constructor (WebClient is `new`'d inside each method — not at module load).
const {
  mockUsersInfo,
  mockReactionsAdd,
  mockReactionsRemove,
  mockGetUploadURL,
  mockCompleteUpload,
  mockChatPostMessage,
  mockChatUpdate,
  mockChatDelete,
} = vi.hoisted(() => ({
  mockUsersInfo: vi.fn(),
  mockReactionsAdd: vi.fn(),
  mockReactionsRemove: vi.fn(),
  mockGetUploadURL: vi.fn(),
  mockCompleteUpload: vi.fn(),
  mockChatPostMessage: vi.fn(),
  mockChatUpdate: vi.fn(),
  mockChatDelete: vi.fn(),
}));

// Mock the Slack Web API so tests never touch the network. The factory uses a real
// `function` (not an arrow) so `new WebClient()` works as a constructor.
vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn().mockImplementation(function () {
    return {
      users: { info: mockUsersInfo },
      reactions: { add: mockReactionsAdd, remove: mockReactionsRemove },
      files: { getUploadURLExternal: mockGetUploadURL, completeUploadExternal: mockCompleteUpload },
      chat: { postMessage: mockChatPostMessage, update: mockChatUpdate, delete: mockChatDelete },
    };
  }),
}));

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

// Build the headers Slack would send for a given body + timestamp, signing with
// `secret` (defaults to the real secret — pass a wrong one to forge a bad sig).
function signedHeaders(
  rawBody: string,
  timestamp: number,
  secret: string = SIGNING_SECRET,
): Record<string, string | undefined> {
  const basestring = `v0:${timestamp}:${rawBody}`;
  const signature = `v0=${createHmac("sha256", secret).update(basestring).digest("hex")}`;
  return {
    "x-slack-signature": signature,
    "x-slack-request-timestamp": String(timestamp),
  };
}

const NOW = () => Math.floor(Date.now() / 1000);

describe("slackAdapter.verifyWebhook", () => {
  const body = JSON.stringify({ type: "event_callback", event: { type: "message" } });

  it("accepts a correctly-signed request inside the timestamp window", () => {
    const ts = NOW();
    expect(slackAdapter.verifyWebhook(body, signedHeaders(body, ts), SIGNING_SECRET)).toBe(true);
  });

  it("rejects a request signed with the wrong secret (bad signature)", () => {
    const ts = NOW();
    const headers = signedHeaders(body, ts, "wrong-secret");
    expect(slackAdapter.verifyWebhook(body, headers, SIGNING_SECRET)).toBe(false);
  });

  it("rejects a tampered body (signature no longer matches)", () => {
    const ts = NOW();
    const headers = signedHeaders(body, ts);
    expect(slackAdapter.verifyWebhook(`${body} tampered`, headers, SIGNING_SECRET)).toBe(false);
  });

  it("rejects a stale timestamp (older than the 5-minute replay window)", () => {
    const stale = NOW() - 60 * 6; // 6 minutes ago
    const headers = signedHeaders(body, stale);
    expect(slackAdapter.verifyWebhook(body, headers, SIGNING_SECRET)).toBe(false);
  });

  it("rejects a future timestamp beyond the window", () => {
    const future = NOW() + 60 * 6;
    const headers = signedHeaders(body, future);
    expect(slackAdapter.verifyWebhook(body, headers, SIGNING_SECRET)).toBe(false);
  });

  it("rejects when the signature or timestamp header is missing", () => {
    const ts = NOW();
    expect(
      slackAdapter.verifyWebhook(body, { "x-slack-request-timestamp": String(ts) }, SIGNING_SECRET),
    ).toBe(false);
    expect(slackAdapter.verifyWebhook(body, signedHeaders(body, ts), SIGNING_SECRET)).toBe(true);
    const { "x-slack-signature": sig } = signedHeaders(body, ts);
    expect(slackAdapter.verifyWebhook(body, { "x-slack-signature": sig }, SIGNING_SECRET)).toBe(
      false,
    );
  });

  it("rejects when no signing secret is configured", () => {
    const ts = NOW();
    expect(slackAdapter.verifyWebhook(body, signedHeaders(body, ts), "")).toBe(false);
  });
});

describe("slackAdapter.parseInbound", () => {
  it("returns the challenge for a url_verification handshake", () => {
    const result = slackAdapter.parseInbound({ type: "url_verification", challenge: "abc123" });
    expect(result).toEqual({ type: "url_verification", challenge: "abc123" });
  });

  it("normalizes a plain channel message event", () => {
    const result = slackAdapter.parseInbound({
      type: "event_callback",
      team_id: "T123",
      event_id: "Ev999",
      event: {
        type: "message",
        channel: "C456",
        user: "U789",
        text: "hello from slack",
        ts: "1700000000.000100",
      },
    });
    expect(result).toEqual({
      type: "event",
      eventId: "Ev999",
      messages: [
        {
          kind: "message",
          teamId: "T123",
          channelId: "C456",
          userId: "U789",
          text: "hello from slack",
          ts: "1700000000.000100",
          threadTs: null,
          botId: null,
          eventId: "Ev999",
        },
      ],
    });
  });

  it("carries thread_ts and bot_id, and treats thread_ts === ts as a root", () => {
    const reply = slackAdapter.parseInbound({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev1",
      event: {
        type: "message",
        subtype: "bot_message",
        channel: "C1",
        text: "bot reply",
        ts: "1700000002.000000",
        thread_ts: "1700000000.000000",
        bot_id: "B0BOT",
      },
    });
    expect(reply.type).toBe("event");
    if (reply.type !== "event") throw new Error("unreachable");
    expect(reply.messages[0]).toMatchObject({
      kind: "message",
      threadTs: "1700000000.000000",
      botId: "B0BOT",
      userId: null,
    });

    const root = slackAdapter.parseInbound({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev2",
      event: {
        type: "message",
        channel: "C1",
        user: "U1",
        text: "root",
        ts: "1700000000.000000",
        thread_ts: "1700000000.000000",
      },
    });
    if (root.type !== "event") throw new Error("unreachable");
    expect(root.messages[0]?.threadTs).toBeNull();
  });

  it("tags message_changed / message_deleted subtypes for WAVE 2a", () => {
    const changed = slackAdapter.parseInbound({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev3",
      event: { type: "message", subtype: "message_changed", channel: "C1", ts: "1.2" },
    });
    if (changed.type !== "event") throw new Error("unreachable");
    expect(changed.messages[0]?.kind).toBe("message_changed");
  });

  it("deep-extracts the nested event.message for a message_changed edit", () => {
    const changed = slackAdapter.parseInbound({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev10",
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        ts: "1700000005.000000", // the EVENT envelope ts (not the message's)
        message: {
          type: "message",
          user: "U42",
          text: "edited body",
          ts: "1700000001.000300", // the actual message ts the bridge maps
          thread_ts: "1700000000.000000",
        },
        previous_message: { text: "old body", ts: "1700000001.000300" },
      },
    });
    if (changed.type !== "event") throw new Error("unreachable");
    // ts/text/user/thread come from event.message, NOT the top-level event.
    expect(changed.messages[0]).toMatchObject({
      kind: "message_changed",
      userId: "U42",
      text: "edited body",
      ts: "1700000001.000300",
      threadTs: "1700000000.000000",
    });
  });

  it("deep-extracts event.previous_message.ts for a message_deleted event", () => {
    const deleted = slackAdapter.parseInbound({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev11",
      event: {
        type: "message",
        subtype: "message_deleted",
        channel: "C1",
        ts: "1700000006.000000",
        deleted_ts: "1700000002.000900",
        previous_message: { text: "gone", ts: "1700000002.000900", user: "U7" },
      },
    });
    if (deleted.type !== "event") throw new Error("unreachable");
    expect(deleted.messages[0]).toMatchObject({
      kind: "message_deleted",
      ts: "1700000002.000900",
      userId: "U7",
    });
  });

  it("extracts files[] (url_private_download preferred) on a file_share message", () => {
    const result = slackAdapter.parseInbound({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev12",
      event: {
        type: "message",
        subtype: "file_share",
        channel: "C1",
        user: "U1",
        text: "see attached",
        ts: "1700000003.000000",
        files: [
          {
            id: "F1",
            name: "shot.png",
            mimetype: "image/png",
            url_private: "https://files.slack.com/f1?pub",
            url_private_download: "https://files.slack.com/f1?dl",
            size: 2048,
          },
          { id: "F2", name: "no-url.png", mimetype: "image/png" }, // skipped: no URL
        ],
      },
    });
    if (result.type !== "event") throw new Error("unreachable");
    expect(result.messages[0]?.files).toEqual([
      {
        id: "F1",
        name: "shot.png",
        mimetype: "image/png",
        urlPrivate: "https://files.slack.com/f1?dl",
        size: 2048,
      },
    ]);
  });

  it("omits the files key entirely for a text-only message (WAVE-1 shape preserved)", () => {
    const result = slackAdapter.parseInbound({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev13",
      event: { type: "message", channel: "C1", user: "U1", text: "no files", ts: "1.1" },
    });
    if (result.type !== "event") throw new Error("unreachable");
    expect(result.messages[0]).not.toHaveProperty("files");
  });

  it("emits no messages for a system subtype (channel_join)", () => {
    const result = slackAdapter.parseInbound({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev4",
      event: { type: "message", subtype: "channel_join", channel: "C1", ts: "1.2", user: "U1" },
    });
    expect(result).toEqual({ type: "event", eventId: "Ev4", messages: [] });
  });

  it("ignores non-event payloads and non-objects", () => {
    expect(slackAdapter.parseInbound({ type: "something_else" })).toEqual({ type: "ignored" });
    expect(slackAdapter.parseInbound(null)).toEqual({ type: "ignored" });
    expect(slackAdapter.parseInbound("nope")).toEqual({ type: "ignored" });
  });

  it("exposes the provider key", () => {
    expect(slackAdapter.provider).toBe(SLACK_PROVIDER);
    expect(SLACK_PROVIDER).toBe("slack");
  });
});

describe("slackAdapter.resolveUser", () => {
  beforeEach(() => {
    mockUsersInfo.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns name from real_name and imageUrl from profile.image_512 when present", async () => {
    mockUsersInfo.mockResolvedValue({
      ok: true,
      user: {
        real_name: "Ada Lovelace",
        profile: {
          display_name: "ada",
          image_512: "https://avatars.slack-edge.com/img_512.png",
          image_192: "https://avatars.slack-edge.com/img_192.png",
          image_72: "https://avatars.slack-edge.com/img_72.png",
        },
      },
    });
    const result = await slackAdapter.resolveUser("xoxb-token", "U123");
    expect(result).toEqual({
      name: "Ada Lovelace",
      imageUrl: "https://avatars.slack-edge.com/img_512.png",
    });
  });

  it("falls back to image_192 when image_512 is absent", async () => {
    mockUsersInfo.mockResolvedValue({
      ok: true,
      user: {
        real_name: "Grace Hopper",
        profile: {
          display_name: "grace",
          image_192: "https://avatars.slack-edge.com/img_192.png",
          image_72: "https://avatars.slack-edge.com/img_72.png",
        },
      },
    });
    const result = await slackAdapter.resolveUser("xoxb-token", "U456");
    expect(result).toEqual({
      name: "Grace Hopper",
      imageUrl: "https://avatars.slack-edge.com/img_192.png",
    });
  });

  it("falls back to profile.display_name for the name when real_name is absent", async () => {
    mockUsersInfo.mockResolvedValue({ ok: true, user: { profile: { display_name: "ada" } } });
    const result = await slackAdapter.resolveUser("xoxb-token", "U1");
    expect(result).toEqual({ name: "ada", imageUrl: null });
  });

  it("falls back to the top-level name when real_name + display_name are absent", async () => {
    mockUsersInfo.mockResolvedValue({ ok: true, user: { name: "ada-top" } });
    const result = await slackAdapter.resolveUser("xoxb-token", "U2");
    expect(result).toEqual({ name: "ada-top", imageUrl: null });
  });

  it("falls back to the userId + null image for an empty user object", async () => {
    mockUsersInfo.mockResolvedValue({ ok: true, user: {} });
    const result = await slackAdapter.resolveUser("xoxb-token", "U3");
    expect(result).toEqual({ name: "U3", imageUrl: null });
  });

  it("falls back to image_72 for the avatar when larger images are absent", async () => {
    mockUsersInfo.mockResolvedValue({
      ok: true,
      user: { real_name: "Ada", profile: { image_72: "https://avatars/img_72.png" } },
    });
    const result = await slackAdapter.resolveUser("xoxb-token", "U4");
    expect(result).toEqual({ name: "Ada", imageUrl: "https://avatars/img_72.png" });
  });

  it("returns a null imageUrl when the profile carries no images", async () => {
    mockUsersInfo.mockResolvedValue({
      ok: true,
      user: { real_name: "Ada", profile: { display_name: "ada" } },
    });
    const result = await slackAdapter.resolveUser("xoxb-token", "U5");
    expect(result).toEqual({ name: "Ada", imageUrl: null });
  });

  it("returns { name: userId, imageUrl: null } when users.info throws", async () => {
    mockUsersInfo.mockRejectedValue(new Error("missing_scope: users:read"));
    const result = await slackAdapter.resolveUser("xoxb-token", "U789");
    expect(result).toEqual({ name: "U789", imageUrl: null });
  });
});

describe("slackAdapter.postMessage / updateMessage / deleteMessage", () => {
  beforeEach(() => {
    mockChatPostMessage.mockReset();
    mockChatUpdate.mockReset();
    mockChatDelete.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("postMessage spreads channel/text + thread_ts/username/icon_url when all are set", async () => {
    mockChatPostMessage.mockResolvedValue({ ok: true, ts: "1700000000.000100" });
    const result = await slackAdapter.postMessage("xoxb-token", {
      channelId: "C1",
      text: "hello",
      threadTs: "1700000000.000000",
      username: "Ada",
      iconUrl: "https://slack/ada.png",
    });
    expect(result).toEqual({ ts: "1700000000.000100" });
    expect(mockChatPostMessage).toHaveBeenCalledWith({
      channel: "C1",
      text: "hello",
      thread_ts: "1700000000.000000",
      username: "Ada",
      icon_url: "https://slack/ada.png",
    });
  });

  it("postMessage omits thread_ts/username/icon_url when those args are unset", async () => {
    mockChatPostMessage.mockResolvedValue({ ok: true, ts: "1700000000.000200" });
    await slackAdapter.postMessage("xoxb-token", { channelId: "C1", text: "hi" });
    expect(mockChatPostMessage).toHaveBeenCalledWith({ channel: "C1", text: "hi" });
    const params = mockChatPostMessage.mock.calls[0]![0];
    expect(params).not.toHaveProperty("thread_ts");
    expect(params).not.toHaveProperty("username");
    expect(params).not.toHaveProperty("icon_url");
  });

  it("postMessage throws when the response is not ok", async () => {
    mockChatPostMessage.mockResolvedValue({ ok: false, error: "channel_not_found" });
    await expect(
      slackAdapter.postMessage("xoxb-token", { channelId: "C1", text: "hi" }),
    ).rejects.toThrow(/chat.postMessage failed/);
  });

  it("postMessage throws when ok is true but no ts is returned", async () => {
    mockChatPostMessage.mockResolvedValue({ ok: true });
    await expect(
      slackAdapter.postMessage("xoxb-token", { channelId: "C1", text: "hi" }),
    ).rejects.toThrow(/chat.postMessage failed/);
  });

  it("updateMessage calls chat.update with channel/ts/text", async () => {
    mockChatUpdate.mockResolvedValue({ ok: true });
    await slackAdapter.updateMessage("xoxb-token", {
      channelId: "C1",
      ts: "1700000000.000100",
      text: "edited",
    });
    expect(mockChatUpdate).toHaveBeenCalledWith({
      channel: "C1",
      ts: "1700000000.000100",
      text: "edited",
    });
  });

  it("updateMessage throws on { ok:false }", async () => {
    mockChatUpdate.mockResolvedValue({ ok: false, error: "message_not_found" });
    await expect(
      slackAdapter.updateMessage("xoxb-token", { channelId: "C1", ts: "1.1", text: "x" }),
    ).rejects.toThrow(/chat.update failed/);
  });

  it("deleteMessage calls chat.delete with channel/ts", async () => {
    mockChatDelete.mockResolvedValue({ ok: true });
    await slackAdapter.deleteMessage("xoxb-token", { channelId: "C1", ts: "1700000000.000100" });
    expect(mockChatDelete).toHaveBeenCalledWith({ channel: "C1", ts: "1700000000.000100" });
  });

  it("deleteMessage throws on { ok:false }", async () => {
    mockChatDelete.mockResolvedValue({ ok: false, error: "cant_delete_message" });
    await expect(
      slackAdapter.deleteMessage("xoxb-token", { channelId: "C1", ts: "1.1" }),
    ).rejects.toThrow(/chat.delete failed/);
  });
});

describe("slackAdapter.parseInbound — reactions", () => {
  it("normalizes a reaction_added event on a message", () => {
    const result = slackAdapter.parseInbound({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev20",
      event: {
        type: "reaction_added",
        user: "U9",
        reaction: "thumbsup",
        item: { type: "message", channel: "C1", ts: "1700000000.000100" },
        item_user: "U1",
      },
    });
    expect(result).toEqual({
      type: "event",
      eventId: "Ev20",
      messages: [],
      reactions: [
        {
          action: "added",
          teamId: "T1",
          channelId: "C1",
          userId: "U9",
          reaction: "thumbsup",
          messageTs: "1700000000.000100",
          eventId: "Ev20",
        },
      ],
    });
  });

  it("normalizes a reaction_removed event", () => {
    const result = slackAdapter.parseInbound({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev21",
      event: {
        type: "reaction_removed",
        user: "U9",
        reaction: "heart",
        item: { type: "message", channel: "C1", ts: "1700000000.000200" },
      },
    });
    if (result.type !== "event") throw new Error("unreachable");
    expect(result.reactions?.[0]).toMatchObject({ action: "removed", reaction: "heart" });
    expect(result.messages).toHaveLength(0);
  });

  it("ignores a reaction on a non-message item (file / file_comment)", () => {
    const result = slackAdapter.parseInbound({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev22",
      event: {
        type: "reaction_added",
        user: "U9",
        reaction: "thumbsup",
        item: { type: "file", file: "F1" },
      },
    });
    expect(result).toEqual({ type: "event", eventId: "Ev22", messages: [] });
  });
});

describe("slackAdapter.addReaction / removeReaction", () => {
  beforeEach(() => {
    mockReactionsAdd.mockReset();
    mockReactionsRemove.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("addReaction calls reactions.add with channel/timestamp/name", async () => {
    mockReactionsAdd.mockResolvedValue({ ok: true });
    await slackAdapter.addReaction("xoxb-token", {
      channelId: "C1",
      ts: "1700000000.000100",
      name: "thumbsup",
    });
    expect(mockReactionsAdd).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "1700000000.000100",
      name: "thumbsup",
    });
  });

  it("addReaction is idempotent — treats already_reacted as success (no throw)", async () => {
    mockReactionsAdd.mockRejectedValue({ data: { error: "already_reacted" } });
    await expect(
      slackAdapter.addReaction("xoxb-token", { channelId: "C1", ts: "1.1", name: "thumbsup" }),
    ).resolves.toBeUndefined();
  });

  it("addReaction rethrows a genuine provider error", async () => {
    mockReactionsAdd.mockRejectedValue({ data: { error: "channel_not_found" } });
    await expect(
      slackAdapter.addReaction("xoxb-token", { channelId: "C1", ts: "1.1", name: "thumbsup" }),
    ).rejects.toBeTruthy();
  });

  it("removeReaction is idempotent — treats no_reaction as success", async () => {
    mockReactionsRemove.mockRejectedValue({ data: { error: "no_reaction" } });
    await expect(
      slackAdapter.removeReaction("xoxb-token", { channelId: "C1", ts: "1.1", name: "heart" }),
    ).resolves.toBeUndefined();
  });

  it("removeReaction calls reactions.remove with channel/timestamp/name", async () => {
    mockReactionsRemove.mockResolvedValue({ ok: true });
    await slackAdapter.removeReaction("xoxb-token", { channelId: "C2", ts: "2.2", name: "fire" });
    expect(mockReactionsRemove).toHaveBeenCalledWith({
      channel: "C2",
      timestamp: "2.2",
      name: "fire",
    });
  });
});

describe("slackAdapter.uploadFile — external upload flow", () => {
  beforeEach(() => {
    mockGetUploadURL.mockReset();
    mockCompleteUpload.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("gets an upload url, POSTs the bytes, and completes the upload into the channel", async () => {
    mockGetUploadURL.mockResolvedValue({
      ok: true,
      file_id: "F123",
      upload_url: "https://files.slack.com/upload/v1/ABC",
    });
    mockCompleteUpload.mockResolvedValue({ ok: true });
    const fetchSpy = vi.fn(async () => ({ ok: true, body: null }) as unknown as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const data = Buffer.from("hello world");
    await slackAdapter.uploadFile("xoxb-token", {
      channelId: "C1",
      filename: "note.txt",
      data,
    });

    // #1 request the external upload URL, sized to the exact bytes.
    expect(mockGetUploadURL).toHaveBeenCalledWith({ filename: "note.txt", length: data.length });
    // #2 POST the raw bytes to the returned upload_url.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://files.slack.com/upload/v1/ABC");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBeInstanceOf(Uint8Array);
    // #3 complete the upload, sharing it into the channel (no thread when unthreaded).
    expect(mockCompleteUpload).toHaveBeenCalledWith({
      files: [{ id: "F123", title: "note.txt" }],
      channel_id: "C1",
    });
  });

  it("passes thread_ts through when the message is threaded", async () => {
    mockGetUploadURL.mockResolvedValue({
      ok: true,
      file_id: "F9",
      upload_url: "https://files.slack.com/upload/v1/Z",
    });
    mockCompleteUpload.mockResolvedValue({ ok: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, body: null }) as unknown as Response),
    );

    await slackAdapter.uploadFile("xoxb-token", {
      channelId: "C1",
      threadTs: "1700000000.000000",
      filename: "shot.png",
      data: Buffer.from("bytes"),
    });
    expect(mockCompleteUpload).toHaveBeenCalledWith({
      files: [{ id: "F9", title: "shot.png" }],
      channel_id: "C1",
      thread_ts: "1700000000.000000",
    });
  });

  it("throws when getUploadURLExternal returns no upload_url", async () => {
    mockGetUploadURL.mockResolvedValue({ ok: false, error: "invalid_auth" });
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      slackAdapter.uploadFile("xoxb-token", {
        channelId: "C1",
        filename: "x",
        data: Buffer.from("x"),
      }),
    ).rejects.toThrow(/getUploadURLExternal/);
  });

  it("throws when the upload POST fails, and cancels the response body (no leaked stream)", async () => {
    mockGetUploadURL.mockResolvedValue({
      ok: true,
      file_id: "F1",
      upload_url: "https://files.slack.com/upload/v1/Q",
    });
    const cancelSpy = vi.fn(async () => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({ ok: false, status: 500, body: { cancel: cancelSpy } }) as unknown as Response,
      ),
    );
    await expect(
      slackAdapter.uploadFile("xoxb-token", {
        channelId: "C1",
        filename: "x",
        data: Buffer.from("x"),
      }),
    ).rejects.toThrow(/upload POST failed/);
    // The erroring response's body stream was cancelled — no leak.
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(mockCompleteUpload).not.toHaveBeenCalled();
  });

  it("throws when completeUploadExternal returns { ok:false } (final step)", async () => {
    mockGetUploadURL.mockResolvedValue({
      ok: true,
      file_id: "F1",
      upload_url: "https://files.slack.com/upload/v1/OK",
    });
    mockCompleteUpload.mockResolvedValue({ ok: false, error: "channel_not_found" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, body: null }) as unknown as Response),
    );
    await expect(
      slackAdapter.uploadFile("xoxb-token", {
        channelId: "C1",
        filename: "note.txt",
        data: Buffer.from("bytes"),
      }),
    ).rejects.toThrow(/completeUploadExternal/);
  });
});
