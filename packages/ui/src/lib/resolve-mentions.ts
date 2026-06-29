// Mention resolution for the channel composer — extracted from
// MessageInput.svelte so it's testable (and so the cybo path has a harness).
//
// Resolves message text to a deduped list of mentioned ids: explicit
// autocomplete picks still present in the text, plus a best-effort match for
// handles typed BY HAND. Hand-typed handles match workspace members first
// (name, email, email local-part) and then — the P1 fix — cybos by name or
// slug (case-insensitive), encoding as `cybo:<id>` (the same wire shape the
// autocomplete pick produces). Members win on a name collision so a cybo can
// never shadow a human.

export interface MentionMember {
  userId: string;
  name?: string | null;
  email: string;
}

export interface MentionCybo {
  id: string;
  name: string;
  slug: string;
}

export interface MentionPick {
  // For cybo picks this is already `cybo:<id>` (the autocomplete encodes it).
  userId: string;
  label: string;
}

// A typed mention token: names with whitespace are bracketed.
export function mentionToken(label: string): string {
  return /\s/.test(label) ? `@[${label}]` : `@${label}`;
}

export function resolveMentions(
  input: string,
  opts: {
    selectedMentions: readonly MentionPick[];
    members: readonly MentionMember[];
    cybos: readonly MentionCybo[];
  },
): string[] {
  const { selectedMentions, members, cybos } = opts;
  const ids = new Set<string>();
  const explicitLabels = new Set(selectedMentions.map((s) => s.label.toLowerCase()));
  for (const s of selectedMentions) {
    if (input.includes(mentionToken(s.label))) ids.add(s.userId);
  }
  // Bracketed tokens (@[Name]) — inserted by autocomplete for names containing
  // whitespace. Resolved by name/slug below (members win over cybos).
  const names: string[] = [];
  for (const m of input.matchAll(/@\[([^\]]+)\]/g)) names.push(m[1]);
  for (const name of names) {
    // Already resolved via an explicit pick — don't double-match by name.
    if (explicitLabels.has(name.toLowerCase())) continue;
    const lower = name.toLowerCase();
    const member = members.find(
      (mm) =>
        mm.name?.toLowerCase() === lower ||
        mm.email.toLowerCase() === lower ||
        mm.email.split("@")[0].toLowerCase() === lower,
    );
    if (member) {
      ids.add(member.userId);
      continue;
    }
    // P1: hand-typed cybo handles ("@rickmaster") used to resolve ONLY via an
    // explicit autocomplete pick. Match the roster by name or slug — members
    // above take precedence, so a cybo never shadows a human with the same name.
    const cybo = cybos.find(
      (c) => c.name.toLowerCase() === lower || c.slug.toLowerCase() === lower,
    );
    if (cybo) ids.add(`cybo:${cybo.id}`);
  }

  // Hand-typed handles WITHOUT brackets. #631: the old single-word regex
  // (`@([\w-]+)`) stopped at the first space, so "@Apex personal" only matched
  // "Apex" and a multi-word cybo/member name never resolved when the autocomplete
  // didn't insert the bracketed token. Instead, at each hand-typed `@` match the
  // GREEDIEST known name that follows it (longest candidate, case-insensitive,
  // ending on a word boundary). Candidates are sorted longest-first with members
  // before cybos on a length tie, so the longest name wins and a cybo never
  // shadows a same-named human. The boundary check keeps "@rickmaster" from
  // resolving the member "rick", and "@Apexilon" from matching the cybo "Apex".
  // resolveMentions runs on every keystroke; cache the sorted candidate list by
  // the (members, cybos) references so we only rebuild it when the roster
  // actually changes, not once per character.
  let cached = candidatesCache.get(members);
  if (!cached || cached.cybos !== cybos) {
    cached = { cybos, list: buildMentionCandidates(members, cybos) };
    candidatesCache.set(members, cached);
  }
  const candidates = cached.list;
  for (const m of input.matchAll(/(?<!\w)@(?=\S)/g)) {
    const after = input.slice((m.index ?? 0) + 1);
    const lowerAfter = after.toLowerCase();
    const hit = candidates.find((c) => {
      if (!lowerAfter.startsWith(c.lower)) return false;
      const next = after[c.lower.length];
      return next === undefined || !/\w/.test(next);
    });
    if (hit) ids.add(hit.id);
  }

  return [...ids];
}

// Per-roster cache for the greedy candidate list (keyed by the members array
// reference; the stored cybos reference is checked so a roster change rebuilds).
const candidatesCache = new WeakMap<
  readonly MentionMember[],
  { cybos: readonly MentionCybo[]; list: { lower: string; id: string }[] }
>();

// Flatten the roster into match candidates ({lowercased label, resolved id}) for
// the greedy hand-typed pass: every member name / email / email-local-part →
// userId, and every cybo name / slug → `cybo:<id>`. Sorted longest-first so a
// greedy scan prefers the fullest name; members keep their original (earlier)
// position on a length tie so they win a name collision against a cybo.
function buildMentionCandidates(
  members: readonly MentionMember[],
  cybos: readonly MentionCybo[],
): { lower: string; id: string }[] {
  const out: { lower: string; id: string; order: number }[] = [];
  let order = 0;
  const push = (label: string | null | undefined, id: string): void => {
    const lower = label?.trim().toLowerCase();
    if (lower) out.push({ lower, id, order: order++ });
  };
  for (const mm of members) {
    push(mm.name, mm.userId);
    push(mm.email, mm.userId);
    // Defensive: a system/bot user or malformed payload could carry a null email
    // despite the type — `?.` avoids a TypeError (push ignores the undefined).
    push(mm.email?.split("@")[0], mm.userId);
  }
  for (const c of cybos) {
    push(c.name, `cybo:${c.id}`);
    push(c.slug, `cybo:${c.id}`);
  }
  return out
    .sort((a, b) => b.lower.length - a.lower.length || a.order - b.order)
    .map(({ lower, id }) => ({ lower, id }));
}
