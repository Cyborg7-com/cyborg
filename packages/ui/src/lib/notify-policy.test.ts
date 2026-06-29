// Ported from cyborg7-core's policy.test.ts (the 21 cases that encode the
// notification policy). Run: mise exec -- ./packages/server/node_modules/.bin/tsx --test packages/ui/src/lib/notify-policy.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldNotifyFor,
  hasMention,
  hasBroadcastMention,
  hasPersonalMention,
  hasKeywordMatch,
  type NotifyContext,
} from "./notify-policy.ts";

const base: NotifyContext = {
  currentUserId: "me",
  currentUserName: "Alice",
  activeChannelId: null,
  viewingDmHumanUserId: null,
  viewingDmAgentId: null,
  channelNotifPrefs: {},
  humanDmNotifPrefs: {},
  agentDmNotifPrefs: {},
  isTabFocused: () => true,
};
const ctx = (o: Partial<NotifyContext> = {}): NotifyContext => ({ ...base, ...o });
const notifies = (k: Parameters<typeof shouldNotifyFor>[0], c = ctx()) =>
  shouldNotifyFor(k, c).notify;

// ── channel_message ──
test("1 skips own messages", () => {
  assert.equal(
    notifies({ kind: "channel_message", channelId: "c1", senderId: "me", text: "hi" }),
    false,
  );
});
test("2 skips when viewing the channel + focused", () => {
  assert.equal(
    notifies(
      { kind: "channel_message", channelId: "c1", senderId: "u2", text: "hi" },
      ctx({ activeChannelId: "c1" }),
    ),
    false,
  );
});
test("3 skips when channel muted", () => {
  assert.equal(
    notifies(
      { kind: "channel_message", channelId: "c1", senderId: "u2", text: "hi" },
      ctx({ channelNotifPrefs: { c1: "muted" } }),
    ),
    false,
  );
});
test("4 mentions_only, no mention → false", () => {
  assert.equal(
    notifies(
      { kind: "channel_message", channelId: "c1", senderId: "u2", text: "hi team" },
      ctx({ channelNotifPrefs: { c1: "mentions_only" } }),
    ),
    false,
  );
});
test("5 mentions_only, @everyone → true", () => {
  assert.equal(
    notifies(
      { kind: "channel_message", channelId: "c1", senderId: "u2", text: "hey @everyone" },
      ctx({ channelNotifPrefs: { c1: "mentions_only" } }),
    ),
    true,
  );
});
test("6 mentions_only, @ALICE case-insensitive → true", () => {
  assert.equal(
    notifies(
      { kind: "channel_message", channelId: "c1", senderId: "u2", text: "hello @ALICE" },
      ctx({ channelNotifPrefs: { c1: "mentions_only" } }),
    ),
    true,
  );
});
test("7 mentions_only, bracket @[alice] → true", () => {
  assert.equal(
    notifies(
      { kind: "channel_message", channelId: "c1", senderId: "u2", text: "cc @[alice]" },
      ctx({ channelNotifPrefs: { c1: "mentions_only" } }),
    ),
    true,
  );
});
test("8 substring trap: user Ale, @Alex → false; @Ale variants → true", () => {
  const c = ctx({ currentUserName: "Ale", channelNotifPrefs: { c1: "mentions_only" } });
  const m = (text: string) =>
    notifies({ kind: "channel_message", channelId: "c1", senderId: "u2", text }, c);
  assert.equal(m("@Alex check this"), false);
  assert.equal(m("@Ale ping"), true);
  assert.equal(m("@Ale, check"), true);
  assert.equal(m("thanks @Ale"), true);
});
test("9 @here and @channel → true", () => {
  const c = ctx({ channelNotifPrefs: { c1: "mentions_only" } });
  assert.equal(
    notifies({ kind: "channel_message", channelId: "c1", senderId: "u2", text: "@here" }, c),
    true,
  );
  assert.equal(
    notifies({ kind: "channel_message", channelId: "c1", senderId: "u2", text: "@channel" }, c),
    true,
  );
});
test("10 pref all → notify any non-own", () => {
  assert.equal(
    notifies(
      { kind: "channel_message", channelId: "c1", senderId: "u2", text: "no mention" },
      ctx({ channelNotifPrefs: { c1: "all" } }),
    ),
    true,
  );
});
test("11 default pref is mentions_only (plain channel message does NOT notify)", () => {
  // An un-set channel defaults to mentions_only, matching the server
  // (relay-standalone.ts `?? "mentions_only"`): a plain non-mention message is
  // silent, a mention still rings. This is what stops a muted/mentions-only
  // channel in a NON-ACTIVE workspace — whose pref may not be loaded — from
  // banner-ing a plain message.
  assert.equal(
    notifies({ kind: "channel_message", channelId: "c1", senderId: "u2", text: "no mention" }),
    false,
  );
  assert.equal(
    notifies({ kind: "channel_message", channelId: "c1", senderId: "u2", text: "hi @alice" }),
    true,
  );
});
test("11b cross-workspace muted/mentions-only channel: plain message stays silent even when pref is unknown", () => {
  // Repro of the reported bug: focused on workspace "jex"; a plain message lands
  // in workspace "rodrigo's" channel the user muted / set to mentions-only.
  // Whether or not that workspace's pref is loaded client-side, a plain message
  // must NOT banner; a real mention still does.
  const plain = {
    kind: "channel_message",
    channelId: "rod-chan",
    senderId: "u2",
    text: "hey team",
  } as const;
  const ping = {
    kind: "channel_message",
    channelId: "rod-chan",
    senderId: "u2",
    text: "hey @alice",
  } as const;
  // pref not loaded (unknown) → silent on plain, ring on mention
  assert.equal(notifies(plain), false);
  assert.equal(notifies(ping), true);
  // pref loaded as muted → silent on both
  const muted = ctx({ channelNotifPrefs: { "rod-chan": "muted" } });
  assert.equal(notifies(plain, muted), false);
  assert.equal(notifies(ping, muted), false);
  // pref loaded as mentions_only → silent on plain, ring on mention
  const mentionsOnly = ctx({ channelNotifPrefs: { "rod-chan": "mentions_only" } });
  assert.equal(notifies(plain, mentionsOnly), false);
  assert.equal(notifies(ping, mentionsOnly), true);
  // pref loaded as all → ring on a plain message (the un-muted case must NOT regress)
  const all = ctx({ channelNotifPrefs: { "rod-chan": "all" } });
  assert.equal(notifies(plain, all), true);
});

// ── dm_human ──
test("12 skips own DM", () => {
  assert.equal(notifies({ kind: "dm_human", fromUserId: "me", text: "x" }), false);
});
test("13 skips when viewing that peer + focused", () => {
  assert.equal(
    notifies(
      { kind: "dm_human", fromUserId: "bob", text: "x" },
      ctx({ viewingDmHumanUserId: "bob" }),
    ),
    false,
  );
});
test("14 skips when peer muted", () => {
  assert.equal(
    notifies(
      { kind: "dm_human", fromUserId: "bob", text: "x" },
      ctx({ humanDmNotifPrefs: { bob: "muted" } }),
    ),
    false,
  );
});
test("15 default DM pref all → notify", () => {
  assert.equal(notifies({ kind: "dm_human", fromUserId: "bob", text: "x" }), true);
});

// ── dm_agent ──
test("16 skips when viewing that agent + focused", () => {
  assert.equal(
    notifies({ kind: "dm_agent", remoteAgentId: "a1", text: "x" }, ctx({ viewingDmAgentId: "a1" })),
    false,
  );
});
test("17 skips when agent muted", () => {
  assert.equal(
    notifies(
      { kind: "dm_agent", remoteAgentId: "a1", text: "x" },
      ctx({ agentDmNotifPrefs: { a1: "muted" } }),
    ),
    false,
  );
});
test("18 default agent DM pref all → notify", () => {
  assert.equal(notifies({ kind: "dm_agent", remoteAgentId: "a1", text: "x" }), true);
});

// ── focus vs visibility (unfocused tab fires even when 'viewing') ──
test("19 viewing channel but unfocused → notify", () => {
  assert.equal(
    notifies(
      { kind: "channel_message", channelId: "c1", senderId: "u2", text: "x" },
      ctx({ activeChannelId: "c1", channelNotifPrefs: { c1: "all" }, isTabFocused: () => false }),
    ),
    true,
  );
});
test("20 viewing agent DM but unfocused → notify", () => {
  assert.equal(
    notifies(
      { kind: "dm_agent", remoteAgentId: "a1", text: "x" },
      ctx({ viewingDmAgentId: "a1", isTabFocused: () => false }),
    ),
    true,
  );
});
test("21 viewing human DM but unfocused → notify", () => {
  assert.equal(
    notifies(
      { kind: "dm_human", fromUserId: "bob", text: "x" },
      ctx({ viewingDmHumanUserId: "bob", isTabFocused: () => false }),
    ),
    true,
  );
});

// ── matcher unit ──
test("hasMention boundary cases", () => {
  assert.equal(hasMention("hi @alice!", "alice"), true);
  assert.equal(hasMention("user@alice.com", "alice"), true); // contains @alice followed by '.', boundary ok
  assert.equal(hasMention("@alicia", "alice"), false);
  assert.equal(hasMention("nothing here", "alice"), false);
});

// ── DND (client-side) ──
test("DND suppresses a plain channel message", () => {
  assert.equal(
    notifies(
      { kind: "channel_message", channelId: "c1", senderId: "u2", text: "hello team" },
      ctx({ dndActive: true }),
    ),
    false,
  );
});
test("DND still notifies on a personal @mention", () => {
  assert.equal(
    notifies(
      { kind: "channel_message", channelId: "c1", senderId: "u2", text: "ping @alice" },
      ctx({ dndActive: true }),
    ),
    true,
  );
});
test("DND suppresses @channel broadcast (only personal mentions ring)", () => {
  assert.equal(
    notifies(
      { kind: "channel_message", channelId: "c1", senderId: "u2", text: "@channel standup" },
      ctx({ dndActive: true }),
    ),
    false,
  );
});
test("DND suppresses a human DM", () => {
  assert.equal(
    notifies({ kind: "dm_human", fromUserId: "bob", text: "yo" }, ctx({ dndActive: true })),
    false,
  );
});
test("DND suppresses an agent DM", () => {
  assert.equal(
    notifies({ kind: "dm_agent", remoteAgentId: "a1", text: "done" }, ctx({ dndActive: true })),
    false,
  );
});
test("DND suppresses task notifications", () => {
  assert.equal(notifies({ kind: "task_assigned" }, ctx({ dndActive: true })), false);
});

// ── Custom highlight keywords ──
test("keyword turns a mentions_only channel into a notify", () => {
  assert.equal(
    notifies(
      { kind: "channel_message", channelId: "c1", senderId: "u2", text: "this is urgent now" },
      ctx({ channelNotifPrefs: { c1: "mentions_only" }, highlightKeywords: ["urgent"] }),
    ),
    true,
  );
});
test("keyword is whole-word, case-insensitive (no partial match)", () => {
  const c = ctx({ channelNotifPrefs: { c1: "mentions_only" }, highlightKeywords: ["deploy"] });
  const m = (text: string) =>
    notifies({ kind: "channel_message", channelId: "c1", senderId: "u2", text }, c);
  assert.equal(m("please DEPLOY now"), true);
  assert.equal(m("redeployment failed"), false);
});
test("keyword bypasses DND", () => {
  assert.equal(
    notifies(
      { kind: "channel_message", channelId: "c1", senderId: "u2", text: "blocker found" },
      ctx({ dndActive: true, highlightKeywords: ["blocker"] }),
    ),
    true,
  );
});

// ── Per-channel ignore @channel/@here/@all ──
test("ignore-broadcast drops @channel in mentions_only channel", () => {
  assert.equal(
    notifies(
      { kind: "channel_message", channelId: "c1", senderId: "u2", text: "@channel news" },
      ctx({
        channelNotifPrefs: { c1: "mentions_only" },
        channelIgnoreBroadcast: { c1: true },
      }),
    ),
    false,
  );
});
test("ignore-broadcast still notifies on a personal @mention", () => {
  assert.equal(
    notifies(
      { kind: "channel_message", channelId: "c1", senderId: "u2", text: "@channel @alice look" },
      ctx({
        channelNotifPrefs: { c1: "mentions_only" },
        channelIgnoreBroadcast: { c1: true },
      }),
    ),
    true,
  );
});
test("ignore-broadcast is per-channel (other channels still notify on @here)", () => {
  assert.equal(
    notifies(
      { kind: "channel_message", channelId: "c2", senderId: "u2", text: "@here meeting" },
      ctx({
        channelNotifPrefs: { c2: "mentions_only" },
        channelIgnoreBroadcast: { c1: true },
      }),
    ),
    true,
  );
});

// ── granular matcher units ──
test("hasBroadcastMention covers all broadcast tokens", () => {
  assert.equal(hasBroadcastMention("@channel"), true);
  assert.equal(hasBroadcastMention("@here"), true);
  assert.equal(hasBroadcastMention("@everyone"), true);
  assert.equal(hasBroadcastMention("@all"), true);
  assert.equal(hasBroadcastMention("@alice"), false);
});
test("hasPersonalMention excludes broadcasts", () => {
  assert.equal(hasPersonalMention("@alice", "alice"), true);
  assert.equal(hasPersonalMention("@[alice]", "alice"), true);
  assert.equal(hasPersonalMention("@channel", "alice"), false);
  assert.equal(hasPersonalMention("@alicia", "alice"), false);
});
test("hasKeywordMatch whole-word + empty handling", () => {
  assert.equal(hasKeywordMatch("the build is red", ["red"]), true);
  assert.equal(hasKeywordMatch("retired engine", ["red"]), false);
  assert.equal(hasKeywordMatch("nothing", []), false);
  assert.equal(hasKeywordMatch("nothing", ["  "]), false);
});
