// Client notification policy — when to fire an in-app sound / OS banner for an
// incoming message. Hand-ported from cyborg7-core's src/lib/notify/policy.ts
// (Slack-parity). Pure + deterministic so it's unit-tested (notify-policy.test.ts).
//
// Rules (per kind):
//  channel_message: skip own → skip if viewing that channel AND tab focused →
//    pref (default mentions_only, matching the server): muted skips;
//    mentions_only requires a mention; all notifies. The default is mentions_only
//    (NOT all) so an un-set channel — including one in a non-active workspace
//    whose pref hasn't loaded — never banners a plain non-mention message.
//  dm_human: skip own → skip if viewing that peer AND focused → pref (default all): muted skips.
//  dm_agent: NO own-skip → skip if viewing that agent AND focused → pref (default all): muted skips.
//  task_*: always notify.

export type NotificationPref = "all" | "mentions_only" | "muted";

export type NotificationKind =
  | { kind: "channel_message"; channelId: string; senderId?: string; text: string }
  | { kind: "dm_human"; fromUserId: string; text: string }
  | { kind: "dm_agent"; remoteAgentId: string; text: string }
  | { kind: "task_assigned" }
  | { kind: "task_review_requested" };

export interface NotifyContext {
  currentUserId?: string;
  currentUserName?: string;
  activeChannelId?: string | null;
  viewingDmHumanUserId?: string | null;
  viewingDmAgentId?: string | null;
  channelNotifPrefs: Record<string, NotificationPref>;
  humanDmNotifPrefs: Record<string, "all" | "muted">;
  agentDmNotifPrefs: Record<string, "all" | "muted">;
  // Do Not Disturb (client-side). When true, suppresses every banner/sound
  // EXCEPT direct personal @mentions (group broadcasts like @channel/@here are
  // also suppressed). Optional + defaults off so prior behavior is unchanged.
  dndActive?: boolean;
  // Extra highlight keywords (beyond @username) that count as a notify-worthy
  // mention for mentions_only channels and for DND-bypass. Lower-cased,
  // whole-word match. Optional + defaults to none.
  highlightKeywords?: string[];
  // Per-channel "ignore @channel/@here/@all" flags (channelId -> true). When set
  // for a channel, a message whose ONLY mention is a group broadcast does not
  // count as a mention. Optional + defaults to none.
  channelIgnoreBroadcast?: Record<string, boolean>;
  // Injectable for tests; defaults to the real document focus check.
  isTabFocused?: () => boolean;
}

export interface PolicyDecision {
  notify: boolean;
  reason: string;
}

const SKIP = {
  own: "skip:own",
  viewing: "skip:viewing",
  muted: "skip:muted",
  noMention: "skip:no-mention",
  dnd: "skip:dnd",
} as const;

export function defaultIsTabFocused(): boolean {
  if (typeof document === "undefined") return true;
  const visible = document.visibilityState === "visible";
  // hasFocus() distinguishes "tab visible but OS focus elsewhere / screen
  // locked" — visibilityState alone stays 'visible' there and over-suppresses.
  const focused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
  return visible && focused;
}

// Strict mention matcher: group tokens, bracket form, or `@name` with a trailing
// word boundary (so `@Alex` does NOT match a user named `Ale`).
export function hasMention(text: string, currentUserName: string | undefined): boolean {
  if (text.includes("@everyone") || text.includes("@here") || text.includes("@channel"))
    return true;
  if (!currentUserName) return false;
  const lowerText = text.toLowerCase();
  const lowerName = currentUserName.toLowerCase();
  if (lowerText.includes(`@[${lowerName}]`)) return true;
  const needle = `@${lowerName}`;
  let from = 0;
  for (;;) {
    const idx = lowerText.indexOf(needle, from);
    if (idx === -1) return false;
    const next = lowerText.charAt(idx + needle.length);
    if (next === "" || !/[a-z0-9_]/.test(next)) return true;
    from = idx + needle.length;
  }
}

// True when the text contains a channel-wide broadcast token (@everyone/@here/
// @channel/@all). These are the mentions a per-channel "Ignore @channel" toggle
// suppresses.
export function hasBroadcastMention(text: string): boolean {
  return (
    text.includes("@everyone") ||
    text.includes("@here") ||
    text.includes("@channel") ||
    text.includes("@all")
  );
}

// True when the text contains a PERSONAL @mention of the current user (the
// @name / @[name] forms — broadcasts excluded). Shares the word-boundary scan
// with hasMention so `@Alex` never matches a user named `Ale`.
export function hasPersonalMention(text: string, currentUserName: string | undefined): boolean {
  if (!currentUserName) return false;
  const lowerText = text.toLowerCase();
  const lowerName = currentUserName.toLowerCase();
  if (lowerText.includes(`@[${lowerName}]`)) return true;
  const needle = `@${lowerName}`;
  let from = 0;
  for (;;) {
    const idx = lowerText.indexOf(needle, from);
    if (idx === -1) return false;
    const next = lowerText.charAt(idx + needle.length);
    if (next === "" || !/[a-z0-9_]/.test(next)) return true;
    from = idx + needle.length;
  }
}

// Whole-word, case-insensitive match for any custom highlight keyword. Empty /
// whitespace keywords are ignored. Used to extend "mentions_only" notifies and
// to bypass DND (a keyword the user explicitly cares about should still ring).
export function hasKeywordMatch(text: string, keywords: string[] | undefined): boolean {
  if (!keywords || keywords.length === 0) return false;
  const lower = text.toLowerCase();
  for (const raw of keywords) {
    const kw = raw.trim().toLowerCase();
    if (!kw) continue;
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(kw, from);
      if (idx === -1) break;
      const before = idx === 0 ? "" : lower.charAt(idx - 1);
      const after = lower.charAt(idx + kw.length);
      const boundedBefore = before === "" || !/[a-z0-9_]/.test(before);
      const boundedAfter = after === "" || !/[a-z0-9_]/.test(after);
      if (boundedBefore && boundedAfter) return true;
      from = idx + kw.length;
    }
  }
  return false;
}

// A PERSONAL highlight = a direct @mention of the user OR a custom keyword they
// asked to be notified for. Deliberately excludes group broadcasts: DND lets
// these through (Slack/Mattermost behavior — DND silences @here but rings on a
// direct ping), while broadcasts are silenced.
function isPersonalHighlight(
  kind: Extract<NotificationKind, { kind: "channel_message" }>,
  ctx: NotifyContext,
): boolean {
  return (
    hasPersonalMention(kind.text, ctx.currentUserName) ||
    hasKeywordMatch(kind.text, ctx.highlightKeywords)
  );
}

// Does this channel message count as a "mention" for the mentions_only gate?
// Honors the per-channel ignore-broadcast flag and custom keywords. (Broader
// than isPersonalHighlight: a non-ignored broadcast still counts here.)
function channelMentionsUser(
  kind: Extract<NotificationKind, { kind: "channel_message" }>,
  ctx: NotifyContext,
): boolean {
  if (isPersonalHighlight(kind, ctx)) return true;
  // Group broadcasts count unless this channel ignores them.
  const ignoreBroadcast = ctx.channelIgnoreBroadcast?.[kind.channelId] ?? false;
  if (!ignoreBroadcast && hasBroadcastMention(kind.text)) return true;
  return false;
}

function decideChannel(
  kind: Extract<NotificationKind, { kind: "channel_message" }>,
  ctx: NotifyContext,
  focused: boolean,
): PolicyDecision {
  if (kind.senderId && kind.senderId === ctx.currentUserId)
    return { notify: false, reason: SKIP.own };
  if (kind.channelId === ctx.activeChannelId && focused)
    return { notify: false, reason: SKIP.viewing };
  // Unknown pref → mentions_only, matching the SERVER default
  // (relay-standalone.ts: `prefs.get(id) ?? "mentions_only"`). The web-push path
  // (closed app) already treats an un-set channel as mentions_only, so the
  // in-app banner must agree: a plain non-mention message in a channel with no
  // explicit pref does NOT banner. This is also the safety net for any channel
  // whose pref hasn't loaded client-side (e.g. a brand-new cross-workspace
  // channel) — it never over-notifies. A channel explicitly set to "all" has a
  // stored pref and still notifies on every message.
  const pref = ctx.channelNotifPrefs[kind.channelId] ?? "mentions_only";
  if (pref === "muted") return { notify: false, reason: SKIP.muted };
  if (pref === "mentions_only" && !channelMentionsUser(kind, ctx)) {
    return { notify: false, reason: SKIP.noMention };
  }
  // DND suppresses everything except a DIRECT personal/keyword mention — group
  // broadcasts (@channel/@here/@all) are silenced under DND.
  if (ctx.dndActive && !isPersonalHighlight(kind, ctx)) {
    return { notify: false, reason: SKIP.dnd };
  }
  return { notify: true, reason: "notify:channel_message" };
}

function decideDmHuman(
  kind: Extract<NotificationKind, { kind: "dm_human" }>,
  ctx: NotifyContext,
  focused: boolean,
): PolicyDecision {
  if (kind.fromUserId === ctx.currentUserId) return { notify: false, reason: SKIP.own };
  if (kind.fromUserId === ctx.viewingDmHumanUserId && focused) {
    return { notify: false, reason: SKIP.viewing };
  }
  if ((ctx.humanDmNotifPrefs[kind.fromUserId] ?? "all") === "muted") {
    return { notify: false, reason: SKIP.muted };
  }
  // DND silences DM banners/sounds too (the message still arrives + badges).
  if (ctx.dndActive) return { notify: false, reason: SKIP.dnd };
  return { notify: true, reason: "notify:dm_human" };
}

function decideDmAgent(
  kind: Extract<NotificationKind, { kind: "dm_agent" }>,
  ctx: NotifyContext,
  focused: boolean,
): PolicyDecision {
  if (kind.remoteAgentId === ctx.viewingDmAgentId && focused) {
    return { notify: false, reason: SKIP.viewing };
  }
  if ((ctx.agentDmNotifPrefs[kind.remoteAgentId] ?? "all") === "muted") {
    return { notify: false, reason: SKIP.muted };
  }
  // DND silences agent-DM banners/sounds too.
  if (ctx.dndActive) return { notify: false, reason: SKIP.dnd };
  return { notify: true, reason: "notify:dm_agent" };
}

export function shouldNotifyFor(kind: NotificationKind, ctx: NotifyContext): PolicyDecision {
  const focused = (ctx.isTabFocused ?? defaultIsTabFocused)();
  switch (kind.kind) {
    case "channel_message":
      return decideChannel(kind, ctx, focused);
    case "dm_human":
      return decideDmHuman(kind, ctx, focused);
    case "dm_agent":
      return decideDmAgent(kind, ctx, focused);
    default:
      // task_assigned / task_review_requested: always notify, but DND silences
      // them too (consistent with channel/DM suppression above).
      if (ctx.dndActive) return { notify: false, reason: SKIP.dnd };
      return { notify: true, reason: `notify:${kind.kind}` };
  }
}
