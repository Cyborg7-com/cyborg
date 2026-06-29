// AI channel slash-command services (action-items / standup / translate).
//
// Same shape as the summarization service (summarization.ts): a pure function
// over a pre-formatted transcript + an injected `Completer` (one LLM call). The
// dispatcher fetches recent channel messages from PG, formats them with
// `formatTranscript`, and the daemon's ephemeral-agent completer runs the call.
// Single-pass (no map-reduce) — the dispatcher bounds the message count, and the
// completer's agent owns a large context window. Keep prompts terse + on-task.

import { channelGuidelinesBlock, type Completer } from "./summarization.js";

export interface ChannelAiOptions {
  // Pre-formatted "[time] sender: text" transcript (see formatTranscript).
  transcript: string;
  channelName: string;
  complete: Completer;
  // The channel's agent guidelines (channels.instructions). Appended to the
  // system prompt as format/limit guidance (see channelGuidelinesBlock). Not
  // applied to /translate — its output contract is a verbatim translation, so
  // format guidelines would corrupt it.
  channelInstructions?: string | null;
}

export interface TranslateOptions extends ChannelAiOptions {
  // Target language as the user typed it (e.g. "spanish", "fr"). Defaults to
  // English when blank.
  targetLang: string;
}

const ACTION_ITEMS_SYSTEM = [
  "You extract concrete, actionable items from a chat transcript.",
  "Output ONLY a markdown checklist (`- [ ] …`), one item per task or follow-up.",
  "Each item: imperative phrasing, and attribute the owner in parentheses when",
  "the transcript makes it clear (e.g. `- [ ] Ship the relay fix (Rodrigo)`).",
  "Skip chit-chat, questions already answered, and anything not actionable.",
  "If there are no action items, reply with exactly: `No action items found.`",
].join(" ");

const STANDUP_SYSTEM = [
  "You write a concise daily-standup summary from a chat transcript.",
  "Use exactly these three markdown sections, in order, each an h4 heading:",
  "`#### Done`, `#### In progress`, `#### Blockers`.",
  "Under each, terse bullet points; attribute people in parentheses when clear.",
  "Omit a section's bullets (but keep the heading) when there is nothing for it.",
  "Base it only on what the transcript actually says — do not invent progress.",
].join(" ");

function translateSystem(targetLang: string): string {
  return [
    `You are a translator. Translate the chat transcript into ${targetLang}.`,
    "Preserve each line's `sender:` attribution and message order; translate ONLY",
    "the message text, not the sender names. Keep markdown/code blocks intact and",
    "do not translate code. Output only the translated transcript — no preamble.",
  ].join(" ");
}

function userPayload(channelName: string, transcript: string): string {
  return `Channel: #${channelName}\n\nTranscript:\n${transcript}`;
}

export async function extractActionItems(opts: ChannelAiOptions): Promise<string> {
  return opts.complete(
    ACTION_ITEMS_SYSTEM + channelGuidelinesBlock(opts.channelInstructions),
    userPayload(opts.channelName, opts.transcript),
  );
}

export async function generateStandup(opts: ChannelAiOptions): Promise<string> {
  return opts.complete(
    STANDUP_SYSTEM + channelGuidelinesBlock(opts.channelInstructions),
    userPayload(opts.channelName, opts.transcript),
  );
}

export async function translateMessages(opts: TranslateOptions): Promise<string> {
  const lang = opts.targetLang.trim() || "English";
  return opts.complete(translateSystem(lang), userPayload(opts.channelName, opts.transcript));
}
