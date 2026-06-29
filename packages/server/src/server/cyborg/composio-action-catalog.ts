// Classify a Composio action slug → a UI group + a safe default approval policy.
// Drives the Integrations tab (grouping + which actions to pre-check) and the D5
// rule: write/destructive actions DEFAULT to require-approval (Tier-2), reads don't.
//
// Heuristic by the verb tokens in the slug — validated against REAL Composio slugs
// pulled live (e.g. GMAIL_FETCH_EMAILS=read, GMAIL_MOVE_TO_TRASH=destructive,
// GMAIL_BATCH_MODIFY_MESSAGES=write). An unknown verb is treated as write (so it
// inherits approval — fail safe, never silently auto-allow an unrecognized action).

export type ComposioActionGroup = "read" | "write" | "manage";

export interface ComposioActionInfo {
  slug: string;
  group: ComposioActionGroup;
  destructive: boolean;
  // D5: write (including destructive) defaults to requiring a human approval card.
  defaultApproval: boolean;
  label: string;
}

// Token → group. Destructive is a subset of write that ALWAYS needs approval.
const DESTRUCTIVE = new Set(["DELETE", "REMOVE", "TRASH", "PURGE", "DROP", "DESTROY", "ARCHIVE"]);
const WRITE = new Set([
  "SEND",
  "CREATE",
  "UPDATE",
  "MODIFY",
  "ADD",
  "POST",
  "REPLY",
  "MOVE",
  "PATCH",
  "SET",
  "ENABLE",
  "DISABLE",
  "MERGE",
  "EDIT",
  "RENAME",
  "UPLOAD",
  "INVITE",
  "ASSIGN",
  "CLOSE",
  "REOPEN",
  "MARK",
  "SCHEDULE",
  "CANCEL",
  "STAR",
  "UNSTAR",
  "LABEL",
  "WRITE",
]);
const READ = new Set([
  "FETCH",
  "GET",
  "LIST",
  "SEARCH",
  "READ",
  "FIND",
  "RETRIEVE",
  "DOWNLOAD",
  "COUNT",
  "CHECK",
  "VIEW",
]);
const MANAGE = new Set(["CONNECT", "AUTH", "AUTHORIZE", "AUTHENTICATE"]);

function actionTokens(slug: string): string[] {
  return slug.toUpperCase().split("_");
}

// Strip the leading toolkit token ("GMAIL_SEND_EMAIL" → "Send email").
export function humanizeActionLabel(slug: string): string {
  const parts = slug.split("_");
  const rest = parts.length > 1 ? parts.slice(1) : parts;
  const words = rest.join(" ").toLowerCase().trim();
  return words.length === 0 ? slug : words.charAt(0).toUpperCase() + words.slice(1);
}

export function classifyComposioAction(slug: string): ComposioActionInfo {
  const toks = actionTokens(slug);
  const has = (set: Set<string>) => toks.some((t) => set.has(t));

  let group: ComposioActionGroup;
  let destructive = false;
  // Order matters: destructive wins over a co-occurring write verb (MOVE_TO_TRASH,
  // BATCH_DELETE), and any write verb wins over a read verb that shares the slug.
  if (has(DESTRUCTIVE)) {
    group = "write";
    destructive = true;
  } else if (has(WRITE)) {
    group = "write";
  } else if (has(MANAGE)) {
    group = "manage";
  } else if (has(READ)) {
    group = "read";
  } else {
    group = "write"; // unknown verb → fail safe: write ⇒ inherits approval
  }

  return {
    slug,
    group,
    destructive,
    defaultApproval: group === "write",
    label: humanizeActionLabel(slug),
  };
}

// Classify a whole toolkit's action list and bucket by group for the tab.
export function buildActionCatalog(slugs: readonly string[]): {
  read: ComposioActionInfo[];
  write: ComposioActionInfo[];
  manage: ComposioActionInfo[];
} {
  const out = {
    read: [] as ComposioActionInfo[],
    write: [] as ComposioActionInfo[],
    manage: [] as ComposioActionInfo[],
  };
  for (const slug of slugs) {
    const info = classifyComposioAction(slug);
    out[info.group].push(info);
  }
  return out;
}
