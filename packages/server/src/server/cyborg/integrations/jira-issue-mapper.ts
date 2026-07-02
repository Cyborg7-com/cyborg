// Jira Cloud (REST v3) payload -> normalized task types. This is the PURE, network-free,
// fully unit-testable CORE of the Jira -> Tasks sync: it converts a Jira issue payload and
// a Jira webhook envelope into the provider-agnostic NormalizedTaskEvent / NormalizedTaskItem
// shapes the sync engine consumes. No I/O, no DB, no env — the adapter (jira-adapter.ts)
// does the HTTP and delegates the shaping here.
//
// Jira sends the FULL issue snapshot on every webhook (not a field delta), so an issue/import
// event carries the whole field bag every time — a strict mirror (an unset field maps to
// null, which the engine applies as "clear"). Jira has NO native start date, so startAt is
// always omitted.
//
// externalProjectId format: "<cloudId>:<projectKey>". A Jira webhook body does NOT carry the
// site cloudId, so the route injects it as `body.cloudId` before calling parseInbound; when
// absent the mapper emits the bare projectKey (a documented degrade — it will only match a
// binding stored under the bare key).

import type {
  NormalizedTaskEvent,
  NormalizedTaskItem,
  StatusCategory,
  TaskPriority,
} from "./task-integration-adapter.js";

// ── permissive extraction helpers (untrusted JSON) ──

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// ── status + priority normalization ──

// Jira status names that mean "won't do / cancelled" — a Done-category status literally
// named this maps to `cancelled`, not `completed` (the by-name heuristic). Normalized:
// lowercased, apostrophes stripped, whitespace collapsed.
const CANCELLED_STATUS_NAMES = new Set([
  "cancelled",
  "canceled",
  "wont do",
  "wont fix",
  "will not do",
  "will not fix",
  "abandoned",
  "discarded",
  "rejected",
]);

function normalizeStatusName(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Map a Jira status onto our five-value StatusCategory. The by-name cancelled heuristic
 * wins first (a Done status literally named "Cancelled" / "Won't Do" is `cancelled`), then
 * the native Jira statusCategory key: new -> unstarted, indeterminate -> started,
 * done -> completed. An unknown/absent category degrades to `unstarted`. PURE.
 */
export function mapJiraStatusCategory(
  categoryKey: string | null | undefined,
  statusName: string | null | undefined,
): StatusCategory {
  if (CANCELLED_STATUS_NAMES.has(normalizeStatusName(statusName ?? ""))) return "cancelled";
  switch ((categoryKey ?? "").toLowerCase().trim()) {
    case "new":
      return "unstarted";
    case "indeterminate":
      return "started";
    case "done":
      return "completed";
    default:
      return "unstarted";
  }
}

/**
 * Map a Jira priority NAME onto our five-value TaskPriority: Highest -> urgent,
 * High -> high, Medium -> medium, Low -> low, Lowest -> none. Any unrecognized (or custom)
 * priority name degrades to `none`. PURE.
 */
export function mapJiraPriority(priorityName: string | null | undefined): TaskPriority {
  switch ((priorityName ?? "").toLowerCase().trim()) {
    case "highest":
      return "urgent";
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    default:
      return "none";
  }
}

// ── ADF (Atlassian Document Format) -> markdown ──

/**
 * Convert a Jira v3 ADF description/comment body to markdown. Handles the common node set —
 * doc, paragraph, heading, text (with strong/em/code/strike/link marks), hardBreak,
 * bulletList / orderedList (incl. nesting), codeBlock, blockquote, rule, mention, emoji,
 * inlineCard — and DEGRADES any unknown node to the text it (recursively) contains. Returns
 * null for null/undefined, an empty doc, or a whitespace-only result. A plain string input
 * (some webhook shapes send the description pre-rendered) is passed through trimmed. PURE,
 * no new dependency.
 */
export function adfToMarkdown(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "string") {
    const s = input.trim();
    return s ? s : null;
  }
  const doc = obj(input);
  if (!doc) return null;
  const rendered = renderBlocks(arr(doc.content)).trim();
  return rendered ? rendered : null;
}

function renderBlocks(nodes: unknown[]): string {
  const out: string[] = [];
  for (const n of nodes) {
    const node = obj(n);
    if (!node) continue;
    const rendered = renderBlockNode(node);
    if (rendered.length > 0) out.push(rendered);
  }
  return out.join("\n\n");
}

function renderBlockNode(node: Record<string, unknown>): string {
  const type = asString(node.type);
  const content = arr(node.content);
  switch (type) {
    case "paragraph":
      return renderInline(content);
    case "heading": {
      const level = clampInt(obj(node.attrs)?.level, 1, 6, 1);
      const text = renderInline(content);
      return text ? `${"#".repeat(level)} ${text}` : "";
    }
    case "bulletList":
      return renderList(content, "bullet");
    case "orderedList":
      return renderList(content, "ordered");
    case "codeBlock": {
      const lang = asString(obj(node.attrs)?.language);
      return `\`\`\`${lang}\n${renderCodeBlockText(content)}\n\`\`\``;
    }
    case "blockquote":
      return renderBlocks(content)
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    case "rule":
      return "---";
    default: {
      // Unknown block node -> degrade to the text it contains: prefer nested block
      // rendering, else treat its children as inline.
      const inner = renderBlocks(content);
      return inner || renderInline(content);
    }
  }
}

function renderList(items: unknown[], kind: "bullet" | "ordered"): string {
  const lines: string[] = [];
  let index = 1;
  for (const it of items) {
    const item = obj(it);
    if (!item) continue;
    const marker = kind === "ordered" ? `${index}. ` : "- ";
    const bodyLines = renderBlocks(arr(item.content)).split("\n");
    const indent = " ".repeat(marker.length);
    const first = bodyLines.shift() ?? "";
    lines.push(`${marker}${first}`);
    for (const line of bodyLines) lines.push(line ? `${indent}${line}` : "");
    index += 1;
  }
  return lines.join("\n");
}

function renderCodeBlockText(content: unknown[]): string {
  return content.map((n) => asString(obj(n)?.text)).join("");
}

function renderInline(content: unknown[]): string {
  let out = "";
  for (const n of content) {
    const node = obj(n);
    if (!node) continue;
    out += renderInlineNode(node);
  }
  return out;
}

function renderInlineNode(node: Record<string, unknown>): string {
  const type = asString(node.type);
  switch (type) {
    case "text":
      return applyMarks(asString(node.text), arr(node.marks));
    case "hardBreak":
      return "\n";
    case "mention": {
      const attrs = obj(node.attrs);
      return asString(attrs?.text) || asString(attrs?.displayName) || "";
    }
    case "emoji": {
      const attrs = obj(node.attrs);
      return asString(attrs?.text) || asString(attrs?.shortName) || "";
    }
    case "inlineCard": {
      const url = asString(obj(node.attrs)?.url);
      return url ? `<${url}>` : "";
    }
    case "date":
      return asString(obj(node.attrs)?.timestamp);
    default:
      return renderUnknownInline(node);
  }
}

// An inline node type we don't model explicitly -> degrade to the text it carries (node.text
// or attrs.text), else recurse into any child content, else empty.
function renderUnknownInline(node: Record<string, unknown>): string {
  const text = asString(node.text) || asString(obj(node.attrs)?.text);
  if (text) return applyMarks(text, arr(node.marks));
  const inner = arr(node.content);
  return inner.length > 0 ? renderInline(inner) : "";
}

function applyMarks(text: string, marks: unknown[]): string {
  if (!text) return text;
  let out = text;
  let href: string | null = null;
  const active = new Set<string>();
  for (const m of marks) {
    const mark = obj(m);
    const markType = asString(mark?.type);
    if (markType === "link") href = asString(obj(mark?.attrs)?.href) || null;
    else if (markType) active.add(markType);
  }
  if (active.has("code")) out = `\`${out}\``;
  if (active.has("strong")) out = `**${out}**`;
  if (active.has("em")) out = `*${out}*`;
  if (active.has("strike")) out = `~~${out}~~`;
  if (href) out = `[${out}](${href})`;
  return out;
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// ── issue field extraction (shared by event + item mappers) ──

interface JiraIssueFieldBag {
  title: string;
  description: string | null;
  sourceStatusId: string | null;
  sourceStatusName: string | null;
  statusCategory: StatusCategory | undefined;
  assigneeEmail: string | null;
  // The Jira Atlassian accountId of the assignee — the personal-data subject reported to /
  // erased via the Personal Data Reporting API. Display/erasure only, never a Cyborg identity.
  assigneeAccountId: string | null;
  labels: string[];
  priority: TaskPriority | undefined;
  dueAt: number | null;
}

function extractIssueFields(fields: Record<string, unknown>): JiraIssueFieldBag {
  const statusObj = obj(fields.status);
  const sourceStatusId = statusObj ? asString(statusObj.id).trim() || null : null;
  const sourceStatusName = statusObj ? asString(statusObj.name).trim() || null : null;
  const statusCategory = statusObj
    ? mapJiraStatusCategory(asString(obj(statusObj.statusCategory)?.key), sourceStatusName)
    : undefined;

  const assigneeObj = obj(fields.assignee);
  const assigneeEmail = assigneeObj ? asString(assigneeObj.emailAddress).trim() || null : null;
  const assigneeAccountId = assigneeObj ? asString(assigneeObj.accountId).trim() || null : null;

  const labels = Array.from(
    new Set(
      arr(fields.labels)
        .map((l) => asString(l).trim())
        .filter(Boolean),
    ),
  );

  const priorityObj = obj(fields.priority);
  const priority = priorityObj ? mapJiraPriority(asString(priorityObj.name)) : undefined;

  return {
    title: asString(fields.summary).trim(),
    description: adfToMarkdown(fields.description),
    sourceStatusId,
    sourceStatusName,
    statusCategory,
    assigneeEmail,
    assigneeAccountId,
    labels,
    priority,
    dueAt: parseDueDate(fields.duedate),
  };
}

// Jira `duedate` is a date-only string ("YYYY-MM-DD"); Date.parse reads it as UTC midnight.
// A full ISO timestamp also parses. Absent/blank/invalid -> null (clears the task's due).
function parseDueDate(v: unknown): number | null {
  const s = asString(v).trim();
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

// The project key an issue belongs to: from fields.project.key, else derived from the issue
// key itself ("ENG-42" -> "ENG"). The derived fallback keeps comment/deleted events routable
// when the payload omits the project object.
function projectKeyFromIssue(issue: Record<string, unknown>): string {
  const fromField = asString(obj(obj(issue.fields)?.project)?.key).trim();
  if (fromField) return fromField;
  const key = asString(issue.key).trim();
  const dash = key.lastIndexOf("-");
  return dash > 0 ? key.slice(0, dash) : "";
}

// The human browse link for an issue, derived from `self`'s origin + /browse/{key}. Returns
// null when self points at the api.atlassian.com gateway (an import via the gateway yields a
// non-browsable self) — itemUrl is optional and the engine only stores it when present.
function browseUrl(issue: Record<string, unknown>): string | null {
  const self = asString(issue.self).trim();
  const key = asString(issue.key).trim();
  if (!self || !key) return null;
  try {
    const parsed = new URL(self);
    if (parsed.hostname === "api.atlassian.com") return null;
    return `${parsed.origin}/browse/${key}`;
  } catch {
    return null;
  }
}

/** Compose the adapter's externalProjectId. When cloudId is known -> "<cloudId>:<projectKey>";
 * otherwise the bare projectKey (documented degrade for cloudId-less webhook bodies). */
export function buildExternalProjectId(
  cloudId: string | null | undefined,
  projectKey: string,
): string {
  return cloudId ? `${cloudId}:${projectKey}` : projectKey;
}

// ── issue / webhook mappers ──

/** Options a webhook mapper threads into the issue/deleted mappers. */
export interface JiraMapOptions {
  cloudId?: string | null;
  actor?: string | null;
}

/**
 * Map a single Jira issue payload (the `issue` object) to a normalized issue event. Returns
 * null when the payload isn't a routable issue (missing key or project). PURE. The full
 * field bag is populated (Jira sends complete snapshots). startAt is omitted (Jira has no
 * native start date).
 */
export function mapJiraIssueToEvent(
  raw: unknown,
  opts: JiraMapOptions = {},
): NormalizedTaskEvent | null {
  const issue = obj(raw);
  if (!issue) return null;
  const key = asString(issue.key).trim();
  const fields = obj(issue.fields);
  if (!key || !fields) return null;
  const projectKey = projectKeyFromIssue(issue);
  if (!projectKey) return null;

  const bag = extractIssueFields(fields);
  const event: NormalizedTaskEvent = {
    itemType: "issue",
    externalProjectId: buildExternalProjectId(opts.cloudId, projectKey),
    itemNumber: key,
    providerItemId: asString(issue.id).trim() || key,
    itemUrl: browseUrl(issue),
    actor: opts.actor ?? null,
    title: bag.title,
    description: bag.description,
    sourceStatusId: bag.sourceStatusId,
    sourceStatusName: bag.sourceStatusName,
    assigneeEmail: bag.assigneeEmail,
    assigneeAccountId: bag.assigneeAccountId,
    labels: bag.labels,
    dueAt: bag.dueAt,
  };
  if (bag.statusCategory) event.statusCategory = bag.statusCategory;
  if (bag.priority !== undefined) event.priority = bag.priority;
  return event;
}

/**
 * Map a single Jira issue payload to a normalized import item (the batch-import shape).
 * Returns null when the payload isn't a valid issue (missing key). PURE. title falls back
 * to the issue key when the summary is blank (NormalizedTaskItem.title is non-optional).
 */
export function mapJiraIssueToItem(raw: unknown): NormalizedTaskItem | null {
  const issue = obj(raw);
  if (!issue) return null;
  const key = asString(issue.key).trim();
  const fields = obj(issue.fields);
  if (!key || !fields) return null;

  const bag = extractIssueFields(fields);
  const item: NormalizedTaskItem = {
    itemType: "issue",
    itemNumber: key,
    providerItemId: asString(issue.id).trim() || key,
    itemUrl: browseUrl(issue),
    title: bag.title || key,
    description: bag.description,
    sourceStatusId: bag.sourceStatusId,
    sourceStatusName: bag.sourceStatusName,
    assigneeEmail: bag.assigneeEmail,
    assigneeAccountId: bag.assigneeAccountId,
    labels: bag.labels,
    dueAt: bag.dueAt,
  };
  if (bag.statusCategory) item.statusCategory = bag.statusCategory;
  if (bag.priority !== undefined) item.priority = bag.priority;
  return item;
}

/**
 * Map a Jira webhook envelope to zero or more normalized events. Handles
 * jira:issue_created / jira:issue_updated (-> issue), jira:issue_deleted (-> deleted), and
 * comment_created (-> comment on the parent issue). Any other event (or a non-object body)
 * -> []. PURE + never throws. The cloudId is read from `body.cloudId` (injected by the
 * route) so the emitted externalProjectId matches the "<cloudId>:<projectKey>" binding key.
 */
export function mapJiraWebhookToEvents(body: unknown): NormalizedTaskEvent[] {
  const root = obj(body);
  if (!root) return [];
  const webhookEvent = asString(root.webhookEvent).trim().toLowerCase();
  const cloudId = asString(root.cloudId).trim() || null;
  const actor = asString(obj(root.user)?.displayName).trim() || null;

  if (webhookEvent === "jira:issue_created" || webhookEvent === "jira:issue_updated") {
    const event = mapJiraIssueToEvent(root.issue, { cloudId, actor });
    return event ? [event] : [];
  }
  if (webhookEvent === "jira:issue_deleted") {
    const event = mapDeletedEvent(root.issue, { cloudId, actor });
    return event ? [event] : [];
  }
  if (webhookEvent === "comment_created") {
    const event = mapCommentEvent(root, cloudId);
    return event ? [event] : [];
  }
  return [];
}

function mapDeletedEvent(rawIssue: unknown, opts: JiraMapOptions): NormalizedTaskEvent | null {
  const issue = obj(rawIssue);
  if (!issue) return null;
  const key = asString(issue.key).trim();
  const projectKey = projectKeyFromIssue(issue);
  if (!key || !projectKey) return null;
  return {
    itemType: "deleted",
    externalProjectId: buildExternalProjectId(opts.cloudId, projectKey),
    itemNumber: key,
    providerItemId: asString(issue.id).trim() || key,
    itemUrl: browseUrl(issue),
    actor: opts.actor ?? null,
  };
}

function mapCommentEvent(
  root: Record<string, unknown>,
  cloudId: string | null,
): NormalizedTaskEvent | null {
  const issue = obj(root.issue);
  const comment = obj(root.comment);
  if (!issue || !comment) return null;
  const key = asString(issue.key).trim();
  const projectKey = projectKeyFromIssue(issue);
  if (!key || !projectKey) return null;
  const author = asString(obj(comment.author)?.displayName).trim() || null;
  return {
    itemType: "comment",
    externalProjectId: buildExternalProjectId(cloudId, projectKey),
    itemNumber: key,
    providerItemId: asString(comment.id).trim(),
    itemUrl: browseUrl(issue),
    actor: author,
    commentBody: adfToMarkdown(comment.body),
  };
}
