import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { slackAdapter, SLACK_PROVIDER } from "./slack-adapter.js";

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
