// ─── Built-in integrations (recipes) registry ──────────────────────────
// A "recipe" is a preset automation. Enabling one provisions a cybo (preset soul
// + platform permissions) + N cron schedules + channel memberships, recorded in
// the installed_recipes table (Stream A). This module is the PURE catalog: it
// declares the three built-in recipes and, for each, a `plan(config)` that maps
// the user's saved config into the concrete provisioning the dispatcher executes
// (createCybo + addCyboToChannel + createSchedule). It performs NO I/O — the
// dispatcher's handleEnableRecipe is the side-effecting caller.
//
// Platform permissions are a CLOSED enum (cybo-types.ts PLATFORM_PERMISSIONS):
// the only WRITE grants a recipe cybo needs are `send_message` (DM/post) and
// `create_task` (which also gates list_tasks/update_task — see cyborg7-mcp-tools).
// Channel READ/react/respond is NOT a grant: it comes from CHANNEL MEMBERSHIP
// (the recipe adds the cybo to its target channel via addCyboToChannel), and the
// workspace roster is readable to any workspace member cybo. So the souls below
// reference "read the roster / read the channel" as *behaviours*, not grants.

import type { PlatformPermission } from "../cybo-types.js";

// One cron schedule the recipe provisions. `targetChannelKey` is the config field
// (e.g. "standupChannelId") whose value is the channel the scheduled run posts to;
// the dispatcher resolves it to a concrete channelId from the saved config.
export interface ScheduleSpec {
  cron: string;
  timezone?: string;
  prompt: string;
  // The config field key holding the channel id this run posts to (resolved by the
  // dispatcher). Null → an unbound schedule (no channel context).
  targetChannelKey: string | null;
  maxRuns?: number;
  catchUp?: boolean;
}

// A user-facing config field for the recipe's "Configure" form (Stream C UI). The
// registry only DECLARES them; the UI renders them and the dispatcher reads their
// saved values out of `config` in plan().
export interface ConfigField {
  key: string;
  label: string;
  type: "channel" | "time" | "cron" | "number" | "multiselect";
  default?: string | number;
}

// The provisioning plan a recipe builds from a user's saved config. The dispatcher
// creates the cybo, adds it to each channelId, and creates each schedule.
export interface RecipePlan {
  cybo: {
    name: string;
    slug: string;
    soul: string;
    provider: "claude";
    model?: string;
    platformPermissions: PlatformPermission[];
  };
  // Channels the provisioned cybo is added to (membership = read/react/respond).
  channelIds: string[];
  schedules: ScheduleSpec[];
}

export interface RecipeDef {
  id: string;
  name: string;
  description: string;
  // A lucide icon name for the recipe card (Stream C UI).
  icon: string;
  configFields: ConfigField[];
  plan(config: Record<string, unknown>): RecipePlan;
}

// Read a string config value by key, or fall back to the field's declared default.
function str(config: Record<string, unknown>, key: string, fallback = ""): string {
  const v = config[key];
  if (typeof v === "string" && v.length > 0) return v;
  return fallback;
}

function num(config: Record<string, unknown>, key: string, fallback: number): number {
  const v = config[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return fallback;
}

// The WRITE grants every recipe cybo needs: post messages + manage tasks. Channel
// read/react/respond is granted by membership (addCyboToChannel), not a grant.
const RECIPE_PERMS: PlatformPermission[] = ["send_message", "create_task"];

// ─── standup ──────────────────────────────────────────────────────────
const standup: RecipeDef = {
  id: "standup",
  name: "Daily Standup",
  description:
    "Each workday a Standup cybo DMs every member three questions, collects the " +
    "answers into per-person standup tasks, and posts a Done / In progress / " +
    "Blockers summary to your standup channel.",
  icon: "sun",
  configFields: [
    { key: "standupChannelId", label: "Standup channel", type: "channel" },
    { key: "sendCron", label: "Ask time", type: "cron", default: "0 9 * * 1-5" },
    { key: "summarizeCron", label: "Summary time", type: "cron", default: "0 10 * * 1-5" },
    { key: "timezone", label: "Timezone", type: "time" },
  ],
  plan(config) {
    const standupChannelId = str(config, "standupChannelId");
    const sendCron = str(config, "sendCron", "0 9 * * 1-5");
    const summarizeCron = str(config, "summarizeCron", "0 10 * * 1-5");
    const timezone = str(config, "timezone") || undefined;
    return {
      cybo: {
        name: "Standup",
        slug: "standup",
        provider: "claude",
        platformPermissions: RECIPE_PERMS,
        soul: [
          "You run the daily standup for this workspace. You have two scheduled runs.",
          "",
          "SEND run (the morning ask):",
          "- Read the workspace roster and DM each HUMAN member directly.",
          "- Ask each person exactly three questions: (1) What did you do yesterday?",
          "  (2) What are you doing today? (3) Any blockers?",
          '- For each member, create one task titled "Standup: <name>" (status pending)',
          "  so there is one task per person to hold their answers.",
          "- When a member DMs you their answers, save them into that member's standup",
          "  task (update the task with their reply).",
          "",
          "SUMMARIZE run (the rollup):",
          "- Read all of today's standup tasks and the answers collected in them.",
          "- Compile a single summary grouped by person under three headings:",
          "  Done, In progress, Blockers.",
          "- Post that summary to the standup channel.",
          "- Then mark today's standup tasks done.",
          "",
          "Be concise and factual. Never invent answers a member did not give —",
          'if someone did not reply, list them under "No update".',
        ].join("\n"),
      },
      channelIds: standupChannelId ? [standupChannelId] : [],
      schedules: [
        {
          cron: sendCron,
          timezone,
          targetChannelKey: "standupChannelId",
          prompt:
            "Run the standup SEND step: DM each human member the three standup " +
            'questions and create one "Standup: <name>" task per member.',
        },
        {
          cron: summarizeCron,
          timezone,
          targetChannelKey: "standupChannelId",
          prompt:
            "Run the standup SUMMARIZE step: read all standup tasks, post a Done / " +
            "In progress / Blockers summary grouped by person to the standup channel, " +
            "then mark the standup tasks done.",
        },
      ],
    };
  },
};

// ─── retro ──────────────────────────────────────────────────────────────
const retro: RecipeDef = {
  id: "retro",
  name: "Weekly Retro",
  description:
    "Each week a Retro cybo DMs every member three retro questions, clusters the " +
    "replies into themes, posts a Wins / Improve / Ideas summary, and files a " +
    "follow-up task for each agreed action item.",
  icon: "repeat",
  configFields: [
    { key: "retroChannelId", label: "Retro channel", type: "channel" },
    { key: "collectCron", label: "Collect time", type: "cron", default: "0 14 * * 5" },
    { key: "summarizeCron", label: "Summary time", type: "cron", default: "0 16 * * 5" },
    { key: "timezone", label: "Timezone", type: "time" },
  ],
  plan(config) {
    const retroChannelId = str(config, "retroChannelId");
    const collectCron = str(config, "collectCron", "0 14 * * 5");
    const summarizeCron = str(config, "summarizeCron", "0 16 * * 5");
    const timezone = str(config, "timezone") || undefined;
    return {
      cybo: {
        name: "Retro",
        slug: "retro",
        provider: "claude",
        platformPermissions: RECIPE_PERMS,
        soul: [
          "You run the weekly retrospective for this workspace. You have two runs.",
          "",
          "COLLECT run:",
          "- Read the workspace roster and DM each HUMAN member directly.",
          "- Ask each person exactly three questions: (1) What went well this week?",
          "  (2) What should we improve? (3) Any ideas?",
          "- Save each member's replies as you receive them.",
          "",
          "SUMMARIZE run:",
          "- Cluster everyone's responses into themes.",
          "- Post a retro summary to the retro channel under three headings:",
          "  Wins, Improve, Ideas.",
          "- For each agreed improvement or action item, create a follow-up task so",
          "  it is tracked into next week.",
          "",
          "Be concise and honest. Group similar points; do not invent feedback no one",
          "gave. Attribute themes, not blame.",
        ].join("\n"),
      },
      channelIds: retroChannelId ? [retroChannelId] : [],
      schedules: [
        {
          cron: collectCron,
          timezone,
          targetChannelKey: "retroChannelId",
          prompt:
            "Run the retro COLLECT step: DM each human member the three retro " +
            "questions (what went well, what to improve, ideas) and save their replies.",
        },
        {
          cron: summarizeCron,
          timezone,
          targetChannelKey: "retroChannelId",
          prompt:
            "Run the retro SUMMARIZE step: cluster the responses into themes, post a " +
            "Wins / Improve / Ideas summary to the retro channel, and create a " +
            "follow-up task for each agreed action item.",
        },
      ],
    };
  },
};

// ─── blocker_sweep ───────────────────────────────────────────────────────
const blocker_sweep: RecipeDef = {
  id: "blocker_sweep",
  name: "Blocker Sweep",
  description:
    "On a schedule a Blocker Sweep cybo finds blocked or stale tasks, DMs each " +
    "owner for a status, and escalates anything still blocked since the last run " +
    "to your escalation channel.",
  icon: "alert-triangle",
  configFields: [
    { key: "escalationChannelId", label: "Escalation channel", type: "channel" },
    { key: "stalenessDays", label: "Stale after (days)", type: "number", default: 2 },
    { key: "sweepCron", label: "Sweep schedule", type: "cron", default: "0 10,16 * * 1-5" },
    { key: "timezone", label: "Timezone", type: "time" },
  ],
  plan(config) {
    const escalationChannelId = str(config, "escalationChannelId");
    const stalenessDays = num(config, "stalenessDays", 2);
    const sweepCron = str(config, "sweepCron", "0 10,16 * * 1-5");
    const timezone = str(config, "timezone") || undefined;
    return {
      cybo: {
        name: "Blocker Sweep",
        slug: "blocker-sweep",
        provider: "claude",
        platformPermissions: RECIPE_PERMS,
        soul: [
          "You sweep for blocked and stale work in this workspace. You run on a",
          "recurring schedule.",
          "",
          "Each run:",
          "- List the open tasks across the workspace that are marked blocked, or",
          `  that have had no update in ${stalenessDays} or more days.`,
          "- DM each such task's owner asking for a status update or what they need to",
          "  get unblocked.",
          "- Track which items you have already nudged by leaving a note on the task",
          '  (e.g. "swept <date>"), so on the next run you can tell a first nudge from',
          "  a repeat.",
          "- If an item was already flagged in a previous run and is STILL blocked or",
          '  stale, escalate it: post an aging "still blocked" list (item, owner, how',
          "  long) to the escalation channel.",
          "",
          "Nudge first, escalate only on repeat. Be specific and respectful — your job",
          "is to unstick work, not to shame people.",
        ].join("\n"),
      },
      channelIds: escalationChannelId ? [escalationChannelId] : [],
      schedules: [
        {
          cron: sweepCron,
          timezone,
          targetChannelKey: "escalationChannelId",
          prompt:
            "Run the blocker sweep: list open blocked/stale tasks across the " +
            "workspace, DM each owner for a status, and escalate anything still blocked " +
            "since a previous run to the escalation channel.",
        },
      ],
    };
  },
};

// The three built-in recipes, keyed by registry id. handleEnableRecipe looks the
// def up by recipeId (404 if absent) and runs def.plan(config).
export const RECIPES: Record<string, RecipeDef> = {
  standup,
  retro,
  blocker_sweep,
};
