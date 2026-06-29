// Identity for the cybo chat view, resolvable from FRAME 0.
//
// The ghost-chat bug: the agent page derived its header/body identity from the
// agents-list row (server-denormalized cybo fields) and the roster lookup by
// the row's cyboId. When either missed — older daemon without denorm, roster
// race, or a spawn that never progressed — the view fell back to the Cyborg
// logo / generic bot icon and NEVER recovered. The cybo's photo and name were
// sitting in the client's roster the whole time.
//
// This resolves identity from three sources, best first:
//   1. the agents-list row's denormalized fields (cyboName/cyboAvatar),
//   2. the roster cybo matched by the row's cyboId,
//   3. the NAVIGATION HINT (?cybo=<id> appended by Start chat / the create
//      dialog) matched against the roster — available before the row settles.
//
// Avatar semantics: cybo avatars are either an image URL or a single emoji.
// The old code dropped emoji avatars entirely (regex → null → Cyborg logo);
// here they come back as `emoji` so the view renders them as text. A cybo with
// no avatar at all gets initials of ITS OWN name (never the Cyborg logo, never
// the bot icon — the placeholder identity must be the cybo's).

import { resolveAvatarSource } from "$lib/utils.js";

export interface ChatIdentityCybo {
  id: string;
  name: string;
  avatar?: string | null;
}

export interface ChatIdentityAgentRow {
  provider?: string | null;
  cyboId?: string | null;
  cyboName?: string | null;
  cyboAvatar?: string | null;
}

export interface CyboChatIdentity {
  // Display name: cybo name when anything cybo-ish is known, else null (caller
  // falls back to its provider/agent naming).
  name: string | null;
  // Image URL avatar, when the avatar is a URL.
  image: string | null;
  // Single-emoji avatar, when the avatar is an emoji.
  emoji: string | null;
  // True when this session is a cybo (any signal) — the view must NEVER show
  // the generic provider/bot fallback for these.
  isCybo: boolean;
}

// Image-vs-emoji split for a cybo avatar. Delegates to the ONE shared
// `resolveAvatarSource` rule (utils.ts) so the chat header, the agents roster,
// and CyboSessionAvatar all agree on what counts as an emoji avatar — no more
// per-surface regex drift. (`name` is irrelevant here: an absent avatar yields
// no image/emoji, and the caller already handles the initials placeholder.)
function split(avatar: string | null | undefined): { image: string | null; emoji: string | null } {
  if (!avatar) return { image: null, emoji: null };
  const source = resolveAvatarSource(avatar, "");
  return source.kind === "emoji" ? { image: null, emoji: avatar } : { image: avatar, emoji: null };
}

export function resolveCyboChatIdentity(opts: {
  agent?: ChatIdentityAgentRow | null;
  // Roster cybo matched by the agent row's cyboId (if any).
  rosterCybo?: ChatIdentityCybo | null;
  // Roster cybo matched by the ?cybo= navigation hint (if any).
  hintedCybo?: ChatIdentityCybo | null;
}): CyboChatIdentity {
  const { agent, rosterCybo, hintedCybo } = opts;
  const cybo = rosterCybo ?? hintedCybo ?? null;
  const isCybo = !!cybo || !!agent?.cyboId || !!agent?.cyboName || !!agent?.cyboAvatar;
  if (!isCybo) return { name: null, image: null, emoji: null, isCybo: false };

  const name = agent?.cyboName ?? cybo?.name ?? null;
  const avatar = agent?.cyboAvatar ?? cybo?.avatar ?? null;
  return { name, ...split(avatar), isCybo: true };
}

// Session-list convenience: resolve a session row's cybo identity against the
// client roster — the fallback that keeps STALE/FAILED sessions (created
// before identity denorm, or whose spawn died before any agent-state sync)
// showing the cybo's own photo/name instead of the Cyborg/bot placeholders.
export function sessionCyboIdentity(
  agent: ChatIdentityAgentRow,
  cybos: readonly ChatIdentityCybo[],
): CyboChatIdentity {
  const rosterCybo = agent.cyboId ? (cybos.find((c) => c.id === agent.cyboId) ?? null) : null;
  return resolveCyboChatIdentity({ agent, rosterCybo });
}
