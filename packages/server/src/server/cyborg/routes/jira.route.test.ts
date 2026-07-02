import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { type Context, type Next } from "hono";
import { signJiraOAuthState, verifyJiraOAuthState, createJiraRoutes } from "./jira.js";
import { jiraAdapter } from "../integrations/jira-adapter.js";
import { encryptToken } from "../task-sync-crypto.js";
import type { PgSync } from "../db/pg-sync.js";
import type { RelayEnv } from "./types.js";

// Drive the REAL Jira sub-app (createJiraRoutes → app.request) over a typed-fake pg, with
// jira-app's token exchange + the engine's dispatch mocked so no network / DB is touched.
// The env-reading gates (isJiraConfigured / getJiraOAuthClientId / getJiraOAuthClientSecret)
// stay REAL — a partial module mock replaces only the network functions — so the signed
// `state` HMAC and the credential gate exercise the true code paths.
const { mockExchangeCode, mockGetResources, mockRefresh, mockDispatch, mockRunReportCycle } =
  vi.hoisted(() => ({
    mockExchangeCode: vi.fn(),
    mockGetResources: vi.fn(),
    mockRefresh: vi.fn(),
    mockDispatch: vi.fn(),
    mockRunReportCycle: vi.fn(),
  }));

vi.mock("../jira-app.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../jira-app.js")>();
  return {
    ...actual,
    exchangeCode: mockExchangeCode,
    getAccessibleResources: mockGetResources,
    refreshAccessToken: mockRefresh,
  };
});

vi.mock("../task-sync-engine.js", () => ({ dispatchInboundTaskEvents: mockDispatch }));

// Hermetic endpoint tests: mock the reporter so the /personal-data-report/run route is
// exercised without touching the real cycle (network / DB).
vi.mock("../jira-personal-data.js", () => ({ runJiraPersonalDataReportCycle: mockRunReportCycle }));

// Module-scope no-op so console spies pass a reference (keeps the deeply-nested
// describe → it → spy chain under oxlint max-nested-callbacks).
function noop(): void {}

const WS = "ws_caller";
const OTHER_WS = "ws_victim";
const USER_ID = "u_member";
const APP_URL = "https://app.cyborg7.com";
const CLOUD_ID = "cloud-xyz";
const INSTALL_ID = "intg_install";
// A valid base64 32-byte token-encryption key, so tokens are actually encrypted at rest and
// the callback test can assert the "v1:" ciphertext prefix.
const ENC_KEY = Buffer.alloc(32, 7).toString("base64");

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "JIRA_OAUTH_CLIENT_ID",
  "JIRA_OAUTH_CLIENT_SECRET",
  "JIRA_OAUTH_CALLBACK_BASE",
  "CYBORG_APP_URL",
  "CYBORG7_TOKEN_ENC_KEY",
  "JIRA_PERSONAL_DATA_REPORT_SECRET",
] as const;

beforeAll(() => {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

beforeEach(() => {
  process.env.JIRA_OAUTH_CLIENT_ID = "jira-client-id";
  process.env.JIRA_OAUTH_CLIENT_SECRET = "jira-client-secret-abc";
  process.env.CYBORG_APP_URL = APP_URL;
  process.env.CYBORG7_TOKEN_ENC_KEY = ENC_KEY;
  delete process.env.JIRA_OAUTH_CALLBACK_BASE;
  delete process.env.JIRA_PERSONAL_DATA_REPORT_SECRET;
  mockExchangeCode.mockReset();
  mockGetResources.mockReset();
  mockRefresh.mockReset();
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue(undefined);
  mockRunReportCycle.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// A pass-through requireAuth stub that sets the authed user (parity with slack-oauth.test).
function authStub(userId = USER_ID) {
  return async (c: Context<RelayEnv>, next: Next) => {
    c.set("userId", userId);
    c.set("userEmail", `${userId}@e2e.dev`);
    await next();
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Signed OAuth state — the load-bearing primitive: the PUBLIC callback trusts ONLY a
// state our server minted (via /config, after an isMember check) before writing a
// credential-bearing install row.
// ──────────────────────────────────────────────────────────────────────────────
describe("jira OAuth state sign/verify", () => {
  it("round-trips a valid {workspaceId, userId}", () => {
    const state = signJiraOAuthState({ workspaceId: WS, userId: USER_ID });
    expect(verifyJiraOAuthState(state)).toEqual({ workspaceId: WS, userId: USER_ID });
  });

  it("rejects a tampered payload (HMAC no longer matches)", () => {
    const state = signJiraOAuthState({ workspaceId: WS, userId: USER_ID });
    const [, sig] = state.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ workspaceId: OTHER_WS, userId: "attacker" }),
    ).toString("base64url");
    expect(verifyJiraOAuthState(`${forgedBody}.${sig}`)).toBeNull();
  });

  it("rejects a malformed / unsigned state", () => {
    expect(verifyJiraOAuthState("")).toBeNull();
    expect(verifyJiraOAuthState("not-a-signed-state")).toBeNull();
  });

  it("rejects a state signed with a different secret", () => {
    const state = signJiraOAuthState({ workspaceId: WS, userId: USER_ID });
    process.env.JIRA_OAUTH_CLIENT_SECRET = "a-different-secret";
    expect(verifyJiraOAuthState(state)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/jira/config — credential gate + stable, byte-identical redirect_uri.
// ──────────────────────────────────────────────────────────────────────────────
describe("GET /api/jira/config", () => {
  function makeApp(isMember: boolean) {
    const pg = {
      async isMember(workspaceId: string, userId: string) {
        return isMember && workspaceId === WS && userId === USER_ID;
      },
    } as unknown as PgSync;
    return createJiraRoutes({ pg, requireAuth: authStub() });
  }

  it("configured:false when the OAuth secrets are absent", async () => {
    delete process.env.JIRA_OAUTH_CLIENT_ID;
    delete process.env.JIRA_OAUTH_CLIENT_SECRET;
    const res = await makeApp(true).request(`/api/jira/config?workspaceId=${WS}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, authorizeUrl: null });
  });

  it("member → authorizeUrl with a stable redirect_uri, ignoring X-Forwarded-Host", async () => {
    const res = await makeApp(true).request(`/api/jira/config?workspaceId=${WS}`, {
      method: "GET",
      headers: { "X-Forwarded-Host": "evil.example.com", "X-Forwarded-Proto": "https" },
    });
    expect(res.status).toBe(200);
    const { configured, authorizeUrl } = (await res.json()) as {
      configured: boolean;
      authorizeUrl: string;
    };
    expect(configured).toBe(true);
    expect(authorizeUrl).not.toContain("evil.example.com");
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get("redirect_uri")).toBe(`${APP_URL}/api/jira/oauth/callback`);
    // The signed state must verify back to the caller's (workspaceId, userId).
    expect(verifyJiraOAuthState(url.searchParams.get("state") ?? "")).toEqual({
      workspaceId: WS,
      userId: USER_ID,
    });
    // manage:jira-webhook MUST be requested — Atlassian only grants scopes present in the
    // authorize URL, and without it webhook auto-registration 403s (silent manual fallback).
    const scopes = (url.searchParams.get("scope") ?? "").split(" ");
    expect(scopes).toContain("manage:jira-webhook");
    expect(scopes).toContain("read:jira-work");
    expect(scopes).toContain("write:jira-work");
    expect(scopes).toContain("offline_access");
  });

  it("non-member → 403", async () => {
    const res = await makeApp(false).request(`/api/jira/config?workspaceId=${WS}`);
    expect(res.status).toBe(403);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/jira/oauth/callback — PUBLIC redirect matrix + tokens ENCRYPTED at rest.
// ──────────────────────────────────────────────────────────────────────────────
describe("GET /api/jira/oauth/callback", () => {
  function makeApp(upserts: Array<Record<string, unknown>>) {
    const pg = {
      async upsertIntegrationInstallation(opts: Record<string, unknown>) {
        upserts.push(opts);
        return String(opts.id);
      },
    } as unknown as PgSync;
    return createJiraRoutes({ pg, requireAuth: authStub() });
  }

  function validState(): string {
    return signJiraOAuthState({ workspaceId: WS, userId: USER_ID });
  }

  function hit(app: ReturnType<typeof makeApp>, state: string): Promise<Response> {
    return app.request(`/api/jira/oauth/callback?code=code_abc&state=${encodeURIComponent(state)}`);
  }

  it("valid state + success → 302 ?jira=connected, install stored with ENCRYPTED tokens", async () => {
    const upserts: Array<Record<string, unknown>> = [];
    mockExchangeCode.mockResolvedValue({
      ok: true,
      accessToken: "jira-access",
      refreshToken: "jira-refresh",
      expiresInSeconds: 3600,
      scope: "read:jira-work",
      tokenType: "Bearer",
    });
    mockGetResources.mockResolvedValue([
      { id: CLOUD_ID, url: "https://acme.atlassian.net", name: "Acme", scopes: [] },
    ]);
    const res = await hit(makeApp(upserts), validState());
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith(`${APP_URL}/`)).toBe(true);
    expect(loc.endsWith("/settings/integrations/jira?jira=connected")).toBe(true);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      provider: "jira",
      externalId: CLOUD_ID,
      installedBy: USER_ID,
    });
    // Tokens must be stored as "v1:" ciphertext, never plaintext.
    expect(String(upserts[0]?.accessToken)).toMatch(/^v1:/);
    expect(String(upserts[0]?.accessToken)).not.toContain("jira-access");
    const cfg = upserts[0]?.config as Record<string, unknown>;
    expect(String(cfg.refreshToken)).toMatch(/^v1:/);
  });

  it("forged / unsigned state → 302 root ?jira=oauth_error, no upsert, no exchange", async () => {
    const upserts: Array<Record<string, unknown>> = [];
    const res = await hit(makeApp(upserts), "forged.state");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_URL}/?jira=oauth_error`);
    expect(upserts).toHaveLength(0);
    expect(mockExchangeCode).not.toHaveBeenCalled();
  });

  it("exchange returns {ok:false} → 302 ?jira=oauth_error, no upsert", async () => {
    const upserts: Array<Record<string, unknown>> = [];
    mockExchangeCode.mockResolvedValue({ ok: false, error: "bad_code" });
    const res = await hit(makeApp(upserts), validState());
    expect(res.status).toBe(302);
    expect(
      (res.headers.get("location") ?? "").endsWith("/integrations/jira?jira=oauth_error"),
    ).toBe(true);
    expect(upserts).toHaveLength(0);
  });

  it("exchange that throws → 302 ?jira=oauth_error (caught, never a 500)", async () => {
    const upserts: Array<Record<string, unknown>> = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(noop);
    mockExchangeCode.mockRejectedValue(new Error("network boom"));
    const res = await hit(makeApp(upserts), validState());
    expect(res.status).toBe(302);
    expect((res.headers.get("location") ?? "").endsWith("jira=oauth_error")).toBe(true);
    expect(upserts).toHaveLength(0);
    errorSpy.mockRestore();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/jira/installations — token-strip invariant + membership.
// ──────────────────────────────────────────────────────────────────────────────
describe("GET /api/jira/installations — token strip", () => {
  const ROW = {
    id: INSTALL_ID,
    workspaceId: WS,
    provider: "jira",
    externalId: CLOUD_ID,
    config: {
      siteUrl: "https://acme.atlassian.net",
      siteName: "Acme",
      scope: "read:jira-work",
      refreshToken: "v1:SECRET-REFRESH",
      webhookSecret: "SECRET-WEBHOOK",
    },
    accessToken: "v1:SECRET-ACCESS",
    botUserId: null,
    scopes: "read:jira-work",
    installedBy: USER_ID,
    createdAt: 1,
  };

  function makeApp(isMember: boolean) {
    const pg = {
      async isMember(workspaceId: string, userId: string) {
        return isMember && workspaceId === WS && userId === USER_ID;
      },
      async listIntegrationInstallations() {
        return [ROW];
      },
    } as unknown as PgSync;
    return createJiraRoutes({ pg, requireAuth: authStub() });
  }

  it("member → 200 and the row omits accessToken + config secrets", async () => {
    const res = await makeApp(true).request(`/api/jira/installations?workspaceId=${WS}`);
    expect(res.status).toBe(200);
    const { installations } = (await res.json()) as {
      installations: Array<Record<string, unknown>>;
    };
    expect(installations).toHaveLength(1);
    const row = installations[0]!;
    expect("accessToken" in row).toBe(false);
    const cfg = row.config as Record<string, unknown>;
    expect("refreshToken" in cfg).toBe(false);
    expect("webhookSecret" in cfg).toBe(false);
    expect(cfg).toMatchObject({ siteUrl: "https://acme.atlassian.net", siteName: "Acme" });
    expect(JSON.stringify(installations)).not.toContain("SECRET");
  });

  it("non-member → 403", async () => {
    const res = await makeApp(false).request(`/api/jira/installations?workspaceId=${WS}`);
    expect(res.status).toBe(403);
  });

  it("missing workspaceId → 400", async () => {
    const res = await makeApp(true).request(`/api/jira/installations`);
    expect(res.status).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// BOLA — DELETE /installation/:id and DELETE /project-sync/:id.
// ──────────────────────────────────────────────────────────────────────────────
describe("DELETE /api/jira/installation/:id — BOLA", () => {
  function makeApp(installWorkspaceId: string | null, deletes: string[]) {
    const pg = {
      async isMember(workspaceId: string, userId: string) {
        return workspaceId === WS && userId === USER_ID;
      },
      async getIntegrationInstallationById(id: string) {
        return installWorkspaceId === null
          ? null
          : { id, workspaceId: installWorkspaceId, provider: "jira" };
      },
      async deleteIntegrationInstallation(id: string) {
        deletes.push(id);
      },
    } as unknown as PgSync;
    return createJiraRoutes({ pg, requireAuth: authStub() });
  }

  it("target owned by ANOTHER workspace → 404, delete NOT called", async () => {
    const deletes: string[] = [];
    const res = await makeApp(OTHER_WS, deletes).request(
      `/api/jira/installation/intg_x?workspaceId=${WS}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
    expect(deletes).toHaveLength(0);
  });

  it("target in the caller's workspace → 200, delete called", async () => {
    const deletes: string[] = [];
    const res = await makeApp(WS, deletes).request(
      `/api/jira/installation/intg_x?workspaceId=${WS}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    expect(deletes).toEqual(["intg_x"]);
  });
});

describe("DELETE /api/jira/project-sync/:id — BOLA", () => {
  function makeApp(isMember: boolean, deletes: Array<{ id: string; ws: string }>) {
    const pg = {
      async isMember(workspaceId: string, userId: string) {
        return isMember && workspaceId === WS && userId === USER_ID;
      },
      async deleteProjectSync(id: string, workspaceId: string) {
        deletes.push({ id, ws: workspaceId });
      },
    } as unknown as PgSync;
    return createJiraRoutes({ pg, requireAuth: authStub() });
  }

  it("non-member → 403, delete NOT called", async () => {
    const deletes: Array<{ id: string; ws: string }> = [];
    const res = await makeApp(false, deletes).request(
      `/api/jira/project-sync/psync_1?workspaceId=${WS}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(403);
    expect(deletes).toHaveLength(0);
  });

  it("member → 200, deleteProjectSync scoped by (id, workspaceId)", async () => {
    const deletes: Array<{ id: string; ws: string }> = [];
    const res = await makeApp(true, deletes).request(
      `/api/jira/project-sync/psync_1?workspaceId=${WS}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    expect(deletes).toEqual([{ id: "psync_1", ws: WS }]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/jira/project-syncs — binds + seeds status_mappings by category→group affinity.
// ──────────────────────────────────────────────────────────────────────────────
describe("POST /api/jira/project-syncs — bind + seed affinity mappings", () => {
  const TASKS_PROJECT = "proj_1";
  const STATES = [
    {
      id: "st_backlog",
      projectId: TASKS_PROJECT,
      workspaceId: WS,
      name: "Backlog",
      color: "#111",
      group: "backlog",
      sequence: 0,
      isDefault: true,
    },
    {
      id: "st_started",
      projectId: TASKS_PROJECT,
      workspaceId: WS,
      name: "In Progress",
      color: "#222",
      group: "started",
      sequence: 1,
      isDefault: false,
    },
    {
      id: "st_done",
      projectId: TASKS_PROJECT,
      workspaceId: WS,
      name: "Done",
      color: "#333",
      group: "completed",
      sequence: 2,
      isDefault: false,
    },
  ];
  const SOURCE_STATUSES = [
    { id: "1", name: "To Do", category: "unstarted" as const },
    { id: "3", name: "In Progress", category: "started" as const },
    { id: "5", name: "Done", category: "completed" as const },
  ];

  interface Recorded {
    mappings: Array<Record<string, unknown>>;
    binds: Array<Record<string, unknown>>;
    installUpserts: Array<Record<string, unknown>>;
  }

  function makeApp(rec: Recorded, installWorkspace = WS) {
    const pg = {
      async resolveTasksProjectId(id: string) {
        return id === TASKS_PROJECT ? TASKS_PROJECT : null;
      },
      async getTasksProjectWorkspace() {
        return WS;
      },
      async isMember(workspaceId: string, userId: string) {
        return workspaceId === WS && userId === USER_ID;
      },
      async getIntegrationInstallationById(id: string) {
        return id === INSTALL_ID
          ? {
              id: INSTALL_ID,
              workspaceId: installWorkspace,
              provider: "jira",
              externalId: CLOUD_ID,
              config: { expiresAt: Date.now() + 3_600_000 },
              accessToken: encryptToken("live-token"),
              botUserId: null,
              scopes: "read:jira-work",
              installedBy: USER_ID,
              createdAt: 1,
            }
          : null;
      },
      async upsertProjectSync(opts: Record<string, unknown>) {
        rec.binds.push(opts);
        return "psync_new";
      },
      async getProjectStates() {
        return STATES;
      },
      async upsertStatusMapping(opts: Record<string, unknown>) {
        rec.mappings.push(opts);
        return `stmap_${rec.mappings.length}`;
      },
      async upsertIntegrationInstallation(opts: Record<string, unknown>) {
        rec.installUpserts.push(opts);
        return String(opts.id);
      },
    } as unknown as PgSync;
    return createJiraRoutes({ pg, requireAuth: authStub() });
  }

  function post(app: ReturnType<typeof makeApp>, body: Record<string, unknown>) {
    return app.request("/api/jira/project-syncs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  const VALID_BODY = {
    tasksProjectId: TASKS_PROJECT,
    installationId: INSTALL_ID,
    externalProjectId: `${CLOUD_ID}:ENG`,
    externalProjectName: "Engineering",
  };

  it("auto-registers the webhook on bind, seeds affinity mappings, and persists id + expiry", async () => {
    const rec: Recorded = { mappings: [], binds: [], installUpserts: [] };
    vi.spyOn(jiraAdapter, "listStatuses").mockResolvedValue(SOURCE_STATUSES);
    const EXPIRY = "2027-01-01T00:00:00.000Z";
    const registerSpy = vi
      .spyOn(jiraAdapter, "registerWebhook")
      .mockResolvedValue({ ok: true, registration: { webhookIds: [42], expirationDate: EXPIRY } });

    const res = await post(makeApp(rec), VALID_BODY);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      binding: Record<string, unknown>;
      statusMappings: Array<{ sourceStatusName: string; taskStateId: string | null }>;
      webhook: {
        url: string;
        autoRegistered: boolean;
        manualRegistrationRequired: boolean;
        expiresAt: number;
      };
    };
    expect(rec.binds).toHaveLength(1);
    // Affinity seeding is unchanged by auto-registration.
    expect(rec.mappings).toHaveLength(3);
    const byName = new Map(json.statusMappings.map((m) => [m.sourceStatusName, m.taskStateId]));
    expect(byName.get("To Do")).toBeNull();
    expect(byName.get("In Progress")).toBe("st_started");
    expect(byName.get("Done")).toBe("st_done");
    // The webhook was auto-registered — no manual step, and the 30-day expiry is surfaced.
    expect(json.webhook.autoRegistered).toBe(true);
    expect(json.webhook.manualRegistrationRequired).toBe(false);
    expect(json.webhook.expiresAt).toBe(Date.parse(EXPIRY));
    // registerWebhook received our receiver URL (install id + secret), the mapper's events, + JQL.
    const [, cloudArg, args] = registerSpy.mock.calls[0]!;
    expect(cloudArg).toBe(CLOUD_ID);
    expect(args.url).toContain(`install=${INSTALL_ID}`);
    expect(args.url).toContain("secret=");
    expect(args.events).toEqual([
      "jira:issue_created",
      "jira:issue_updated",
      "jira:issue_deleted",
      "comment_created",
    ]);
    expect(args.jqlFilter).toBe('project = "ENG"');
    // The webhook id + expiry are persisted on the install CONFIG (no schema migration).
    const stored = rec.installUpserts
      .map(
        (u) =>
          (u.config as { webhooks?: Record<string, { webhookIds: number[]; expiresAt: number }> })
            .webhooks,
      )
      .find((w) => w && w[`${CLOUD_ID}:ENG`]);
    expect(stored?.[`${CLOUD_ID}:ENG`]).toEqual({
      webhookIds: [42],
      expiresAt: Date.parse(EXPIRY),
    });
  });

  it("falls back to the manual URL when auto-registration fails — the bind still succeeds", async () => {
    const rec: Recorded = { mappings: [], binds: [], installUpserts: [] };
    vi.spyOn(jiraAdapter, "listStatuses").mockResolvedValue(SOURCE_STATUSES);
    vi.spyOn(jiraAdapter, "registerWebhook").mockResolvedValue({
      ok: false,
      status: 403,
      error: "register failed: 403 Forbidden",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(noop);

    const res = await post(makeApp(rec), VALID_BODY);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      binding: { id: string };
      webhook: {
        url: string;
        secret: string;
        autoRegistered: boolean;
        manualRegistrationRequired: boolean;
      };
    };
    // The bind itself succeeded despite the webhook failure — never a 500.
    expect(rec.binds).toHaveLength(1);
    expect(json.binding.id).toBe("psync_new");
    // Manual fallback: the paste-URL + secret are returned.
    expect(json.webhook.autoRegistered).toBe(false);
    expect(json.webhook.manualRegistrationRequired).toBe(true);
    expect(json.webhook.url).toContain(`install=${INSTALL_ID}`);
    expect(json.webhook.url).toContain(`secret=${encodeURIComponent(json.webhook.secret)}`);
    expect(json.webhook.secret.length).toBeGreaterThan(0);
    // Nothing persisted on failure — no webhook record on the install config.
    const anyWebhooks = rec.installUpserts.some(
      (u) => (u.config as { webhooks?: unknown }).webhooks,
    );
    expect(anyWebhooks).toBe(false);
    errorSpy.mockRestore();
  });

  it("rejects (400) an externalProjectId whose cloudId doesn't match the install", async () => {
    const rec: Recorded = { mappings: [], binds: [], installUpserts: [] };
    const res = await post(makeApp(rec), { ...VALID_BODY, externalProjectId: "other-cloud:ENG" });
    expect(res.status).toBe(400);
    expect(rec.binds).toHaveLength(0);
  });

  it("rejects (404) an installation owned by another workspace", async () => {
    const rec: Recorded = { mappings: [], binds: [], installUpserts: [] };
    const res = await post(makeApp(rec, OTHER_WS), VALID_BODY);
    expect(res.status).toBe(404);
    expect(rec.binds).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/jira/project-syncs/:id/import — paged loop feeds the SHARED engine.
// ──────────────────────────────────────────────────────────────────────────────
describe("POST /api/jira/project-syncs/:id/import", () => {
  const TASKS_PROJECT = "proj_1";
  const BINDING = {
    id: "psync_1",
    workspaceId: WS,
    provider: "jira",
    installationId: INSTALL_ID,
    tasksProjectId: TASKS_PROJECT,
    externalProjectId: `${CLOUD_ID}:ENG`,
    externalProjectName: "Engineering",
    externalUrl: null,
    syncDirection: "inbound",
    createdBy: USER_ID,
    createdAt: 1,
  };

  function makeApp() {
    const pg = {
      async resolveTasksProjectId(id: string) {
        return id === TASKS_PROJECT ? TASKS_PROJECT : null;
      },
      async getTasksProjectWorkspace() {
        return WS;
      },
      async isMember() {
        return true;
      },
      async getProjectSyncsForTasksProject() {
        return [BINDING];
      },
      async getIntegrationInstallationById() {
        return {
          id: INSTALL_ID,
          workspaceId: WS,
          provider: "jira",
          externalId: CLOUD_ID,
          config: { expiresAt: Date.now() + 3_600_000 },
          accessToken: encryptToken("live-token"),
          botUserId: null,
          scopes: null,
          installedBy: USER_ID,
          createdAt: 1,
        };
      },
    } as unknown as PgSync;
    return createJiraRoutes({ pg, requireAuth: authStub() });
  }

  it("pages through the project, dispatching each page, and returns the item count", async () => {
    vi.spyOn(jiraAdapter, "importItems")
      .mockResolvedValueOnce({
        items: [
          { itemType: "issue", itemNumber: "ENG-1", providerItemId: "1", title: "One" },
          { itemType: "issue", itemNumber: "ENG-2", providerItemId: "2", title: "Two" },
        ],
        nextCursor: "c1",
      })
      .mockResolvedValueOnce({
        items: [{ itemType: "issue", itemNumber: "ENG-3", providerItemId: "3", title: "Three" }],
      });

    const res = await makeApp().request(
      `/api/jira/project-syncs/psync_1/import?tasksProjectId=${TASKS_PROJECT}`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { imported: number; pages: number };
    expect(json.imported).toBe(3);
    expect(json.pages).toBe(2);
    // The engine's batch entry was invoked once per page — task-create is NOT duplicated.
    expect(mockDispatch).toHaveBeenCalledTimes(2);
    const firstBatch = mockDispatch.mock.calls[0]?.[2] as Array<{ externalProjectId: string }>;
    expect(firstBatch).toHaveLength(2);
    expect(firstBatch[0]!.externalProjectId).toBe(`${CLOUD_ID}:ENG`);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/jira/webhook — PUBLIC: 401 on a bad secret; 200-ack + dispatch once on a good one.
// ──────────────────────────────────────────────────────────────────────────────
describe("POST /api/jira/webhook", () => {
  const WEBHOOK_SECRET = "wh-secret-123";

  function makeApp(installFound = true) {
    const pg = {
      async getIntegrationInstallationById(id: string) {
        return installFound && id === INSTALL_ID
          ? {
              id: INSTALL_ID,
              workspaceId: WS,
              provider: "jira",
              externalId: CLOUD_ID,
              config: { webhookSecret: WEBHOOK_SECRET },
              accessToken: null,
              botUserId: null,
              scopes: null,
              installedBy: USER_ID,
              createdAt: 1,
            }
          : null;
      },
    } as unknown as PgSync;
    return createJiraRoutes({ pg, requireAuth: authStub() });
  }

  const ISSUE_BODY = JSON.stringify({
    webhookEvent: "jira:issue_updated",
    user: { displayName: "Jane" },
    issue: {
      id: "10001",
      key: "ENG-42",
      self: "https://acme.atlassian.net/rest/api/2/issue/10001",
      fields: {
        summary: "Fix the thing",
        project: { key: "ENG" },
        status: { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } },
      },
    },
  });

  function post(app: ReturnType<typeof makeApp>, secret: string, install = INSTALL_ID) {
    return app.request(
      `/api/jira/webhook?install=${install}&secret=${encodeURIComponent(secret)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: ISSUE_BODY,
      },
    );
  }

  it("rejects a WRONG secret with 401 — dispatch NOT called", async () => {
    const res = await post(makeApp(), "the-wrong-secret");
    expect(res.status).toBe(401);
    await new Promise((r) => setImmediate(r));
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("rejects an unknown install with 401", async () => {
    const res = await post(makeApp(false), WEBHOOK_SECRET);
    expect(res.status).toBe(401);
  });

  it("valid secret → 200-ack and dispatch invoked once with the cloudId-scoped event", async () => {
    const res = await post(makeApp(), WEBHOOK_SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(1));
    const events = mockDispatch.mock.calls[0]?.[2] as Array<{
      externalProjectId: string;
      itemNumber: string;
    }>;
    expect(events).toHaveLength(1);
    // The route injected body.cloudId so the mapper emitted "<cloudId>:<projectKey>".
    expect(events[0]!.externalProjectId).toBe(`${CLOUD_ID}:ENG`);
    expect(events[0]!.itemNumber).toBe("ENG-42");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/jira/personal-data-report/run — INTERNAL ops trigger, shared-secret gated
// (constant-time). NOT an Atlassian receiver: the 3LO model is PUSH, no inbound signature.
// ──────────────────────────────────────────────────────────────────────────────
describe("POST /api/jira/personal-data-report/run", () => {
  const SECRET = "pdr-secret-xyz";
  const SUMMARY = {
    configured: true,
    reported: 5,
    erased: 1,
    refreshRequested: 2,
    batches: 1,
    errors: [],
  };

  function makeApp() {
    // The route only needs a non-null pg to pass the availability gate; the reporter is mocked.
    return createJiraRoutes({ pg: {} as unknown as PgSync, requireAuth: authStub() });
  }

  function run(app: ReturnType<typeof makeApp>, header?: string) {
    return app.request("/api/jira/personal-data-report/run", {
      method: "POST",
      headers: header === undefined ? {} : { "x-cyborg-personal-data-report-secret": header },
    });
  }

  it("secret unset → 503, reporter NOT run", async () => {
    const res = await run(makeApp(), SECRET);
    expect(res.status).toBe(503);
    expect(mockRunReportCycle).not.toHaveBeenCalled();
  });

  it("secret set + correct header → 200 with the cycle summary", async () => {
    process.env.JIRA_PERSONAL_DATA_REPORT_SECRET = SECRET;
    mockRunReportCycle.mockResolvedValue(SUMMARY);
    const res = await run(makeApp(), SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SUMMARY);
    expect(mockRunReportCycle).toHaveBeenCalledTimes(1);
  });

  it("secret set + wrong header → 401, reporter NOT run", async () => {
    process.env.JIRA_PERSONAL_DATA_REPORT_SECRET = SECRET;
    const res = await run(makeApp(), "the-wrong-secret");
    expect(res.status).toBe(401);
    expect(mockRunReportCycle).not.toHaveBeenCalled();
  });

  it("secret set + missing header → 401, reporter NOT run", async () => {
    process.env.JIRA_PERSONAL_DATA_REPORT_SECRET = SECRET;
    const res = await run(makeApp());
    expect(res.status).toBe(401);
    expect(mockRunReportCycle).not.toHaveBeenCalled();
  });
});
