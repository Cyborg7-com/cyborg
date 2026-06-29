import { describe, expect, it } from "vitest";
import { buildBadgeFcmMessage, buildFcmMessage } from "./push-fcm.js";
import type { PushPayload } from "./push.js";

const PAYLOAD: PushPayload = {
  title: "Alice",
  body: "hey there",
  url: "/workspace/ws1/channel/ch9",
  tag: "ch:ch9",
};

// #480: Android must be DATA-ONLY so CyborgFirebaseMessagingService.onMessageReceived
// runs (and groups). A `notification` block would auto-display + bypass it.
describe("buildFcmMessage — Android (data-only, the grouping fix)", () => {
  const msg = buildFcmMessage("tok", PAYLOAD, "android");

  it("has NO top-level notification block (would skip onMessageReceived)", () => {
    expect(msg.notification).toBeUndefined();
  });

  it("has NO android.notification block (same auto-display trap)", () => {
    expect((msg.android as Record<string, unknown>).notification).toBeUndefined();
  });

  it("carries title/body/url/tag in `data` (Android reads them from there)", () => {
    expect(msg.data).toEqual({
      url: "/workspace/ws1/channel/ch9",
      tag: "ch:ch9",
      title: "Alice",
      body: "hey there",
    });
  });

  it("keeps HIGH priority + ttl so data-only delivers promptly", () => {
    expect(msg.android).toEqual({ priority: "HIGH", ttl: "60s" });
  });

  it("sends no apns block to an Android token", () => {
    expect(msg.apns).toBeUndefined();
  });

  it("non-ios platforms (default/unknown) take the Android data-only path", () => {
    const def = buildFcmMessage("tok", PAYLOAD, "");
    expect(def.notification).toBeUndefined();
    expect((def.data as Record<string, unknown>).title).toBe("Alice");
  });

  it("omits tag from data when the payload has none", () => {
    const noTag = buildFcmMessage("tok", { ...PAYLOAD, tag: undefined }, "android");
    expect(noTag.data).toEqual({
      url: "/workspace/ws1/channel/ch9",
      title: "Alice",
      body: "hey there",
    });
  });
});

// iOS is unchanged: notification + apns/aps drive display (FCM-over-APNs).
describe("buildFcmMessage — iOS (unchanged)", () => {
  const msg = buildFcmMessage("tok", { ...PAYLOAD, badgeCount: 3 }, "ios");

  it("keeps the top-level notification block", () => {
    expect(msg.notification).toEqual({ title: "Alice", body: "hey there" });
  });

  it("data carries url/tag but NOT title/body (iOS reads those from aps)", () => {
    expect(msg.data).toEqual({ url: "/workspace/ws1/channel/ch9", tag: "ch:ch9" });
  });

  it("apns aps has alert + custom sound + the badge when present", () => {
    const aps = ((msg.apns as Record<string, unknown>).payload as Record<string, unknown>)
      .aps as Record<string, unknown>;
    expect(aps.alert).toEqual({ title: "Alice", body: "hey there" });
    expect(aps.sound).toBe("notification.caf");
    expect(aps.badge).toBe(3);
  });

  it("omits aps.badge when no badgeCount was computed", () => {
    const noBadge = buildFcmMessage("tok", PAYLOAD, "ios");
    const aps = ((noBadge.apns as Record<string, unknown>).payload as Record<string, unknown>)
      .aps as Record<string, unknown>;
    expect("badge" in aps).toBe(false);
  });

  it("sends no android block to an iOS token", () => {
    expect(msg.android).toBeUndefined();
  });
});

// #605: clear-on-read badge sync. A SILENT badge update — no banner, no sound —
// just the app-icon count, so it can clear to 0 when the user reads elsewhere.
describe("buildBadgeFcmMessage — iOS (silent content-available badge)", () => {
  const msg = buildBadgeFcmMessage("tok", 4, "ios");

  it("carries NO notification block (silent — no banner)", () => {
    expect(msg.notification).toBeUndefined();
    expect(msg.data).toBeUndefined();
  });

  it("sets aps.badge + content-available, with no alert/sound", () => {
    const aps = ((msg.apns as Record<string, unknown>).payload as Record<string, unknown>)
      .aps as Record<string, unknown>;
    expect(aps.badge).toBe(4);
    expect(aps["content-available"]).toBe(1);
    expect("alert" in aps).toBe(false);
    expect("sound" in aps).toBe(false);
  });

  it("uses the background apns headers (priority 5, push-type background)", () => {
    expect((msg.apns as Record<string, unknown>).headers).toEqual({
      "apns-priority": "5",
      "apns-push-type": "background",
    });
  });

  it("can clear the badge all the way to 0", () => {
    const cleared = buildBadgeFcmMessage("tok", 0, "ios");
    const aps = ((cleared.apns as Record<string, unknown>).payload as Record<string, unknown>)
      .aps as Record<string, unknown>;
    expect(aps.badge).toBe(0);
  });
});

describe("buildBadgeFcmMessage — Android (data-only silent badge)", () => {
  const msg = buildBadgeFcmMessage("tok", 4, "android");

  it("has NO notification block (silent, onMessageReceived runs)", () => {
    expect(msg.notification).toBeUndefined();
  });

  it("carries type=badge + count as a string in data", () => {
    expect(msg.data).toEqual({ type: "badge", count: "4" });
  });

  it("keeps HIGH priority + ttl, and no apns block", () => {
    expect(msg.android).toEqual({ priority: "HIGH", ttl: "60s" });
    expect(msg.apns).toBeUndefined();
  });

  it("sends count 0 to clear the launcher badge", () => {
    expect((buildBadgeFcmMessage("tok", 0, "android").data as Record<string, unknown>).count).toBe(
      "0",
    );
  });
});
