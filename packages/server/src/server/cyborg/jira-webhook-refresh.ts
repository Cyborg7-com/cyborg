// Jira dynamic-webhook refresh sweep. A webhook registered via the REST API expires 30 days
// after creation/refresh, so the auto-registered webhooks (routes/jira.ts) would silently go
// dead without periodic extension. This sweep enumerates every Jira install, finds the
// webhook records stored on its config that are within REFRESH_THRESHOLD_MS of expiry, calls
// the Extend-webhook-life API (jiraAdapter.refreshWebhooks → PUT /rest/api/3/webhook/refresh),
// and writes the new expiry back. It is BEST-EFFORT per install: one install's failure (no
// token, revoked grant, provider error) is logged and the sweep continues.
//
// Docs: https://developer.atlassian.com/cloud/jira/platform/webhooks/ ("Webhooks registered
// with the REST API expire after 30 days ... call the Extend webhook life API to keep them
// alive"). REST group:
// https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-webhooks/#api-rest-api-3-webhook-refresh-put
//
// NOTE: startJiraWebhookRefreshScheduler is EXPORTED but intentionally NOT wired into
// relay-standalone.ts here — the relay owns booting it (parity with the personal-data
// reporter's unwired scheduler).

import type { PgSync, StoredIntegrationInstallation } from "./db/pg-sync.js";
import { isJiraConfigured } from "./jira-app.js";
import {
  jiraAdapter,
  JIRA_PROVIDER,
  type JiraWebhookRefreshResult,
} from "./integrations/jira-adapter.js";
import {
  persistJiraWebhookRecords,
  readJiraWebhookRecords,
  resolveJiraAccessToken,
  type JiraWebhookRecord,
} from "./routes/jira.js";

// Refresh a webhook once it is within 7 days of its 30-day expiry — early enough to absorb a
// missed daily sweep (a stalled relay) without letting a webhook actually lapse.
const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

// Run the sweep daily; each 30-day webhook only needs one successful refresh per month, so a
// daily cadence is cheap and gives ~7 retry chances inside the threshold window.
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// The token resolver + refresh caller are injectable so tests drive the sweep without a
// network or the encrypted-token machinery.
export interface RefreshDueDeps {
  now?: () => number;
  thresholdMs?: number;
  listInstalls?: (pg: PgSync) => Promise<StoredIntegrationInstallation[]>;
  resolveToken?: (pg: PgSync, install: StoredIntegrationInstallation) => Promise<string | null>;
  refreshWebhooks?: (
    token: string,
    cloudId: string,
    webhookIds: number[],
  ) => Promise<JiraWebhookRefreshResult>;
}

// What one sweep did — for logging + test assertions.
export interface JiraWebhookRefreshSummary {
  installs: number;
  dueWebhooks: number;
  refreshed: number;
  failed: number;
  errors: string[];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Refresh every near-expiry Jira webhook across all installs. Never throws — a top-level or
// per-install failure is captured in the returned summary's `errors` and the sweep proceeds.
export async function refreshDueJiraWebhooks(
  pg: PgSync,
  deps: RefreshDueDeps = {},
): Promise<JiraWebhookRefreshSummary> {
  const now = deps.now ?? (() => Date.now());
  const thresholdMs = deps.thresholdMs ?? REFRESH_THRESHOLD_MS;
  const listInstalls =
    deps.listInstalls ?? ((p: PgSync) => p.listInstallationsByProvider(JIRA_PROVIDER));
  const resolveToken = deps.resolveToken ?? resolveJiraAccessToken;
  const refreshWebhooks =
    deps.refreshWebhooks ??
    ((token: string, cloudId: string, ids: number[]) =>
      jiraAdapter.refreshWebhooks(token, cloudId, ids));

  const summary: JiraWebhookRefreshSummary = {
    installs: 0,
    dueWebhooks: 0,
    refreshed: 0,
    failed: 0,
    errors: [],
  };

  let installs: StoredIntegrationInstallation[];
  try {
    installs = await listInstalls(pg);
  } catch (err) {
    summary.errors.push(`list installs failed: ${errMsg(err)}`);
    return summary;
  }
  summary.installs = installs.length;

  const cutoff = now() + thresholdMs;
  for (const install of installs) {
    await refreshInstallWebhooks(pg, install, {
      cutoff,
      now,
      resolveToken,
      refreshWebhooks,
      summary,
    });
  }
  return summary;
}

interface RefreshInstallCtx {
  cutoff: number;
  now: () => number;
  resolveToken: (pg: PgSync, install: StoredIntegrationInstallation) => Promise<string | null>;
  refreshWebhooks: (
    token: string,
    cloudId: string,
    webhookIds: number[],
  ) => Promise<JiraWebhookRefreshResult>;
  summary: JiraWebhookRefreshSummary;
}

// Refresh the due webhooks of ONE install, best-effort. Extracted so refreshDueJiraWebhooks
// stays within the per-function complexity budget.
async function refreshInstallWebhooks(
  pg: PgSync,
  install: StoredIntegrationInstallation,
  ctx: RefreshInstallCtx,
): Promise<void> {
  const records = readJiraWebhookRecords(install);
  const due = Object.entries(records).filter(([, record]) => record.expiresAt < ctx.cutoff);
  if (due.length === 0) return;
  ctx.summary.dueWebhooks += due.length;

  let token: string | null;
  try {
    token = await ctx.resolveToken(pg, install);
  } catch (err) {
    ctx.summary.failed += due.length;
    ctx.summary.errors.push(`[${install.id}] token resolve failed: ${errMsg(err)}`);
    return;
  }
  if (!token) {
    ctx.summary.failed += due.length;
    ctx.summary.errors.push(`[${install.id}] no usable token`);
    return;
  }

  const next: Record<string, JiraWebhookRecord> = { ...records };
  let changed = false;
  for (const [key, record] of due) {
    const result = await ctx.refreshWebhooks(token, install.externalId, record.webhookIds);
    if (!result.ok) {
      ctx.summary.failed += 1;
      ctx.summary.errors.push(`[${install.id}:${key}] refresh failed: ${result.error}`);
      continue;
    }
    const expiresAt = Date.parse(result.expirationDate) || ctx.now();
    next[key] = { webhookIds: record.webhookIds, expiresAt };
    ctx.summary.refreshed += 1;
    changed = true;
  }
  if (!changed) return;

  // Persist onto the FRESHEST install row — resolveToken may have rotated + re-persisted the
  // access token, so re-read to avoid writing back a stale (older) token column.
  let target = install;
  try {
    const reread = await pg.getIntegrationInstallationById(install.id);
    if (reread) target = reread;
  } catch (err) {
    ctx.summary.errors.push(`[${install.id}] reread failed: ${errMsg(err)}`);
  }
  try {
    await persistJiraWebhookRecords(pg, target, next);
  } catch (err) {
    ctx.summary.errors.push(`[${install.id}] persist failed: ${errMsg(err)}`);
  }
}

// Start the daily refresh sweep. Mirrors the personal-data reporter's setInterval(...).unref()
// pattern: gated on isJiraConfigured() each tick, best-effort (a failed sweep logs and the
// next tick retries), and unref'd so it never keeps the process alive. EXPORTED for the relay
// to call at boot; NOT wired into relay-standalone.ts here.
export function startJiraWebhookRefreshScheduler(pg: PgSync): { stop: () => void } {
  const timer = setInterval(() => {
    if (!isJiraConfigured()) return;
    void refreshDueJiraWebhooks(pg)
      .then((summary) => {
        if (summary.refreshed > 0 || summary.failed > 0) {
          console.log(
            `[jira] webhook refresh sweep: refreshed=${summary.refreshed} ` +
              `failed=${summary.failed} due=${summary.dueWebhooks} installs=${summary.installs}`,
          );
        }
      })
      .catch((err: unknown) => {
        // intentional: the sweep is best-effort housekeeping — a failure logs and the next
        // daily tick retries; it must never crash the relay's timer loop.
        console.error("[jira] webhook refresh sweep failed", err);
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
