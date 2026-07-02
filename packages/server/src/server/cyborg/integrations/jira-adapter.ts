// Jira Cloud (REST v3) implementation of the provider-generic TaskIntegrationAdapter. Like
// slackAdapter it is STATELESS — the OAuth access token is passed in by the caller (route /
// engine), never read from env — so ONE `jiraAdapter` instance serves every workspace's
// installation. All provider HTTP lives here; the pure payload shaping is delegated to
// jira-issue-mapper.ts.
//
// externalProjectId format: "<cloudId>:<projectKey>" (cloudId is the api.atlassian.com
// gateway segment; a UUID with no colon, so we split on the first ":"). listStatuses /
// importItems / writeItem / writeStatus decode it to build the REST base URL
// `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...`.
//
// verifyWebhook: Jira REST-registered webhooks are NOT HMAC-signed. The route registers the
// webhook URL with a shared secret in the query string and copies that value into the
// `x-cyborg-webhook-secret` header before calling verifyWebhook, which compares it
// constant-time against the configured secret. Pure + never throws.

import { timingSafeEqual } from "node:crypto";
import type {
  ImportItemsPage,
  NormalizedTaskEvent,
  NormalizedTaskItem,
  SourceStatus,
  TaskIntegrationAdapter,
  TaskItemWritePatch,
  TaskPriority,
  TaskStatusWriteArgs,
} from "./task-integration-adapter.js";
import {
  mapJiraIssueToItem,
  mapJiraStatusCategory,
  mapJiraWebhookToEvents,
} from "./jira-issue-mapper.js";

export const JIRA_PROVIDER = "jira";

// The header the route copies the registered webhook `?secret=` query value into (Jira REST
// webhooks can't send custom headers, so the secret rides in the URL query).
export const JIRA_WEBHOOK_SECRET_HEADER = "x-cyborg-webhook-secret";

// The api.atlassian.com gateway base — every REST call is scoped by cloudId under it.
const JIRA_API_BASE = "https://api.atlassian.com/ex/jira";
const IMPORT_PAGE_SIZE = 50;

// Dynamic-webhook lifetime. A webhook registered via the REST API expires 30 days after it
// was created or last refreshed; the register response does NOT echo an expiry, so we derive
// one from this constant. Docs: https://developer.atlassian.com/cloud/jira/platform/webhooks/
// ("The expiration period is 30 days from the time the webhook was created or refreshed").
const WEBHOOK_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
// The issue fields importItems requests. `description` comes back as ADF; the mapper renders
// it. `project` is needed so an imported issue is attributable to its project.
const SEARCH_FIELDS =
  "summary,description,status,priority,assignee,labels,duedate,issuetype,project";

// ── dynamic-webhook REST contract (auto-registration + 30-day refresh) ──
// REST group: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-webhooks/
// A 3LO OAuth app (scope `manage:jira-webhook`) manages its OWN dynamic webhooks:
//   register — POST   {base}/rest/api/3/webhook          body { url, webhooks:[{events,jqlFilter}] }
//                     → { webhookRegistrationResult:[{createdWebhookId}|{errors}] } (no expiry)
//   refresh  — PUT    {base}/rest/api/3/webhook/refresh  body { webhookIds }
//                     → { webhookIds, expirationDate }   (extends life 30 days)
//   delete   — DELETE {base}/rest/api/3/webhook          body { webhookIds } → 202
// The register `url` is an ARBITRARY endpoint the app supplies (the docs' own example points
// at a pipedream URL), so our `<appBase>/api/jira/webhook?install=…&secret=…` receiver works
// verbatim. These three methods are BEST-EFFORT: they never throw a raw network/HTTP error to
// the caller, returning a discriminated result so the bind / refresh sweep can fall back.

// The events + JQL a single webhook subscription registers for.
export interface JiraWebhookRegisterArgs {
  url: string;
  events: string[];
  jqlFilter: string;
}

// The identity of the webhook(s) created by one register call + when they expire (ISO 8601).
export interface JiraWebhookRegistration {
  webhookIds: number[];
  expirationDate: string;
}

export type JiraWebhookRegisterResult =
  | { ok: true; registration: JiraWebhookRegistration }
  | { ok: false; status: number | null; error: string };

export type JiraWebhookRefreshResult =
  | { ok: true; webhookIds: number[]; expirationDate: string }
  | { ok: false; status: number | null; error: string };

export type JiraWebhookDeleteResult =
  | { ok: true }
  | { ok: false; status: number | null; error: string };

// A minimal fetch surface, injectable so the adapter is unit-testable without a network.
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JiraAdapterDeps {
  fetchImpl?: FetchLike;
}

export class JiraAdapter implements TaskIntegrationAdapter {
  readonly provider = JIRA_PROVIDER;
  private readonly fetchImpl: FetchLike;

  constructor(deps: JiraAdapterDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  // Verify a Jira webhook via the shared secret the route places in JIRA_WEBHOOK_SECRET_HEADER,
  // compared constant-time against the configured secret. rawBody is unused (Jira REST
  // webhooks carry no HMAC signature). Pure + synchronous; never throws — bad/missing input
  // returns false.
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
    secret: string,
  ): boolean {
    void rawBody;
    if (!secret) return false;
    const presented = headers[JIRA_WEBHOOK_SECRET_HEADER];
    if (typeof presented !== "string" || presented.length === 0) return false;
    const a = Buffer.from(presented, "utf8");
    const b = Buffer.from(secret, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // Delegate to the pure mapper. Never throws — an unrecognized/irrelevant payload -> [].
  parseInbound(payload: unknown): NormalizedTaskEvent[] {
    try {
      return mapJiraWebhookToEvents(payload);
    } catch {
      return [];
    }
  }

  // The project's selectable statuses (mapping UI + auto-seed) via
  // GET /rest/api/3/project/{key}/statuses (grouped by issue type). Flattened + de-duped by
  // status id, each mapped onto our StatusCategory. Throws on a provider error.
  async listStatuses(token: string, externalProjectId: string): Promise<SourceStatus[]> {
    const { cloudId, projectKey } = parseExternalProjectId(externalProjectId);
    const url = `${JIRA_API_BASE}/${cloudId}/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`;
    const res = await this.fetchImpl(url, { method: "GET", headers: authHeaders(token) });
    if (!res.ok) throw new Error(`Jira listStatuses failed: ${res.status} ${res.statusText}`);
    const data: unknown = await res.json();

    const byId = new Map<string, SourceStatus>();
    for (const issueType of arr(data)) {
      const it = obj(issueType);
      if (!it) continue;
      for (const s of arr(it.statuses)) {
        const status = obj(s);
        if (!status) continue;
        const id = asString(status.id).trim();
        const name = asString(status.name).trim();
        if (!id || !name) continue;
        const categoryKey = asString(obj(status.statusCategory)?.key);
        byId.set(id, { id, name, category: mapJiraStatusCategory(categoryKey, name) });
      }
    }
    return [...byId.values()];
  }

  // One page of the project's issues via JQL search (GET /rest/api/3/search/jql, token-based
  // pagination). The opaque cursor wraps Jira's nextPageToken. Rate-limit-aware: a 429
  // returns the (empty) page plus a cursor that resumes the SAME request; the caller backs
  // off per Retry-After. Any other non-2xx throws.
  async importItems(
    token: string,
    externalProjectId: string,
    cursor?: string,
  ): Promise<ImportItemsPage> {
    const { cloudId, projectKey } = parseExternalProjectId(externalProjectId);
    const { pageToken } = decodeCursor(cursor);

    const jql = `project = "${projectKey.replace(/"/g, '\\"')}" ORDER BY created ASC`;
    const params = new URLSearchParams({
      jql,
      maxResults: String(IMPORT_PAGE_SIZE),
      fields: SEARCH_FIELDS,
    });
    if (pageToken) params.set("nextPageToken", pageToken);
    const url = `${JIRA_API_BASE}/${cloudId}/rest/api/3/search/jql?${params.toString()}`;

    const res = await this.fetchImpl(url, { method: "GET", headers: authHeaders(token) });
    if (res.status === 429) {
      const retryAfter = res.headers?.get?.("retry-after") ?? null;
      console.warn(
        `[jira-adapter] importItems rate-limited (429); retry-after=${retryAfter ?? "unknown"}`,
      );
      return { items: [], nextCursor: encodeCursor({ pageToken }) };
    }
    if (!res.ok) throw new Error(`Jira importItems failed: ${res.status} ${res.statusText}`);

    const data = obj(await res.json());
    if (!data) return { items: [] };
    const items: NormalizedTaskItem[] = [];
    for (const raw of arr(data.issues)) {
      const item = mapJiraIssueToItem(raw);
      if (item) items.push(item);
    }
    const nextToken = asString(data.nextPageToken).trim();
    if (nextToken && data.isLast !== true)
      return { items, nextCursor: encodeCursor({ pageToken: nextToken }) };
    return { items };
  }

  // WAVE 2 — write task fields back onto the Jira issue via PUT /rest/api/3/issue/{id}.
  // Maps summary/description(as ADF)/labels/duedate/priority; assignee is resolved from email
  // to an accountId best-effort (skipped if unresolvable). startAt is skipped (Jira has no
  // native start date). A no-op patch performs no request. Throws on a provider error.
  async writeItem(token: string, patch: TaskItemWritePatch): Promise<void> {
    const { cloudId } = parseExternalProjectId(patch.externalProjectId);
    const issueId = patch.providerItemId || patch.itemNumber;
    if (!issueId) throw new Error("Jira writeItem: patch is missing providerItemId/itemNumber");

    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) fields.summary = patch.title;
    if (patch.description !== undefined) {
      fields.description = patch.description === null ? null : textToAdf(patch.description);
    }
    if (patch.labels !== undefined) fields.labels = patch.labels;
    if (patch.dueAt !== undefined)
      fields.duedate = patch.dueAt === null ? null : epochToJiraDate(patch.dueAt);
    if (patch.priority !== undefined) {
      const name = jiraPriorityName(patch.priority);
      if (name) fields.priority = { name };
    }
    if (patch.assigneeEmail !== undefined) {
      if (patch.assigneeEmail === null) {
        fields.assignee = { accountId: null };
      } else {
        const accountId = await this.resolveAccountId(token, cloudId, patch.assigneeEmail);
        if (accountId) fields.assignee = { accountId };
      }
    }

    if (Object.keys(fields).length === 0) return; // nothing to write.
    const url = `${JIRA_API_BASE}/${cloudId}/rest/api/3/issue/${encodeURIComponent(issueId)}`;
    const res = await this.fetchImpl(url, {
      method: "PUT",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok)
      throw new Error(`Jira writeItem failed for ${issueId}: ${res.status} ${res.statusText}`);
  }

  // WAVE 2 — move the Jira issue into a target status. Best-effort: GET the issue's available
  // transitions, match one by target status id or name, and POST it. When no transition
  // reaches the target (blocked by the workflow) it logs + skips rather than throwing. Throws
  // only on a hard provider error (listing/posting failed).
  async writeStatus(token: string, args: TaskStatusWriteArgs): Promise<void> {
    const { cloudId } = parseExternalProjectId(args.externalProjectId);
    const issueId = args.providerItemId || args.itemNumber;
    if (!issueId) throw new Error("Jira writeStatus: args missing providerItemId/itemNumber");

    const transitionsUrl = `${JIRA_API_BASE}/${cloudId}/rest/api/3/issue/${encodeURIComponent(issueId)}/transitions`;
    const listRes = await this.fetchImpl(transitionsUrl, {
      method: "GET",
      headers: authHeaders(token),
    });
    if (!listRes.ok) {
      throw new Error(
        `Jira writeStatus: failed to list transitions for ${issueId}: ${listRes.status}`,
      );
    }

    const data = obj(await listRes.json());
    const targetName = args.sourceStatusName.trim().toLowerCase();
    const targetId = (args.sourceStatusId ?? "").trim();
    let transitionId = "";
    for (const t of data ? arr(data.transitions) : []) {
      const transition = obj(t);
      if (!transition) continue;
      const to = obj(transition.to);
      const toId = asString(to?.id).trim();
      const toName = asString(to?.name).trim().toLowerCase();
      if ((targetId && toId === targetId) || (targetName && toName === targetName)) {
        transitionId = asString(transition.id).trim();
        break;
      }
    }

    if (!transitionId) {
      console.warn(
        `[jira-adapter] writeStatus: no available transition to "${args.sourceStatusName}" for ` +
          `${issueId} (blocked by workflow) — skipping`,
      );
      return;
    }

    const postRes = await this.fetchImpl(transitionsUrl, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ transition: { id: transitionId } }),
    });
    if (!postRes.ok) {
      throw new Error(
        `Jira writeStatus: transition ${transitionId} failed for ${issueId}: ${postRes.status}`,
      );
    }
  }

  // Resolve an assignee email to a Jira accountId via GET /rest/api/3/user/search. Best-effort
  // — returns null on any failure (privacy settings may hide emails / the endpoint may 403),
  // so writeItem simply skips the assignee field rather than aborting the whole write.
  private async resolveAccountId(
    token: string,
    cloudId: string,
    email: string,
  ): Promise<string | null> {
    try {
      const url = `${JIRA_API_BASE}/${cloudId}/rest/api/3/user/search?query=${encodeURIComponent(email)}`;
      const res = await this.fetchImpl(url, { method: "GET", headers: authHeaders(token) });
      if (!res.ok) return null;
      const data: unknown = await res.json();
      for (const u of arr(data)) {
        const accountId = asString(obj(u)?.accountId).trim();
        if (accountId) return accountId;
      }
      return null;
    } catch {
      return null;
    }
  }

  // Register a dynamic webhook for one project: POST /rest/api/3/webhook with the receiver
  // `url`, the subscribed `events`, and a `jqlFilter` (required per entry). NOTE (per the
  // Jira webhooks docs): the registered URL MUST use the same base URL as the app — Jira
  // rejects a receiver whose base differs from the app's registered base, so CYBORG_APP_URL
  // (which builds <appBase>/api/jira/webhook) must match the Atlassian app's base URL. The
  // register response carries only `createdWebhookId`s (no expiry), so we derive the 30-day
  // expiry from WEBHOOK_LIFETIME_MS. Best-effort: a transport error, a non-2xx, or a per-entry
  // `errors` payload with no created id all return `{ ok:false }` — never a thrown error.
  async registerWebhook(
    token: string,
    cloudId: string,
    args: JiraWebhookRegisterArgs,
  ): Promise<JiraWebhookRegisterResult> {
    const url = `${JIRA_API_BASE}/${cloudId}/rest/api/3/webhook`;
    const body = JSON.stringify({
      url: args.url,
      webhooks: [{ events: args.events, jqlFilter: args.jqlFilter }],
    });
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body,
      });
    } catch (err) {
      return { ok: false, status: null, error: networkErrorMessage(err) };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: `register failed: ${res.status} ${res.statusText}` };
    }
    const data = obj(await readJsonSafe(res));
    const webhookIds: number[] = [];
    const errors: string[] = [];
    for (const raw of data ? arr(data.webhookRegistrationResult) : []) {
      const entry = obj(raw);
      if (!entry) continue;
      if (typeof entry.createdWebhookId === "number" && Number.isFinite(entry.createdWebhookId)) {
        webhookIds.push(entry.createdWebhookId);
      }
      for (const e of arr(entry.errors)) if (typeof e === "string") errors.push(e);
    }
    if (webhookIds.length === 0) {
      return { ok: false, status: res.status, error: errors.join("; ") || "no webhook id returned" };
    }
    const expirationDate = new Date(Date.now() + WEBHOOK_LIFETIME_MS).toISOString();
    return { ok: true, registration: { webhookIds, expirationDate } };
  }

  // Extend the life of existing webhooks: PUT /rest/api/3/webhook/refresh with { webhookIds }.
  // The response returns the refreshed ids + the new `expirationDate` (another 30 days out).
  // Best-effort — any failure returns a discriminated `{ ok:false }`, never throws.
  async refreshWebhooks(
    token: string,
    cloudId: string,
    webhookIds: number[],
  ): Promise<JiraWebhookRefreshResult> {
    const url = `${JIRA_API_BASE}/${cloudId}/rest/api/3/webhook/refresh`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "PUT",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ webhookIds }),
      });
    } catch (err) {
      return { ok: false, status: null, error: networkErrorMessage(err) };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: `refresh failed: ${res.status} ${res.statusText}` };
    }
    const data = obj(await readJsonSafe(res));
    const expirationDate = asString(data?.expirationDate).trim();
    if (!expirationDate) {
      return { ok: false, status: res.status, error: "refresh response missing expirationDate" };
    }
    const ids: number[] = [];
    for (const id of arr(data?.webhookIds)) if (typeof id === "number") ids.push(id);
    return { ok: true, webhookIds: ids.length > 0 ? ids : webhookIds, expirationDate };
  }

  // Tear down webhooks: DELETE /rest/api/3/webhook with { webhookIds } (202 on success). Used
  // when a binding is removed. Best-effort — any failure returns `{ ok:false }`, never throws.
  async deleteWebhook(
    token: string,
    cloudId: string,
    webhookIds: number[],
  ): Promise<JiraWebhookDeleteResult> {
    const url = `${JIRA_API_BASE}/${cloudId}/rest/api/3/webhook`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "DELETE",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ webhookIds }),
      });
    } catch (err) {
      return { ok: false, status: null, error: networkErrorMessage(err) };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: `delete failed: ${res.status} ${res.statusText}` };
    }
    return { ok: true };
  }
}

// Stateless singleton — one instance serves every workspace's installation.
export const jiraAdapter = new JiraAdapter();

// ─── helpers ─────────────────────────────────────────────────────────────

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

// Read a JSON body without throwing on an empty/non-JSON payload (a 202 refresh/delete may
// carry no body). Returns null rather than raising so the best-effort webhook methods stay
// non-throwing.
async function readJsonSafe(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// A human-readable message for a thrown transport error (fetch rejects on DNS/TLS/timeout).
function networkErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "network error";
}

// Decode "<cloudId>:<projectKey>" — split on the FIRST colon (cloudId is a UUID with no
// colon). Throws a clear error on a malformed value (callers surface it).
function parseExternalProjectId(externalProjectId: string): {
  cloudId: string;
  projectKey: string;
} {
  const idx = externalProjectId.indexOf(":");
  if (idx <= 0 || idx === externalProjectId.length - 1) {
    throw new Error(
      `Jira externalProjectId must be "<cloudId>:<projectKey>", got "${externalProjectId}"`,
    );
  }
  return { cloudId: externalProjectId.slice(0, idx), projectKey: externalProjectId.slice(idx + 1) };
}

// The opaque importItems cursor: a JSON wrapper over Jira's nextPageToken. Encoding the
// empty (first-page) cursor yields "{}", a truthy value, so a 429 on the first page still
// returns a resumable nextCursor.
interface JiraImportCursor {
  pageToken?: string;
}

function encodeCursor(cursor: JiraImportCursor): string {
  return JSON.stringify(cursor);
}

function decodeCursor(cursor?: string): JiraImportCursor {
  if (!cursor) return {};
  try {
    const parsed = obj(JSON.parse(cursor));
    const token = asString(parsed?.pageToken).trim();
    return token ? { pageToken: token } : {};
  } catch {
    return {};
  }
}

// Map our TaskPriority onto a Jira priority NAME. "none" -> null (leave the issue's priority
// untouched rather than clearing it to a guessed value).
function jiraPriorityName(priority: TaskPriority): string | null {
  switch (priority) {
    case "urgent":
      return "Highest";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
    default:
      return null;
  }
}

// epoch ms -> Jira `duedate` string ("YYYY-MM-DD", UTC).
function epochToJiraDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Wrap plain text as a minimal valid ADF document (no markdown round-trip — wave-2
// best-effort). Blank-line-separated blocks become paragraphs; single newlines become
// hardBreaks within a paragraph.
function textToAdf(text: string): Record<string, unknown> {
  const paragraphs = text.split(/\n{2,}/).map((para) => {
    const inline: Record<string, unknown>[] = [];
    para.split("\n").forEach((line, i) => {
      if (i > 0) inline.push({ type: "hardBreak" });
      if (line.length > 0) inline.push({ type: "text", text: line });
    });
    return inline.length > 0 ? { type: "paragraph", content: inline } : { type: "paragraph" };
  });
  return {
    type: "doc",
    version: 1,
    content: paragraphs.length > 0 ? paragraphs : [{ type: "paragraph" }],
  };
}

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
