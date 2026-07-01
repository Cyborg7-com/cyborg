// Bidirectional map between Cyborg's reaction key (a raw Unicode emoji char, e.g.
// "👍") and Slack's reaction name (a bare shortname, e.g. "thumbsup" / "+1" / "heart").
//
// Why a self-contained table lives here (not an import):
//   - The UI's emoji catalog (packages/ui/src/lib/emoji.ts) is off-limits to the
//     server AND the relay runs tsx-from-source, so it can't import build-only
//     packages. The reaction bridge therefore carries its OWN curated map.
//   - It covers the common reaction set (hands, faces, hearts, frequent symbols).
//     An UNMAPPED name/emoji returns null and the caller no-ops QUIETLY — a reaction
//     is never dropped destructively, it simply isn't mirrored across the bridge.
//
// Skin-tone + presentation handling:
//   - Slack sends skin-toned reactions as "name::skin-tone-N"; we map the BASE name.
//   - A Cyborg emoji may carry a skin-tone modifier (U+1F3FB..U+1F3FF) and/or a
//     VS16 presentation selector (U+FE0F); both are stripped before the lookup so
//     "👍🏽" and "❤️" resolve to their base Slack names.

// One row per emoji: [unicode, primarySlackName, ...aliases]. The primary name is what
// emojiToSlackName returns; every alias also resolves inbound via slackNameToEmoji.
// Keep this list conservative + correct — a wrong mapping is worse than an absent one.
const EMOJI_TABLE: readonly (readonly [string, string, ...string[]])[] = [
  // Hands / gestures — the overwhelming majority of real reactions.
  ["👍", "+1", "thumbsup"],
  ["👎", "-1", "thumbsdown"],
  ["👌", "ok_hand"],
  ["👏", "clap"],
  ["🙌", "raised_hands"],
  ["🙏", "pray"],
  ["🤝", "handshake"],
  ["✋", "hand", "raised_hand"],
  ["🖐️", "raised_hand_with_fingers_splayed"],
  ["✌️", "v"],
  ["🤞", "crossed_fingers"],
  ["🤟", "i_love_you_hand_sign"],
  ["🤘", "the_horns"],
  ["🤙", "call_me_hand"],
  ["👋", "wave"],
  ["💪", "muscle"],
  ["🫡", "saluting_face"],
  ["👀", "eyes"],
  ["👆", "point_up_2"],
  ["👇", "point_down"],
  ["👈", "point_left"],
  ["👉", "point_right"],
  ["✍️", "writing_hand"],
  ["🤌", "pinched_fingers"],
  // Faces.
  ["😀", "grinning"],
  ["😃", "smiley"],
  ["😄", "smile"],
  ["😁", "grin"],
  ["😆", "laughing", "satisfied"],
  ["😅", "sweat_smile"],
  ["🤣", "rolling_on_the_floor_laughing", "rofl"],
  ["😂", "joy"],
  ["🙂", "slightly_smiling_face"],
  ["🙃", "upside_down_face"],
  ["😉", "wink"],
  ["😊", "blush"],
  ["😇", "innocent"],
  ["🥰", "smiling_face_with_3_hearts"],
  ["😍", "heart_eyes"],
  ["🤩", "star-struck"],
  ["😘", "kissing_heart"],
  ["😗", "kissing"],
  ["😜", "stuck_out_tongue_winking_eye"],
  ["🤪", "zany_face"],
  ["🤨", "face_with_raised_eyebrow"],
  ["🧐", "face_with_monocle"],
  ["🤓", "nerd_face"],
  ["😎", "sunglasses"],
  ["🥳", "partying_face"],
  ["😏", "smirk"],
  ["😒", "unamused"],
  ["😞", "disappointed"],
  ["😔", "pensive"],
  ["😟", "worried"],
  ["🙁", "slightly_frowning_face"],
  ["😣", "persevere"],
  ["😖", "confounded"],
  ["😫", "tired_face"],
  ["😩", "weary"],
  ["🥺", "pleading_face"],
  ["😢", "cry"],
  ["😭", "sob"],
  ["😤", "triumph"],
  ["😠", "angry"],
  ["😡", "rage"],
  ["🤯", "exploding_head"],
  ["😳", "flushed"],
  ["🥵", "hot_face"],
  ["🥶", "cold_face"],
  ["😱", "scream"],
  ["😨", "fearful"],
  ["😰", "cold_sweat"],
  ["😥", "disappointed_relieved"],
  ["🤔", "thinking_face"],
  ["🤗", "hugging_face"],
  ["🤫", "shushing_face"],
  ["🤭", "face_with_hand_over_mouth"],
  ["😴", "sleeping"],
  ["😪", "sleepy"],
  ["😵", "dizzy_face"],
  ["🤐", "zipper_mouth_face"],
  ["🥴", "woozy_face"],
  ["🤢", "nauseated_face"],
  ["🤮", "face_vomiting"],
  ["🤧", "sneezing_face"],
  ["😷", "mask"],
  ["🤒", "face_with_thermometer"],
  ["😬", "grimacing"],
  ["🙄", "face_with_rolling_eyes"],
  ["😐", "neutral_face"],
  ["😑", "expressionless"],
  ["😶", "no_mouth"],
  ["🥱", "yawning_face"],
  ["🤥", "lying_face"],
  ["🤠", "face_with_cowboy_hat"],
  ["🥲", "smiling_face_with_tear"],
  // Hearts + symbols.
  ["❤️", "heart"],
  ["🧡", "orange_heart"],
  ["💛", "yellow_heart"],
  ["💚", "green_heart"],
  ["💙", "blue_heart"],
  ["💜", "purple_heart"],
  ["🖤", "black_heart"],
  ["🤍", "white_heart"],
  ["🤎", "brown_heart"],
  ["💔", "broken_heart"],
  ["❣️", "heavy_heart_exclamation_mark_ornament"],
  ["💕", "two_hearts"],
  ["💞", "revolving_hearts"],
  ["💓", "heartbeat"],
  ["💗", "heartpulse"],
  ["💖", "sparkling_heart"],
  ["💘", "cupid"],
  ["💝", "gift_heart"],
  ["💯", "100"],
  ["💢", "anger"],
  ["💥", "boom", "collision"],
  ["💫", "dizzy"],
  ["💦", "sweat_drops"],
  ["💨", "dash"],
  ["🔥", "fire"],
  ["⭐", "star"],
  ["🌟", "star2"],
  ["✨", "sparkles"],
  ["⚡", "zap"],
  ["☀️", "sunny"],
  ["🎉", "tada"],
  ["🎊", "confetti_ball"],
  ["🎈", "balloon"],
  ["🎁", "gift"],
  ["🏆", "trophy"],
  ["🏅", "medal"],
  ["🥇", "first_place_medal"],
  ["🚀", "rocket"],
  ["👑", "crown"],
  ["💎", "gem"],
  ["🔔", "bell"],
  ["✅", "white_check_mark"],
  ["☑️", "ballot_box_with_check"],
  ["✔️", "heavy_check_mark"],
  ["❌", "x"],
  ["❎", "negative_squared_cross_mark"],
  ["⚠️", "warning"],
  ["❓", "question"],
  ["❗", "exclamation", "heavy_exclamation_mark"],
  ["‼️", "bangbang"],
  ["💤", "zzz"],
  ["👁️", "eye"],
  ["🧠", "brain"],
  ["🤖", "robot_face"],
  ["👻", "ghost"],
  ["💩", "hankey", "poop", "shit"],
  ["🎯", "dart"],
  ["🔒", "lock"],
  ["🔑", "key"],
  ["📌", "pushpin"],
  ["📎", "paperclip"],
  ["💡", "bulb"],
  ["🐛", "bug"],
  // Food / misc frequent.
  ["☕", "coffee"],
  ["🍺", "beer"],
  ["🍻", "beers"],
  ["🍕", "pizza"],
  ["🍰", "cake"],
  ["🎂", "birthday"],
];

// name (lowercase, colon-stripped, skin-tone-stripped) → unicode.
const NAME_TO_EMOJI = new Map<string, string>();
// unicode (presentation-normalized) → primary Slack name.
const EMOJI_TO_NAME = new Map<string, string>();

for (const [emoji, primary, ...aliases] of EMOJI_TABLE) {
  if (!EMOJI_TO_NAME.has(normalizeEmoji(emoji))) {
    EMOJI_TO_NAME.set(normalizeEmoji(emoji), primary);
  }
  for (const name of [primary, ...aliases]) {
    if (!NAME_TO_EMOJI.has(name)) NAME_TO_EMOJI.set(name, emoji);
  }
}

// Strip a VS16 presentation selector (U+FE0F) and any skin-tone modifier
// (U+1F3FB..U+1F3FF) so a decorated Cyborg emoji resolves to its base Slack name.
function normalizeEmoji(emoji: string): string {
  // VS16 (U+FE0F) is stripped separately from the skin-tone range: a combining selector
  // inside a character class trips no-misleading-character-class.
  return emoji.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "").replace(/\uFE0F/gu, "");
}

// Strip Slack's "::skin-tone-N" suffix and a surrounding pair of colons, lowercased,
// so "Thumbsup", ":thumbsup:", and "thumbsup::skin-tone-3" all resolve to the base.
function normalizeSlackName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/::skin-tone-\d+$/u, "")
    .replace(/^:|:$/gu, "");
}

/**
 * Map a Slack reaction name (as delivered on a reaction_added/removed event, e.g.
 * "thumbsup", "+1", "heart", or a skin-toned "thumbsup::skin-tone-2") to Cyborg's
 * Unicode reaction key. Returns null for a custom/workspace emoji or one absent from
 * the curated table — the caller then no-ops quietly (no destructive drop).
 */
export function slackNameToEmoji(name: string): string | null {
  if (!name) return null;
  return NAME_TO_EMOJI.get(normalizeSlackName(name)) ?? null;
}

/**
 * Map a Cyborg Unicode reaction key (e.g. "👍", "❤️", "👍🏽") to the Slack reaction
 * name for reactions.add/remove. Presentation selector + skin-tone modifiers are
 * stripped to the base. Returns null when the emoji isn't in the curated table — the
 * caller then skips the outbound mirror rather than posting an invalid name.
 */
export function emojiToSlackName(emoji: string): string | null {
  if (!emoji) return null;
  return EMOJI_TO_NAME.get(normalizeEmoji(emoji)) ?? null;
}
