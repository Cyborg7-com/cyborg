import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildReportBody,
  chunkSubjects,
  parseReportResponse,
  reportAccountBatch,
  runJiraPersonalDataReportCycle,
  MAX_ACCOUNTS_PER_REQUEST,
  type PersonalDataSubject,
  type ReportCycleSummary,
} from "./jira-personal-data.js";
import type { PgSync, StoredIntegrationInstallation } from "./db/pg-sync.js";

// The reporter uses the REAL resolveJiraAccessToken (imported from routes/jira.js): a fake
// install carries a PLAINTEXT access token (no "v1:" prefix), which decryptToken returns
// unchanged, and config = {} (no expiresAt) so no refresh network path runs. Env toggles
// isJiraConfigured() + keeps token decryption in legacy-plaintext mode.

const ENV_KEYS = ["JIRA_OAUTH_CLIENT_ID", "JIRA_OAUTH_CLIENT_SECRET", "CYBORG7_TOKEN_ENC_KEY"];
const SAVED_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
  process.env.JIRA_OAUTH_CLIENT_ID = "jira-client-id";
  process.env.JIRA_OAUTH_CLIENT_SECRET = "jira-client-secret";
  delete process.env.CYBORG7_TOKEN_ENC_KEY; // plaintext token mode (no v1: decrypt).
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

// A fetch stand-in with the pieces reportAccountBatch reads.
function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

describe("chunkSubjects", () => {
  function subjects(n: number): PersonalDataSubject[] {
    return Array.from({ length: n }, (_, i) => ({ accountId: `a${i}`, updatedAt: i }));
  }

  it("splits 181 into [90, 90, 1]", () => {
    const chunks = chunkSubjects(subjects(181), MAX_ACCOUNTS_PER_REQUEST);
    expect(chunks.map((c) => c.length)).toEqual([90, 90, 1]);
  });

  it("returns [] for 0 subjects", () => {
    expect(chunkSubjects([], MAX_ACCOUNTS_PER_REQUEST)).toEqual([]);
  });

  it("returns a single full chunk for exactly 90", () => {
    const chunks = chunkSubjects(subjects(90), MAX_ACCOUNTS_PER_REQUEST);
    expect(chunks.map((c) => c.length)).toEqual([90]);
  });
});

describe("buildReportBody", () => {
  it("maps updatedAt ms → exact RFC3339 ISO string, preserving accountId + order", () => {
    const ms = Date.UTC(2026, 0, 2, 3, 4, 5); // 2026-01-02T03:04:05.000Z
    const body = buildReportBody([
      { accountId: "acc-1", updatedAt: ms },
      { accountId: "acc-2", updatedAt: 0 },
    ]);
    expect(body).toEqual({
      accounts: [
        { accountId: "acc-1", updatedAt: "2026-01-02T03:04:05.000Z" },
        { accountId: "acc-2", updatedAt: "1970-01-01T00:00:00.000Z" },
      ],
    });
  });
});

describe("parseReportResponse", () => {
  it("maps a 200 mixed body to erase/refresh actions", () => {
    const actions = parseReportResponse(200, {
      accounts: [
        { accountId: "closed-1", status: "closed" },
        { accountId: "updated-1", status: "updated" },
        { accountId: "other-1", status: "somethingelse" },
      ],
    });
    expect(actions).toEqual([
      { accountId: "closed-1", action: "erase" },
      { accountId: "updated-1", action: "refresh" },
    ]);
  });

  it("returns [] for 204 / an empty body / a malformed body (no throw)", () => {
    expect(parseReportResponse(204, { accounts: [{ accountId: "x", status: "closed" }] })).toEqual(
      [],
    );
    expect(parseReportResponse(200, {})).toEqual([]);
    expect(parseReportResponse(200, "not-an-object")).toEqual([]);
    expect(parseReportResponse(200, { accounts: "nope" })).toEqual([]);
    expect(parseReportResponse(200, null)).toEqual([]);
  });
});

describe("reportAccountBatch", () => {
  const SUBJECTS: PersonalDataSubject[] = [{ accountId: "acc-1", updatedAt: 1_700_000_000_000 }];

  it("POSTs a Bearer body and parses a 200 with a Cycle-Period header", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return jsonResponse(
        200,
        {
          accounts: [
            { accountId: "closed-1", status: "closed" },
            { accountId: "updated-1", status: "updated" },
          ],
        },
        { "Cycle-Period": "604800" },
      );
    };

    const result = await reportAccountBatch("tok-abc", SUBJECTS, fetchImpl);

    expect(capturedUrl).toBe("https://api.atlassian.com/app/report-accounts/");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-abc");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      accounts: [{ accountId: "acc-1", updatedAt: "2023-11-14T22:13:20.000Z" }],
    });
    expect(result.statusCode).toBe(200);
    expect(result.actions).toEqual([
      { accountId: "closed-1", action: "erase" },
      { accountId: "updated-1", action: "refresh" },
    ]);
    expect(result.cyclePeriodMs).toBe(604800 * 1000);
  });

  it("returns no actions for a 204", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(204, null);
    const result = await reportAccountBatch("tok", SUBJECTS, fetchImpl);
    expect(result.statusCode).toBe(204);
    expect(result.actions).toEqual([]);
  });

  it("computes retryAfterMs from a 429 Retry-After header", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(429, { error: "rate limited" }, { "Retry-After": "30" });
    const result = await reportAccountBatch("tok", SUBJECTS, fetchImpl);
    expect(result.statusCode).toBe(429);
    expect(result.actions).toEqual([]);
    expect(result.retryAfterMs).toBe(30_000);
  });

  it("never throws on a transport error — returns statusCode 0", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("network boom");
    };
    const result = await reportAccountBatch("tok", SUBJECTS, fetchImpl);
    expect(result).toEqual({ statusCode: 0, actions: [], cyclePeriodMs: null, retryAfterMs: null });
  });
});

describe("runJiraPersonalDataReportCycle", () => {
  const CLOSED = "acct-0000";
  const UPDATED = "acct-0001";

  function makeSubjects(start: number, count: number): PersonalDataSubject[] {
    return Array.from({ length: count }, (_, i) => ({
      accountId: `acct-${String(start + i).padStart(4, "0")}`,
      updatedAt: 1_700_000_000_000,
    }));
  }

  // Fake pg: two enumerate pages (500 then a short 95 → 595 total), a plaintext-token install,
  // and an erase recorder. resolveJiraAccessToken runs for REAL against the plaintext token.
  function makePg(erased: string[]): PgSync {
    const install: StoredIntegrationInstallation = {
      id: "intg_1",
      workspaceId: "ws_1",
      provider: "jira",
      externalId: "cloud-1",
      config: {},
      accessToken: "plain-access-token",
      botUserId: null,
      scopes: null,
      installedBy: "u_1",
      createdAt: 1,
    };
    return {
      async listInstallationsByProvider() {
        return [install];
      },
      async enumerateJiraPersonalDataSubjects(after: string | null, limit: number) {
        if (after === null) return makeSubjects(0, limit); // full first page (500).
        if (after === "acct-0499") return makeSubjects(500, 95); // short final page.
        return [];
      },
      async eraseJiraPersonalDataSubject(accountId: string) {
        erased.push(accountId);
        return 1;
      },
    } as unknown as PgSync;
  }

  it("reports every subject, erases closed, counts refresh, totals correct", async () => {
    const erased: string[] = [];
    const pg = makePg(erased);
    // Return closed/updated only when their accountId is in the batch; else empty accounts.
    const fetchImpl: typeof fetch = async (_url, init) => {
      const ids = new Set(
        (JSON.parse(String(init?.body)) as { accounts: { accountId: string }[] }).accounts.map(
          (a) => a.accountId,
        ),
      );
      const accounts: { accountId: string; status: string }[] = [];
      if (ids.has(CLOSED)) accounts.push({ accountId: CLOSED, status: "closed" });
      if (ids.has(UPDATED)) accounts.push({ accountId: UPDATED, status: "updated" });
      return jsonResponse(200, { accounts });
    };

    const summary = await runJiraPersonalDataReportCycle(pg, { fetchImpl, logger: () => {} });

    expect(summary.configured).toBe(true);
    expect(summary.reported).toBe(595);
    expect(summary.batches).toBe(Math.ceil(595 / 90)); // 7
    expect(summary.erased).toBe(1);
    expect(summary.refreshRequested).toBe(1);
    expect(erased).toEqual([CLOSED]);
    expect(summary.errors).toEqual([]);
  });

  it("returns { configured:false } when Jira is unconfigured", async () => {
    delete process.env.JIRA_OAUTH_CLIENT_ID;
    delete process.env.JIRA_OAUTH_CLIENT_SECRET;
    const summary: ReportCycleSummary = await runJiraPersonalDataReportCycle(makePg([]));
    expect(summary).toEqual({
      configured: false,
      reported: 0,
      erased: 0,
      refreshRequested: 0,
      batches: 0,
      errors: [],
    });
  });

  it("records an error when no usable token resolves", async () => {
    const pg = {
      async listInstallationsByProvider() {
        return [];
      },
    } as unknown as PgSync;
    const summary = await runJiraPersonalDataReportCycle(pg, { logger: () => {} });
    expect(summary.configured).toBe(true);
    expect(summary.reported).toBe(0);
    expect(summary.errors).toEqual(["no usable jira token"]);
  });
});
