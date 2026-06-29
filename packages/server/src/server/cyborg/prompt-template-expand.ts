// Composer prompt-template expansion (#602). A workspace member authors a
// reusable template BODY (e.g. "Standup for {channel} on {date} — @{user}"); on
// SEND the server substitutes the supported placeholders with the FINAL message
// context (the channel it's posted to, the sender, today's date). This is the
// composer feature — DISTINCT from webhook-cybo-fire.ts's renderPromptTemplate
// (which renders a HOSTILE webhook payload into a cybo fire prompt).
//
// SECURITY: the template body itself is TRUSTED (a workspace member wrote it),
// but the substituted CONTEXT VALUES are not fully trusted — a channel name or a
// display name can contain markup, backticks, or newlines (a user can rename a
// channel to "</code><script>", or set a display name with a fenced block). The
// expanded body is later markdown-rendered + DOMPurify-sanitized in the client,
// but we harden at the SUBSTITUTION layer too (defense in depth):
//   1. escapePayloadValue() (REUSED from webhook-cybo-fire.ts) — the same #437
//      hardening: collapse newlines/whitespace so a value can't forge a new
//      instruction line, neutralize backtick runs so it can't open/close a code
//      fence, strip control chars, and cap length.
//   2. HTML-escape the result (`& < > " '`) so a value can't inject raw markup
//      even before the renderer's sanitizer runs.
// Only the THREE known placeholders are substituted; every other `{...}` is left
// verbatim (so literal braces in a template survive) and reported by
// validatePromptTemplate as an unknown-variable WARNING at author time.

import { escapePayloadValue } from "./webhook-cybo-fire.js";
import type { StoredPromptTemplate } from "./storage.js";

// Supported placeholders (case-insensitive). Keep in sync with the author-time
// validator's KNOWN_VARS and the UI's template hint.
export type PromptTemplateVar = "channel" | "user" | "date";

export interface PromptTemplateContext {
  // The channel name the message is being posted to (DMs may omit it).
  channel?: string;
  // The sender's display name (or email/handle) — who is sending.
  user?: string;
  // Pre-formatted date string for {date}. The CALLER formats it (the send path
  // owns the workspace/user locale + the "now" clock) so this module stays pure
  // and deterministic; when omitted, {date} expands to "".
  date?: string;
}

// Max length of a template body (author-time + a backstop in expand). Generous
// for a multi-paragraph snippet but bounded so a pathological body can't blow the
// message size. Matches the create/update RPC's zod cap (1..10_000).
export const MAX_TEMPLATE_LEN = 10_000;

// `{var}` placeholders — a single brace pair around an ASCII-letter word, with
// optional inner whitespace ("{ channel }"). Bounded charset + length so the
// regex can never run on unbounded input (no ReDoS). Matched case-insensitively;
// the captured name is lowercased before lookup.
const PLACEHOLDER_RE = /\{\s*([a-zA-Z]{1,32})\s*\}/g;

// The known placeholder set, for O(1) membership tests in expand + validate.
const KNOWN_VARS = new Set<PromptTemplateVar>(["channel", "user", "date"]);

// HTML-escape a single (already payload-escaped) value. Ampersand FIRST so an
// already-escaped entity isn't double-escaped wrongly, then the angle brackets +
// quotes a renderer could otherwise interpret as markup/attributes.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Resolve one placeholder name to its context value, HARDENED (payload-escape +
// HTML-escape). An unknown name returns null so the caller leaves the literal
// `{name}` in place. A known-but-absent value (e.g. {date} with no date in ctx)
// resolves to "" (the placeholder is removed), matching the webhook renderer's
// "missing → empty" behavior.
function resolveVar(name: string, ctx: PromptTemplateContext): string | null {
  const key = name.toLowerCase();
  if (!KNOWN_VARS.has(key as PromptTemplateVar)) return null;
  const raw = ctx[key as PromptTemplateVar];
  // escapePayloadValue handles undefined → "" itself; then HTML-escape.
  return escapeHtml(escapePayloadValue(raw));
}

// Expand a template body for the FINAL send context: substitute every
// {channel}/{user}/{date} (case-insensitive) with the hardened context value,
// leaving any unknown `{...}` token verbatim. Pure + deterministic (the caller
// supplies the formatted date), so it is fully unit-testable.
export function expandPromptTemplate(body: string, ctx: PromptTemplateContext): string {
  const expanded = body.replace(PLACEHOLDER_RE, (match, name: string) => {
    const value = resolveVar(name, ctx);
    return value === null ? match : value;
  });
  // Backstop cap (the body is already capped at author time, but a substitution
  // could in theory grow it past the limit).
  return expanded.length > MAX_TEMPLATE_LEN ? `${expanded.slice(0, MAX_TEMPLATE_LEN)}…` : expanded;
}

// Author-time validation result for a template body. `ok` gates the create/update
// RPC; `unknownVars` is a non-blocking WARNING (a typo'd "{usr}" or a literal
// "{json}" the author meant to keep) surfaced to the UI so the author can fix it
// before saving — unknown vars are NEVER substituted, they pass through verbatim.
export interface PromptTemplateValidation {
  ok: boolean;
  // Set only when ok === false (empty body or over the length cap).
  error?: string;
  // Distinct unknown placeholder names found (lowercased, de-duplicated, in first-
  // seen order). Empty when every `{...}` is a known var or there are none.
  unknownVars: string[];
}

// Validate a template body: non-empty after trim, within MAX_TEMPLATE_LEN, and
// collect any UNKNOWN `{var}` names as a warning. Known vars + literal text are
// fine. Used by the create/update RPC (hard-fails on !ok) and exposed to the UI.
export function validatePromptTemplate(body: string): PromptTemplateValidation {
  const unknownVars: string[] = [];
  // Length check FIRST, before matchAll runs over the raw (untrusted) input — the
  // relay calls this directly on websocket input, so an oversized body must be
  // rejected immediately rather than scanned by the regex (DoS backstop).
  if (body.length > MAX_TEMPLATE_LEN) {
    return {
      ok: false,
      error: `Template body is too long (max ${MAX_TEMPLATE_LEN} characters).`,
      unknownVars,
    };
  }
  const seen = new Set<string>();
  for (const m of body.matchAll(PLACEHOLDER_RE)) {
    const name = m[1].toLowerCase();
    if (!KNOWN_VARS.has(name as PromptTemplateVar) && !seen.has(name)) {
      seen.add(name);
      unknownVars.push(name);
    }
  }
  if (body.trim().length === 0) {
    return { ok: false, error: "Template body is required.", unknownVars };
  }
  return { ok: true, unknownVars };
}

// Format a Date for the {date} placeholder: a locale-stable, unambiguous
// ISO-8601 calendar date (YYYY-MM-DD) in UTC. The send path owns the "now"
// clock and calls this so expandPromptTemplate itself stays pure/deterministic
// (it takes a pre-formatted string). UTC (not a server-local zone) so the value
// doesn't drift with the relay/daemon host's timezone.
export function formatTemplateDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// Map a stored row to the wire view the client expects (epoch-ms createdAt).
// Shared shape across the dispatcher + relay list/create/update responses.
export function promptTemplateView(row: StoredPromptTemplate): {
  id: string;
  workspaceId: string;
  name: string;
  body: string;
  createdBy: string | null;
  createdAt: number;
} {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    body: row.body,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
