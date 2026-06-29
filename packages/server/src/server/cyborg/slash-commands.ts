// Thin slash-command registry for group channels.
//
// Per internal docs Part 3 (Mattermost): the primary way to invoke agents is
// @mention + UI affordances, NOT a slash DSL. So this layer stays deliberately
// thin — it parses the trigger and routes to a handler by `kind`. The real value
// lives in the services those handlers call (e.g. the summarization service).

export type SlashCommandKind =
  | "summary"
  | "action_items"
  | "standup"
  | "translate"
  | "ask"
  | "catchup";

export interface SlashCommand {
  // Keyword without the leading "/", lowercased.
  trigger: string;
  description: string;
  // Args hint shown next to the trigger in the composer autocomplete (e.g.
  // "[count]"). Mirrors the live client catalog in
  // packages/ui/.../composer/slash-commands.ts (CHANNEL_SLASH_COMMANDS).
  hint?: string;
  // How the dispatcher executes this command.
  kind: SlashCommandKind;
  // Default number of recent channel messages to fetch as input (0 = none).
  contextMessages: number;
  // Hard cap on the count a user may request via the numeric arg.
  maxContextMessages: number;
}

export const summarizeCommand: SlashCommand = {
  trigger: "summarize",
  description: "Summarize the recent conversation in this channel",
  hint: "[count]",
  kind: "summary",
  // Fetch a generous window; the summarization service token-gates + map-reduces.
  contextMessages: 200,
  maxContextMessages: 1000,
};

export const actionItemsCommand: SlashCommand = {
  trigger: "action-items",
  description: "Extract action items from the recent conversation",
  kind: "action_items",
  contextMessages: 200,
  maxContextMessages: 1000,
};

export const standupCommand: SlashCommand = {
  trigger: "standup",
  description: "Generate a standup summary (done / in progress / blockers)",
  kind: "standup",
  contextMessages: 200,
  maxContextMessages: 1000,
};

export const translateCommand: SlashCommand = {
  trigger: "translate",
  description: "Translate the recent messages into a language (default English)",
  hint: "[lang]",
  kind: "translate",
  contextMessages: 100,
  maxContextMessages: 500,
};

export const askCommand: SlashCommand = {
  trigger: "ask",
  description: "Ask a specific cybo a question in this channel",
  hint: "@cybo <question>",
  kind: "ask",
  // /ask invokes a named cybo directly — it reads no channel history.
  contextMessages: 0,
  maxContextMessages: 0,
};

// /catchup digests what the CALLER missed since their last_read_at in this
// channel (the per-user unread cursor), NOT a fixed recent-N window — so it
// takes no count arg. The reply is EPHEMERAL to the caller (a personal digest
// would pollute the very channel it summarizes if posted). The 500 cap bounds
// the since-last-read slice the summarizer token-gates + map-reduces.
export const catchupCommand: SlashCommand = {
  trigger: "catchup",
  description: "Summarize everything you missed in this channel since you last read it",
  kind: "catchup",
  // Window is defined by last_read_at, not a count → contextMessages unused (0);
  // maxContextMessages caps the since-last-read slice.
  contextMessages: 0,
  maxContextMessages: 500,
};

const REGISTRY = new Map<string, SlashCommand>(
  [
    summarizeCommand,
    actionItemsCommand,
    standupCommand,
    translateCommand,
    askCommand,
    catchupCommand,
  ].map((c) => [c.trigger, c]),
);

export function getSlashCommand(trigger: string): SlashCommand | undefined {
  return REGISTRY.get(trigger.toLowerCase());
}

export function listSlashCommands(): SlashCommand[] {
  return [...REGISTRY.values()];
}

// Parse a raw composer string ("/summarize 50") into trigger + args.
// Returns null when the text is not a slash command.
export function parseSlashCommand(text: string): { trigger: string; args: string } | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const match = trimmed.slice(1).match(/^(\S+)\s*([\s\S]*)$/);
  if (!match) return null;
  return { trigger: match[1].toLowerCase(), args: match[2].trim() };
}

export interface ParsedCountArg {
  count: number;
  // Set when the requested number fell outside [1, max] and was clamped.
  clamped?: { from: number; to: number };
  // Trailing (or whole-args) free text the count-only command discards.
  ignoredText?: string;
}

// Read an optional leading integer count from args (e.g. "50" or "50 foo"),
// clamped to [1, max], reporting what was clamped/discarded so the caller can
// surface it instead of silently dropping it. Falls back to `fallback` when no
// number is present. The number match stays anchored to the RAW string (no
// pre-trim) so parseCountArg keeps exact byte parity with its original form;
// only the reported ignoredText is trimmed for display.
export function parseCountArgDetailed(args: string, fallback: number, max: number): ParsedCountArg {
  const m = args.match(/^(\d+)\s*([\s\S]*)$/);
  if (!m) {
    const ignored = args.trim();
    return { count: fallback, ...(ignored ? { ignoredText: ignored } : {}) };
  }
  const requested = Number.parseInt(m[1], 10);
  const count = Math.min(Math.max(1, requested), max);
  const ignored = m[2].trim();
  return {
    count,
    ...(count !== requested ? { clamped: { from: requested, to: count } } : {}),
    ...(ignored ? { ignoredText: ignored } : {}),
  };
}

// Back-compat count-only form.
export function parseCountArg(args: string, fallback: number, max: number): number {
  return parseCountArgDetailed(args, fallback, max).count;
}

// Human-readable warnings for a dirty count arg ("/summarize 99999", "/standup
// focus on bugs"). Returned in the dispatch ack's optional `warnings` field —
// ephemeral, requester-only, never persisted.
export function describeCountArgWarnings(parsed: ParsedCountArg, trigger: string): string[] {
  const warnings: string[] = [];
  if (parsed.clamped) {
    const bound = parsed.clamped.from > parsed.clamped.to ? "max" : "min";
    warnings.push(`Used count=${parsed.clamped.to} (${bound} ${parsed.clamped.to}).`);
  }
  if (parsed.ignoredText) {
    const text =
      parsed.ignoredText.length > 60 ? `${parsed.ignoredText.slice(0, 57)}…` : parsed.ignoredText;
    warnings.push(
      `"${text}" was ignored — /${trigger} only takes a message count. For free-form questions, use /ask.`,
    );
  }
  return warnings;
}

// Plain Levenshtein distance. Twin of packages/ui .../composer/slash-suggest.ts
// (no shared package between server and ui — keep in sync).
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0 || b.length === 0) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

// Closest registered trigger within edit distance 2 ("sumarize" → "summarize"),
// or null when nothing is close. Used to build the unknown-trigger ack.
export function suggestSlashTrigger(trigger: string): string | null {
  const q = trigger.toLowerCase();
  let best: string | null = null;
  let bestDist = Infinity;
  for (const t of REGISTRY.keys()) {
    const d = editDistance(q, t);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return best && bestDist <= 2 ? best : null;
}

// The RPC-ack error for an unknown trigger. The composer normally blocks these
// client-side, but CLI/API callers hit the dispatcher directly — they get an
// explicit error (never a silent drop), with a "did you mean" when close.
export function unknownSlashTriggerError(trigger: string): string {
  const suggestion = suggestSlashTrigger(trigger);
  const hint = suggestion ? ` Did you mean "/${suggestion}"?` : "";
  const available = [...REGISTRY.keys()].map((t) => `/${t}`).join(", ");
  return `Unknown command "/${trigger}".${hint} Available commands: ${available}.`;
}
