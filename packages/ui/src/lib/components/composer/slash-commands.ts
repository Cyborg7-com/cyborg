// Channel-composer slash commands (UI registry).
//
// These map 1:1 to the server's slash-command registry (cyborg:slash_command →
// packages/server cyborg/slash-commands.ts). Deliberately separate from the
// AGENT composer's provider slash commands — this menu is for CHANNEL actions.
// Add new entries here as the server grows more builtins (e.g. /actionitems).

import { fuzzyTriggerScore } from "./slash-suggest.js";

// The kind of argument suggestion a command wants for its FIRST positional arg.
//  - "cybo"  → @cybo target picker (the agent autocomplete, agents only).
//  - static  → a fixed list of literal tokens (e.g. languages, counts) the
//              composer can scaffold inline with no backend lookup.
// Commands with no `arg` get free-form args and no suggestion list (unchanged).
export interface ChannelSlashArgSpec {
  // Dynamic picker name (only "cybo" today) OR omit and provide `options`.
  source?: "cybo";
  // Literal suggestions (value = token inserted, label/hint shown).
  options?: { value: string; label?: string; hint?: string }[];
  // Insert the chosen token with this trailing string (default " ").
  trailing?: string;
  // Trigger char that opens this arg picker (default: none → opens on the first
  // arg word). "@" means the picker only opens after the user types "@".
  prefix?: string;
}

export interface ChannelSlashCommand {
  // Keyword without the leading "/", lowercased.
  trigger: string;
  // Optional args hint shown next to the trigger (e.g. "[count]").
  hint?: string;
  description: string;
  // Count-arg semantics, mirroring the server registry (contextMessages /
  // maxContextMessages in packages/server cyborg/slash-commands.ts). Present
  // only on commands whose leading numeric arg picks how many recent messages
  // to read — lets the composer echo how the args will be interpreted BEFORE
  // the command is dispatched.
  defaultCount?: number;
  maxCount?: number;
  // First-argument autocomplete spec (optional). Drives the inline secondary
  // autocomplete in MessageInput so a typed command can suggest/scaffold its
  // arguments (Mattermost AppCommandProvider parity).
  arg?: ChannelSlashArgSpec;
}

export const CHANNEL_SLASH_COMMANDS: ChannelSlashCommand[] = [
  {
    trigger: "summarize",
    hint: "[count]",
    description: "Summarize recent messages in this channel",
    defaultCount: 200,
    maxCount: 1000,
    arg: {
      options: [
        { value: "20", label: "20", hint: "last 20 messages" },
        { value: "50", label: "50", hint: "last 50 messages" },
        { value: "100", label: "100", hint: "last 100 messages" },
      ],
    },
  },
  {
    trigger: "action-items",
    description: "Extract action items from the recent conversation",
    defaultCount: 200,
    maxCount: 1000,
  },
  {
    trigger: "standup",
    description: "Standup summary (done / in progress / blockers)",
    defaultCount: 200,
    maxCount: 1000,
  },
  {
    trigger: "translate",
    hint: "[lang]",
    description: "Translate recent messages (default English)",
    arg: {
      options: [
        { value: "English", label: "English" },
        { value: "Spanish", label: "Spanish" },
        { value: "French", label: "French" },
        { value: "German", label: "German" },
        { value: "Portuguese", label: "Portuguese" },
        { value: "Japanese", label: "Japanese" },
      ],
    },
  },
  {
    trigger: "ask",
    hint: "@cybo <question>",
    description: "Ask a specific cybo a question in this channel",
    arg: { source: "cybo", prefix: "@" },
  },
  {
    // /catchup takes no args — it digests everything since your last_read_at.
    // The result is a personal, ephemeral digest (never posted to the channel).
    trigger: "catchup",
    description: "Summarize everything you missed since you last read this channel",
  },
];

// Commands matching the query: prefix matches first (registry order), then
// fuzzy near-misses ranked by edit distance so "/sumar" still offers summarize.
export function matchChannelSlashCommands(query: string): ChannelSlashCommand[] {
  const q = query.toLowerCase();
  return CHANNEL_SLASH_COMMANDS.map((c) => ({ c, score: fuzzyTriggerScore(q, c.trigger) }))
    .filter((x) => x.score !== null)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
    .map((x) => x.c);
}

// Active first-argument autocomplete context for the composer. Returned by
// detectSlashArgContext when the caret sits in the FIRST argument of a
// registered command that declares an `arg` spec. `query` is the partial token
// (after the prefix char, if any); `start` is the index where the inserted
// suggestion should replace from (so the composer can splice cleanly).
export interface SlashArgContext {
  command: ChannelSlashCommand;
  arg: ChannelSlashArgSpec;
  query: string;
  start: number;
}

// Detect whether the text up to `caret` is "<registered-command> <first-arg…>"
// where the command declares an `arg` spec, and the caret is still inside that
// first argument word. Returns the context (for building suggestions) or null.
//
// Gating rules (so it never fights the main @mention detector):
//  - The text must start with a known command followed by at least one space.
//  - For a prefix arg ("@"), the current token must begin with that prefix; the
//    query is everything after it. For a free arg, the query is the token.
//  - Only the FIRST argument is autocompleted (no whitespace before the token
//    other than the single command/arg separator) — later free-form text is
//    left untouched.
export function detectSlashArgContext(text: string, caret: number): SlashArgContext | null {
  const upto = text.slice(0, caret);
  // "/cmd " then capture the single argument token at the caret (no spaces).
  const m = upto.match(/^\/([a-z0-9-]+)\s+(\S*)$/i);
  if (!m) return null;
  const command = CHANNEL_SLASH_COMMANDS.find((c) => c.trigger === m[1].toLowerCase());
  if (!command?.arg) return null;
  const token = m[2];
  const arg = command.arg;
  if (arg.prefix) {
    if (!token.startsWith(arg.prefix)) return null;
    return {
      command,
      arg,
      query: token.slice(arg.prefix.length),
      start: caret - token.length + arg.prefix.length,
    };
  }
  return { command, arg, query: token, start: caret - token.length };
}

// Parse a submitted composer string ("/summarize 50") into a REGISTERED
// command + args. Returns null when the text isn't a known slash command
// (unknown "/foo" falls through and sends as a normal message).
export function parseChannelSlashInput(
  text: string,
): { command: ChannelSlashCommand; args: string } | null {
  const m = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const command = CHANNEL_SLASH_COMMANDS.find((c) => c.trigger === m[1].toLowerCase());
  if (!command) return null;
  return { command, args: (m[2] ?? "").trim() };
}

// How the server will read a count-command's args. Mirrors the server's
// parseCountArg (cyborg/slash-commands.ts): an optional LEADING integer,
// clamped to [1, max]; anything else in the args is ignored. Exposed so the
// composer can echo the interpretation live instead of duplicating the rules
// in markup.
export interface SlashCountInterpretation {
  // The message count the server will actually use.
  count: number;
  // No leading number → the command default was used.
  usedDefault: boolean;
  // The requested number was reduced to the command max (or raised to 1).
  clamped: boolean;
  // Args text the server will silently drop ("/summarize 10 focus on bugs"
  // → "focus on bugs"; "/summarize focus on bugs" → "focus on bugs").
  ignoredText: string;
}

export function interpretCountArg(
  args: string,
  command: ChannelSlashCommand,
): SlashCountInterpretation | null {
  if (command.defaultCount === undefined || command.maxCount === undefined) return null;
  const m = args.match(/^(\d+)\s*([\s\S]*)$/);
  if (!m) {
    return { count: command.defaultCount, usedDefault: true, clamped: false, ignoredText: args };
  }
  const requested = Number.parseInt(m[1], 10);
  const count = Math.min(Math.max(1, requested), command.maxCount);
  return { count, usedDefault: false, clamped: count !== requested, ignoredText: m[2].trim() };
}

// One-line echo of what a count command will do with N messages, shown live
// in the composer while typing args.
export function describeCountAction(command: ChannelSlashCommand, count: number): string {
  const unit = count === 1 ? "message" : "messages";
  switch (command.trigger) {
    case "summarize":
      return `Will summarize the last ${count} ${unit}`;
    case "action-items":
      return `Will extract action items from the last ${count} ${unit}`;
    case "standup":
      return `Will build the standup from the last ${count} ${unit}`;
    default:
      return `Will read the last ${count} ${unit}`;
  }
}
