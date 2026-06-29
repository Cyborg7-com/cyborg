// Composer prompt-template filtering (#602). Small, pure helper the composer's
// slash menu uses to rank a workspace's reusable templates against the typed
// query — the SECONDARY autocomplete group below the channel slash commands.
//
// Reuses the same fuzzy scorer as the channel slash commands (slash-suggest.ts)
// so "/standu" ranks a "Standup" template the same way it ranks the /standup
// command — prefix matches first, then near-misses by edit distance. The fetch +
// caching of the rows themselves lives in state/prompt-templates.svelte.ts; this
// module is the deterministic, unit-testable filter only.

import { fuzzyTriggerScore } from "./slash-suggest.js";
import type { PromptTemplate } from "$lib/core/types.js";

// Max templates shown in the slash menu's secondary group at once (the menu is
// scrollable, but an unbounded list would push the channel commands far off the
// top). Generous for a real workspace; the filter still ranks within it.
export const MAX_TEMPLATE_SUGGESTIONS = 8;

// Templates matching `query` (the text after "/"), ranked like the slash
// commands: a prefix/fuzzy name match scores first (by edit distance), then
// truncated to MAX_TEMPLATE_SUGGESTIONS. An empty query returns the first N
// templates A→Z (the server already lists them sorted by name), so just typing
// "/" surfaces the workspace's templates as a browseable group.
export function matchPromptTemplates(query: string, templates: PromptTemplate[]): PromptTemplate[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return templates.slice(0, MAX_TEMPLATE_SUGGESTIONS);
  return templates
    .map((t) => ({ t, score: fuzzyTriggerScore(q, t.name.toLowerCase()) }))
    .filter((x): x is { t: PromptTemplate; score: number } => x.score !== null)
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_TEMPLATE_SUGGESTIONS)
    .map((x) => x.t);
}
