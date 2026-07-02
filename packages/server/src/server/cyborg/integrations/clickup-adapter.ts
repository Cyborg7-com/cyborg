// ClickUp (API v2) implementation of the provider-generic TaskIntegrationAdapter seam
// (./task-integration-adapter.ts). One-way inbound (webhook verify + parse, status list,
// batch import) is fully implemented; the wave-2 outbound writes (writeItem / writeStatus)
// are the simple ClickUp PUT.
//
// The adapter is STATELESS: the signing secret (verifyWebhook) and the API token
// (listStatuses / importItems / writeItem / writeStatus) are passed in by the caller,
// never read from env, so ONE `clickUpAdapter` instance serves every workspace's
// installation. Env reads + the configured-gate + the OAuth exchange live in
// clickup-app.ts (mirrors github-app.ts / slack-app.ts).
//
// ClickUp auth quirk: the token goes DIRECTLY in the `Authorization` header (no
// "Bearer "), and a raw personal token (`pk_…`) works identically to an OAuth token —
// clickUpAuthHeaderValue is the single encoder of that rule.
//
// externalProjectId == the ClickUp LIST id. A ClickUp List is the unit a task belongs to
// and the unit the binding + webhook are scoped to, so every project-scoped call takes a
// list id: listStatuses reads the List's own `statuses[]`, importItems pages the List's
// tasks (GET /list/{id}/task?page=N).

import { createHmac, timingSafeEqual } from "node:crypto";
import { clickUpAuthHeaderValue } from "../clickup-app.js";
import {
  mapClickUpStatusType,
  mapClickUpTaskToItem,
  mapClickUpWebhookToEvents,
} from "./clickup-task-mapper.js";
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

export const CLICKUP_PROVIDER = "clickup";

// ClickUp API v2 base. Every request is `${CLICKUP_API_BASE}${path}`.
const CLICKUP_API_BASE = "https://api.clickup.com/api/v2";

// ClickUp pages list tasks 100 at a time (`?page=N`, 0-indexed). A page shorter than
// this — or a `last_page:true` flag — means there is no next page.
const CLICKUP_PAGE_SIZE = 100;

// HTTP 429 = ClickUp rate limit (the ~100 req/min token cap). importItems returns the
// SAME page as its cursor on a 429 so the caller can back off and resume, rather than
// throwing and losing the backfill position.
const HTTP_TOO_MANY_REQUESTS = 429;

export class ClickUpAdapter implements TaskIntegrationAdapter {
  readonly provider = CLICKUP_PROVIDER;

  // Verify a ClickUp webhook: the `X-Signature` header is the hex HMAC-SHA256 of the
  // EXACT raw request body keyed by the webhook's shared secret. Constant-time compared
  // (same discipline as slack-adapter). Pure + synchronous; never throws — a bad/missing
  // secret, signature, or length-mismatch returns false. The route must read the raw
  // body BEFORE parsing.
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
    secret: string,
  ): boolean {
    if (!secret) return false;
    const signature = headers["x-signature"];
    if (!signature) return false;

    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    // Length-guard so timingSafeEqual never throws on a mismatched-length input.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // Parse an ALREADY-VERIFIED ClickUp webhook body into normalized events. Pure; never
  // throws — delegates to the pure mapper, which returns [] for anything unrecognized.
  parseInbound(payload: unknown): NormalizedTaskEvent[] {
    try {
      return mapClickUpWebhookToEvents(payload);
    } catch {
      return [];
    }
  }

  // The selectable statuses of a ClickUp List (mapping UI + auto-seed). externalProjectId
  // is the LIST id: GET /list/{id} returns the List with its own `statuses[]` (each
  // { id, status, type, orderindex }). Ordered by orderindex so the UI shows the board's
  // real column order. Throws on a provider error so the caller can surface it.
  async listStatuses(token: string, externalProjectId: string): Promise<SourceStatus[]> {
    const res = await this.get(token, `/list/${encodeURIComponent(externalProjectId)}`);
    await assertOk(res, "listStatuses");
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    const rows = arr(json.statuses)
      .map((raw) => {
        const s = obj(raw);
        if (!s) return null;
        const id = asString(s.id).trim() || asString(s.status).trim();
        const name = asString(s.status).trim();
        if (!name) return null;
        const order = num(s.orderindex);
        const status: SourceStatus & { order: number } = {
          id,
          name,
          category: mapClickUpStatusType(asString(s.type), name),
          order: order ?? Number.MAX_SAFE_INTEGER,
        };
        return status;
      })
      .filter((s): s is SourceStatus & { order: number } => s !== null)
      .sort((x, y) => x.order - y.order);

    return rows.map(({ id, name, category }) => ({ id, name, category }));
  }

  // One page of a ClickUp List's tasks (batch import / backfill). externalProjectId is
  // the LIST id; `cursor` is the 0-indexed page number to fetch (absent → page 0). GET
  // /list/{id}/task?page=N. On a 429 (rate limit) returns the SAME page as the cursor
  // with no items, so the caller backs off and resumes without losing position; any other
  // non-ok response throws. nextCursor is page+1 while a full (non-last) page returns.
  async importItems(
    token: string,
    externalProjectId: string,
    cursor?: string,
  ): Promise<ImportItemsPage> {
    const page = parsePage(cursor);
    const res = await this.get(
      token,
      `/list/${encodeURIComponent(externalProjectId)}/task?page=${page}`,
    );

    if (res.status === HTTP_TOO_MANY_REQUESTS) {
      // intentional: best-effort stream cleanup; cancelling a rate-limited body isn't actionable.
      await res.body?.cancel().catch(() => {});
      return { items: [], nextCursor: String(page) };
    }
    await assertOk(res, "importItems");

    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const rawTasks = arr(json.tasks);
    const items: NormalizedTaskItem[] = [];
    for (const raw of rawTasks) {
      const item = mapClickUpTaskToItem(raw);
      if (item) items.push(item);
    }

    // ClickUp's `last_page` is authoritative; fall back to "a short page is the last one".
    const lastPage =
      typeof json.last_page === "boolean" ? json.last_page : rawTasks.length < CLICKUP_PAGE_SIZE;
    const hasMore = !lastPage && rawTasks.length > 0;
    return hasMore ? { items, nextCursor: String(page + 1) } : { items };
  }

  // WAVE 2 — write task fields back onto a ClickUp task: PUT /task/{id} with
  // name / description / priority / due_date / start_date. ClickUp is simple (no
  // transition validator). Assignee + label writes are DEFERRED: ClickUp assigns by
  // numeric user id (we hold an email) and tags via separate /task/{id}/tag endpoints, so
  // they are out of this best-effort field PUT. Throws on a provider error.
  async writeItem(token: string, patch: TaskItemWritePatch): Promise<void> {
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.name = patch.title;
    // ClickUp treats an empty-string description as a no-op; a single space is required to
    // actually BLANK a description. So clear -> " ", any real text passes through unchanged.
    if (patch.description !== undefined) body.description = patch.description ? patch.description : " ";
    if (patch.priority !== undefined) body.priority = priorityToClickUp(patch.priority);
    if (patch.dueAt !== undefined) body.due_date = patch.dueAt;
    if (patch.startAt !== undefined) body.start_date = patch.startAt;
    if (Object.keys(body).length === 0) return;

    const res = await this.put(token, `/task/${encodeURIComponent(patch.providerItemId)}`, body);
    await assertOk(res, "writeItem");
    // intentional: best-effort stream cleanup after a successful write; not actionable.
    await res.body?.cancel().catch(() => {});
  }

  // WAVE 2 — move a ClickUp task into a target status: PUT /task/{id} with
  // { status: <name> }. ClickUp sets status by its NAME (there is no transition graph to
  // validate). Throws on a provider error.
  async writeStatus(token: string, args: TaskStatusWriteArgs): Promise<void> {
    const res = await this.put(token, `/task/${encodeURIComponent(args.providerItemId)}`, {
      status: args.sourceStatusName,
    });
    await assertOk(res, "writeStatus");
    // intentional: best-effort stream cleanup after a successful write; not actionable.
    await res.body?.cancel().catch(() => {});
  }

  // ── private HTTP helpers (token in the Authorization header, verbatim) ──

  private get(token: string, path: string): Promise<Response> {
    return fetch(`${CLICKUP_API_BASE}${path}`, {
      method: "GET",
      headers: {
        Authorization: clickUpAuthHeaderValue(token),
        Accept: "application/json",
      },
    });
  }

  private put(token: string, path: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${CLICKUP_API_BASE}${path}`, {
      method: "PUT",
      headers: {
        Authorization: clickUpAuthHeaderValue(token),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }
}

// Stateless singleton — one instance serves every workspace's installation.
export const clickUpAdapter = new ClickUpAdapter();

// ─── helpers ─────────────────────────────────────────────────────────────

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// Parse an importItems cursor into a 0-indexed, non-negative page number. Absent /
// malformed → page 0.
function parsePage(cursor?: string): number {
  if (!cursor) return 0;
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Map a normalized TaskPriority to ClickUp's 1..4 scale (or null to clear). Inverse of
// the mapper's mapClickUpPriority (medium ↔ 3/Normal).
function priorityToClickUp(priority: TaskPriority): number | null {
  switch (priority) {
    case "urgent":
      return 1;
    case "high":
      return 2;
    case "medium":
      return 3;
    case "low":
      return 4;
    case "none":
      return null;
  }
}

// Throw a descriptive error on a non-2xx ClickUp response, draining the body so the
// stream never leaks. ClickUp error bodies carry an `err` message + `ECODE`.
async function assertOk(res: Response, op: string): Promise<void> {
  if (res.ok) return;
  // intentional: a non-2xx body may be non-JSON; fall back to the status-code message below.
  const detail = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const message = detail && typeof detail.err === "string" ? detail.err : `HTTP ${res.status}`;
  throw new Error(`ClickUp ${op} failed: ${message}`);
}
