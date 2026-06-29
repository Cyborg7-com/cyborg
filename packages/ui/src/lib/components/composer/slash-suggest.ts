// Edit-distance helpers shared by the composer's unknown-trigger guard
// (MessageInput blocks "/sumarize 10" with a "did you mean /summarize?" prompt
// instead of posting the typo publicly) and the slash menu's fuzzy ranking
// (typing "/sumar" still offers summarize).
//
// The server's unknown-trigger ack builds the same suggestion with a twin of
// editDistance in packages/server cyborg/slash-commands.ts — there is no shared
// package between server and ui, so keep the two in sync.

// Plain Levenshtein distance (insert/delete/substitute, all cost 1).
export function editDistance(a: string, b: string): number {
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

// The trigger token IF the text plausibly is a slash command: a leading "/"
// followed by a letter-initial word, then end-of-text or whitespace. Anything
// else returns null and sends as plain text — "/etc/hosts", "//cdn", "/ hi",
// "x /summarize" are NOT commands (the word must START the message and not
// contain a second slash).
export function extractSlashTriggerCandidate(text: string): string | null {
  const m = text.match(/^\/([a-z][a-z0-9-]*)(?:\s|$)/i);
  return m ? m[1].toLowerCase() : null;
}

const FUZZY_MAX_DISTANCE = 2;

// Fuzzy score of a menu query against a trigger: 0 for a prefix match (the
// pre-existing behavior), otherwise the distance between the query and the
// same-length prefix of the trigger ("sumar" vs "summa[rize]" → 2). null means
// "don't show". Short queries stay prefix-only — at 1-2 chars everything is
// within distance 2 of everything, and at 3-4 a single typo is already the
// whole signal — so the threshold scales with query length.
export function fuzzyTriggerScore(query: string, trigger: string): number | null {
  const q = query.toLowerCase();
  if (trigger.startsWith(q)) return 0;
  if (q.length < 3) return null;
  const max = q.length <= 4 ? 1 : FUZZY_MAX_DISTANCE;
  const d = editDistance(q, trigger.slice(0, q.length));
  return d <= max ? d : null;
}

// Best "did you mean" for a fully-typed unknown trigger. Whole-trigger distance
// ≤ 2 wins ("sumarize" → summarize); otherwise an unambiguous fuzzy-prefix
// match ("sumar" → summarize). null when nothing is close enough.
export function suggestClosestTrigger(input: string, triggers: string[]): string | null {
  const q = input.toLowerCase();
  let best: string | null = null;
  let bestDist = Infinity;
  for (const t of triggers) {
    const d = editDistance(q, t);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  if (best && bestDist <= FUZZY_MAX_DISTANCE) return best;
  const close = triggers.filter((t) => fuzzyTriggerScore(q, t) !== null);
  return close.length === 1 ? close[0] : null;
}
