// ─── Built-in integrations: recipe display catalog ───────────────────────────
// A static, display-only mirror of the server recipe registry (cyborg/recipes/
// registry.ts). The SERVER registry is the provisioning source of truth; this
// file only drives the UI (card metadata + which config fields to render).
//
// CRITICAL: `recipeId` and every config field `key` MUST stay byte-identical to
// the server registry + the message contract (Stream A). If they drift, the
// Configure page sends config the daemon can't read. Keys, in lockstep:
//   standup       — { standupChannelId, sendCron, summarizeCron, timezone }
//   retro         — { retroChannelId, collectCron, summarizeCron, timezone }
//   blocker_sweep — { escalationChannelId, stalenessDays,
//                     sweepCron, timezone }

// A single configurable field on a recipe. `key` is the config object key sent to
// the daemon verbatim. `type` picks the input widget on the Configure page.
export interface RecipeConfigField {
  key: string;
  label: string;
  // channel  → reuse the channel <Select>; the value is a channel id.
  // cron      → a text field prefilled with `default`, with a friendly cron label.
  // number    → a numeric input (e.g. staleness days).
  // timezone  → a text field (IANA tz) prefilled from the browser default.
  type: "channel" | "cron" | "number" | "timezone";
  // Short helper text under the field.
  hint?: string;
  // Prefilled default. Crons are 5-field expressions; timezone falls back to the
  // browser tz when `default` is empty.
  default?: string | number;
  // number fields only.
  min?: number;
}

export interface RecipeCatalogEntry {
  // Registry id — the `recipeId` on the wire. NEVER rename without the server.
  recipeId: string;
  name: string;
  description: string;
  // Inline-SVG icon key (rendered by RecipeIcon.svelte — matches the GitHub-card
  // icon-tile pattern: a lucide-shaped glyph in currentColor).
  icon: "standup" | "retro" | "blocker_sweep";
  configFields: RecipeConfigField[];
}

// The local timezone, used as the default for every recipe's `timezone` field.
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export const RECIPE_CATALOG: RecipeCatalogEntry[] = [
  {
    recipeId: "standup",
    name: "Daily Standup",
    description:
      "A cybo DMs each member the three standup questions, then posts a Done / In progress / Blockers summary to a channel.",
    icon: "standup",
    configFields: [
      {
        key: "standupChannelId",
        label: "Standup channel",
        type: "channel",
        hint: "Where the daily summary is posted.",
      },
      {
        key: "sendCron",
        label: "Ask cadence",
        type: "cron",
        hint: "When the cybo DMs each member their standup questions.",
        default: "0 9 * * 1-5",
      },
      {
        key: "summarizeCron",
        label: "Summarize cadence",
        type: "cron",
        hint: "When the cybo compiles + posts the summary.",
        default: "0 10 * * 1-5",
      },
      {
        key: "timezone",
        label: "Timezone",
        type: "timezone",
        hint: "The cadences run in this timezone.",
      },
    ],
  },
  {
    recipeId: "retro",
    name: "Weekly Retro",
    description:
      "A cybo collects what went well / what to improve / ideas from each member, then posts a clustered retro summary and opens follow-up tasks.",
    icon: "retro",
    configFields: [
      {
        key: "retroChannelId",
        label: "Retro channel",
        type: "channel",
        hint: "Where the retro summary is posted.",
      },
      {
        key: "collectCron",
        label: "Collect cadence",
        type: "cron",
        hint: "When the cybo DMs each member the retro questions.",
        default: "0 14 * * 5",
      },
      {
        key: "summarizeCron",
        label: "Summarize cadence",
        type: "cron",
        hint: "When the cybo clusters responses + posts the summary.",
        default: "0 16 * * 5",
      },
      {
        key: "timezone",
        label: "Timezone",
        type: "timezone",
        hint: "The cadences run in this timezone.",
      },
    ],
  },
  {
    recipeId: "blocker_sweep",
    name: "Blocker Sweep",
    description:
      "A cybo sweeps for blocked or stale tasks, nudges each owner, and escalates anything still stuck to an escalation channel.",
    icon: "blocker_sweep",
    configFields: [
      {
        key: "escalationChannelId",
        label: "Escalation channel",
        type: "channel",
        hint: "Where still-blocked items are escalated.",
      },
      {
        key: "stalenessDays",
        label: "Staleness threshold (days)",
        type: "number",
        hint: "A task with no update for this many days counts as stale.",
        default: 2,
        min: 1,
      },
      {
        key: "sweepCron",
        label: "Sweep cadence",
        type: "cron",
        hint: "When the cybo runs a sweep.",
        default: "0 10,16 * * 1-5",
      },
      {
        key: "timezone",
        label: "Timezone",
        type: "timezone",
        hint: "The cadence runs in this timezone.",
      },
    ],
  },
];

export function recipeById(recipeId: string): RecipeCatalogEntry | undefined {
  return RECIPE_CATALOG.find((r) => r.recipeId === recipeId);
}

// The default config object for a recipe (used to seed the Configure form for a
// not-yet-installed recipe). Channel fields start empty (the user must pick).
export function defaultRecipeConfig(entry: RecipeCatalogEntry): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of entry.configFields) {
    if (field.type === "channel") config[field.key] = "";
    else if (field.type === "timezone") config[field.key] = field.default ?? browserTimezone();
    else if (field.default !== undefined) config[field.key] = field.default;
  }
  return config;
}
