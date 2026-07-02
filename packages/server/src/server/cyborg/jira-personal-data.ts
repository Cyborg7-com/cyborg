// Atlassian Personal Data Reporting API — the OUTBOUND reporter for our Jira OAuth 2.0
// (3LO) integration.
//
// CONTRACT (the researched source of truth):
//   https://developer.atlassian.com/cloud/jira/platform/user-privacy-developer-guide/
//
// MODEL: for a 3LO OAuth app the flow is PUSH / OUTBOUND POLL — OUR app calls Atlassian;
// Atlassian NEVER calls us. There is NO inbound webhook and NO Atlassian request signature
// to verify (those are Connect/Forge concepts). This module only makes outbound calls to
//   POST https://api.atlassian.com/app/report-accounts/
// reporting every Jira accountId whose personal data we store, and erasing the ones
// Atlassian tells us are closed.
//
// WHERE THE DATA LIVES: provider_user_connections is the only place we store a Jira
// accountId (external_user_id) + email; the task-sync engine records it when it resolves an
// inbound assignee to a workspace member. This module enumerates those rows, reports them,
// and erases the accounts Atlassian reports "closed".
//
// WIRING: startJiraPersonalDataReportScheduler is EXPORTED for the relay to call at boot but
// is NOT yet wired into relay-standalone.ts main() (parity with createJiraRoutes not being
// mounted yet). The internal ops trigger (routes/jira.ts POST /personal-data-report/run)
// drives runJiraPersonalDataReportCycle on demand.

import type { PgSync } from "./db/pg-sync.js";
import { isJiraConfigured } from "./jira-app.js";
import { resolveJiraAccessToken } from "./routes/jira.js";

// The report-accounts endpoint (the app-level Atlassian API, not a site REST base).
export const REPORT_ACCOUNTS_URL = "https://api.atlassian.com/app/report-accounts/";
// Atlassian caps a single report request at 90 accounts.
export const MAX_ACCOUNTS_PER_REQUEST = 90;
// Default cadence between reports per accountId — 7 days (Atlassian's default cycle period).
export const DEFAULT_CYCLE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

// How many subjects to pull per keyset-pagination page when enumerating the whole app.
const ENUMERATE_PAGE_SIZE = 500;

// One personal-data subject: a Jira accountId + the epoch-ms time we retrieved its data.
export interface PersonalDataSubject {
  accountId: string;
  updatedAt: number;
}

// An action Atlassian's 200 response asks us to take for one accountId. "erase" = the
// account was closed (we MUST delete its stored personal data). "refresh" = our copy is
// invalidated (we MAY re-fetch — for this foundation we only count + log, no auto-refetch).
// (An interface, not a type alias, to satisfy oxlint consistent-type-definitions.)
export interface ReportAction {
  accountId: string;
  action: "erase" | "refresh";
}

// The parsed outcome of one report batch: HTTP status, the actions to take, and the cadence
// + back-off hints Atlassian returned via headers (ms; null when absent/unparseable).
export interface ReportBatchResult {
  statusCode: number;
  actions: ReportAction[];
  cyclePeriodMs: number | null;
  retryAfterMs: number | null;
}

// The summary of one full report cycle across the whole app.
export interface ReportCycleSummary {
  configured: boolean;
  reported: number;
  erased: number;
  refreshRequested: number;
  batches: number;
  errors: string[];
}

// ── untrusted-JSON coercion helpers (parity with jira-app.ts) ──

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}

// ── pure builders / parsers ──

/**
 * Build the report-accounts request body: each subject's retrieval time (epoch ms) is
 * emitted as an RFC 3339 string (new Date(ms).toISOString()). PURE. Order is preserved.
 */
export function buildReportBody(subjects: PersonalDataSubject[]): {
  accounts: { accountId: string; updatedAt: string }[];
} {
  return {
    accounts: subjects.map((s) => ({
      accountId: s.accountId,
      updatedAt: new Date(s.updatedAt).toISOString(),
    })),
  };
}

/** Split subjects into chunks of at most `size` (<=0 → []). PURE. */
export function chunkSubjects(
  subjects: PersonalDataSubject[],
  size: number,
): PersonalDataSubject[][] {
  if (size <= 0) return [];
  const chunks: PersonalDataSubject[][] = [];
  for (let i = 0; i < subjects.length; i += size) {
    chunks.push(subjects.slice(i, i + size));
  }
  return chunks;
}

/**
 * Parse Atlassian's report-accounts response into the actions to take. A 200 body lists
 * ONLY accounts needing action: status "closed" → erase, status "updated" → refresh. Any
 * other status (incl. 204 / a malformed body) → []. Defensive against untrusted JSON — never
 * throws. PURE.
 */
export function parseReportResponse(statusCode: number, body: unknown): ReportAction[] {
  if (statusCode !== 200 || !isRecord(body)) return [];
  const accounts = Array.isArray(body.accounts) ? body.accounts : [];
  const actions: ReportAction[] = [];
  for (const entry of accounts) {
    if (!isRecord(entry)) continue;
    const accountId = asString(entry.accountId).trim();
    if (!accountId) continue;
    const status = asString(entry.status).trim().toLowerCase();
    if (status === "closed") actions.push({ accountId, action: "erase" });
    else if (status === "updated") actions.push({ accountId, action: "refresh" });
  }
  return actions;
}

// Parse the Cycle-Period response header into ms.
// FLAG: the Cycle-Period header's unit is ASSUMED to be SECONDS (the guide states the
// default cycle period in days but does not give the header's unit); if this is wrong the
// 7-day DEFAULT_CYCLE_PERIOD_MS still applies. A non-positive / unparseable value → null.
function parseCyclePeriodMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

// Parse the Retry-After response header (seconds per HTTP) into ms. Negative / unparseable
// → null.
function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

// ── network ──

/**
 * Report ONE batch (<=90 subjects) to report-accounts. POSTs a Bearer-authed JSON body,
 * reads the Cycle-Period + Retry-After headers, and parses actions from a 200. NEVER throws
 * — a transport error returns { statusCode: 0, actions: [], cyclePeriodMs: null,
 * retryAfterMs: null }. Mirrors the jira-app.ts fetch idiom (safeText on !ok).
 */
export async function reportAccountBatch(
  token: string,
  subjects: PersonalDataSubject[],
  fetchImpl: typeof fetch = fetch,
): Promise<ReportBatchResult> {
  try {
    const res = await fetchImpl(REPORT_ACCOUNTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(buildReportBody(subjects)),
    });
    const statusCode = res.status;
    const cyclePeriodMs = parseCyclePeriodMs(res.headers.get("cycle-period"));
    const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
    let actions: ReportAction[] = [];
    if (statusCode === 200) {
      // intentional: a malformed 200 body simply yields no actions (parseReportResponse guards).
      const parsedBody: unknown = await res.json().catch(() => null);
      actions = parseReportResponse(statusCode, parsedBody);
    } else if (statusCode !== 204) {
      console.error(
        `[jira-personal-data] report-accounts returned ${statusCode}: ${await safeText(res)}`,
      );
    }
    return { statusCode, actions, cyclePeriodMs, retryAfterMs };
  } catch (err) {
    console.error("[jira-personal-data] report-accounts request failed", err);
    return { statusCode: 0, actions: [], cyclePeriodMs: null, retryAfterMs: null };
  }
}

// ── orchestration ──

// The first usable app bearer token: all Jira installs share ONE OAuth app, so any install's
// decrypted access token represents our app. null when none resolves.
async function resolveAnyJiraToken(pg: PgSync): Promise<string | null> {
  const installs = await pg.listInstallationsByProvider("jira");
  for (const install of installs) {
    const token = await resolveJiraAccessToken(pg, install);
    if (token) return token;
  }
  return null;
}

// Act on one batch's actions best-effort: erase closed accounts (counting rows), count +
// log refresh-requested ones. Extracted from the cycle to keep block nesting shallow.
async function applyReportActions(
  pg: PgSync,
  actions: ReportAction[],
  summary: ReportCycleSummary,
  log: (msg: string, err?: unknown) => void,
): Promise<void> {
  for (const action of actions) {
    if (action.action === "refresh") {
      summary.refreshRequested += 1;
      log(`refresh requested for ${action.accountId} (copy invalidated; not auto-refetched)`);
      continue;
    }
    try {
      const deleted = await pg.eraseJiraPersonalDataSubject(action.accountId);
      summary.erased += 1;
      log(`erased personal data for ${action.accountId} (${deleted} row(s))`);
    } catch (err) {
      summary.errors.push(`erase failed for ${action.accountId}: ${errMessage(err)}`);
      log(`erase failed for ${action.accountId}`, err);
    }
  }
}

// Enumerate ALL personal-data subjects app-wide via keyset pagination — accumulate pages
// until a short page (< page size) signals the end. Dedupe is handled by the DAL group-by.
async function enumerateAllSubjects(pg: PgSync): Promise<PersonalDataSubject[]> {
  const subjects: PersonalDataSubject[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await pg.enumerateJiraPersonalDataSubjects(after, ENUMERATE_PAGE_SIZE);
    for (const row of page) {
      subjects.push({ accountId: row.accountId, updatedAt: row.updatedAt });
      after = row.accountId;
    }
    if (page.length < ENUMERATE_PAGE_SIZE) break;
  }
  return subjects;
}

/**
 * Run ONE full Personal Data Reporting cycle: obtain an app token, enumerate every stored
 * Jira accountId, report them in <=90 batches, and act on the response (erase closed
 * accounts; count refresh-requested ones). Best-effort throughout — a single batch failure
 * logs + continues; a 429 stops further batches this cycle (we do NOT sleep, to avoid
 * hammering). NEVER throws to the caller. Returns { configured:false } when Jira is
 * unconfigured.
 */
export async function runJiraPersonalDataReportCycle(
  pg: PgSync,
  opts: { fetchImpl?: typeof fetch; logger?: (msg: string, err?: unknown) => void } = {},
): Promise<ReportCycleSummary> {
  const log = opts.logger ?? ((msg, err) => console.log(`[jira-personal-data] ${msg}`, err ?? ""));
  const summary: ReportCycleSummary = {
    configured: false,
    reported: 0,
    erased: 0,
    refreshRequested: 0,
    batches: 0,
    errors: [],
  };
  if (!isJiraConfigured()) return summary;
  summary.configured = true;

  try {
    const token = await resolveAnyJiraToken(pg);
    if (!token) {
      summary.errors.push("no usable jira token");
      return summary;
    }

    const subjects = await enumerateAllSubjects(pg);
    for (const chunk of chunkSubjects(subjects, MAX_ACCOUNTS_PER_REQUEST)) {
      const result = await reportAccountBatch(token, chunk, opts.fetchImpl);
      summary.batches += 1;
      summary.reported += chunk.length;

      if (result.statusCode === 429) {
        summary.errors.push(
          `rate-limited (429); stopping cycle (retry-after ${result.retryAfterMs ?? 0}ms)`,
        );
        break;
      }
      if (result.statusCode === 0) {
        summary.errors.push("batch transport error");
        continue;
      }

      await applyReportActions(pg, result.actions, summary, log);
    }
  } catch (err) {
    // Never throw to the caller — a cycle-level failure is recorded and the next cycle retries.
    summary.errors.push(`cycle failed: ${errMessage(err)}`);
    log("cycle failed", err);
  }
  return summary;
}

/**
 * Start the periodic reporter. Mirrors the relay's setInterval(...).unref() sweep pattern.
 * Fires at most weekly (DEFAULT_CYCLE_PERIOD_MS) to honor the per-account cadence, gated on
 * isJiraConfigured() each tick. EXPORTED for the relay to call at boot; NOT yet wired into
 * relay-standalone.ts main() (parity with createJiraRoutes not being mounted yet).
 */
export function startJiraPersonalDataReportScheduler(
  pg: PgSync,
  opts: { fetchImpl?: typeof fetch } = {},
): { stop: () => void } {
  const timer = setInterval(() => {
    if (!isJiraConfigured()) return;
    void runJiraPersonalDataReportCycle(pg, { fetchImpl: opts.fetchImpl }).catch((err: unknown) => {
      // intentional: the report cycle is best-effort housekeeping — a failure logs and the
      // next weekly tick retries; it must never crash the relay's timer loop.
      console.error("[jira-personal-data] report cycle failed", err);
    });
  }, DEFAULT_CYCLE_PERIOD_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
