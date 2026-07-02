import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Context, Next } from "hono";
import {
  signClickUpOAuthState,
  verifyClickUpOAuthState,
  exchangeAndStoreClickUpInstall,
  createClickUpRoutes,
} from "./clickup.js";
import type { PgSync } from "../db/pg-sync.js";
import type { RelayEnv } from "./types.js";
import { decryptToken, isEncryptedToken } from "../task-sync-crypto.js";

// Mock the committed ClickUp core so the OAuth exchange + the configured-gate are driven,
// never the network. getClickUpOAuthClientSecret returns a FIXED value so the signed state
// round-trips (sign + verify both read it). clickUpAuthHeaderValue passes the token through.
const { mockExchangeCode, mockIsConfigured } = vi.hoisted(() => ({
  mockExchangeCode: vi.fn(),
  mockIsConfigured: vi.fn(() => true),
}));
vi.mock("../clickup-app.js", () => ({
  isClickUpConfigured: mockIsConfigured,
  getClickUpOAuthClientId: () => "test-clickup-client-id",
  getClickUpOAuthClientSecret: () => "test-clickup-client-secret",
  exchangeCode: mockExchangeCode,
  clickUpAuthHeaderValue: (token: string) => token,
}));

// Mock the committed adapter — the route wires it, this suite drives the route. The engine
// dispatch is spied so "dispatched once" and "import count" are asserted without a real DB.
const { mockAdapter } = vi.hoisted(() => ({
  mockAdapter: {
    provider: "clickup",
    verifyWebhook: vi.fn(),
    parseInbound: vi.fn(),
    listStatuses: vi.fn(),
    importItems: vi.fn(),
    writeItem: vi.fn(),
    writeStatus: vi.fn(),
  },
}));
vi.mock("../integrations/clickup-adapter.js", () => ({
  clickUpAdapter: mockAdapter,
  CLICKUP_PROVIDER: "clickup",
}));

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }));
vi.mock("../task-sync-engine.js", () => ({ dispatchInboundTaskEvents: mockDispatch }));

// Module-scope no-op so console spies pass a reference (keeps the nested describe → it →
// spy chain under oxlint max-nested-callbacks).
function noop(): void {}

const APP_URL = "https://app.cyborg7.com";
const WS = "ws_caller";
const OTHER_WS = "ws_victim";
const USER_ID = "u_member";
const INSTALL_ID = "intg_1";
const TEAM_ID = "team_1";
const LIST_ID = "list_1";
const TASKS_PROJECT = "tp_1";

// A pass-through requireAuth that stamps the caller (parity with slack-oauth.test.ts).
function authAs(userId: string) {
  return async (c: Context<RelayEnv>, next: Next) => {
    c.set("userId", userId);
    c.set("userEmail", `${userId}@e2e.dev`);
    await next();
  };
}

// A minimal fetch response the raw /team + webhook calls consume.
function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    body: { cancel: async () => {} },
  } as unknown as Response;
}

const ENV_KEYS = [
  "CYBORG_APP_URL",
  "CLICKUP_OAUTH_CALLBACK_BASE",
  "CLICKUP_WEBHOOK_BASE",
  "CYBORG7_TOKEN_ENC_KEY",
] as const;

let savedEnv: Record<string, string | undefined> = {};
let savedFetch: typeof globalThis.fetch;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.CYBORG_APP_URL = APP_URL;
  delete process.env.CLICKUP_OAUTH_CALLBACK_BASE;
  delete process.env.CLICKUP_WEBHOOK_BASE;
  delete process.env.CYBORG7_TOKEN_ENC_KEY; // crypto passthrough — assert plaintext by default.
  savedFetch = globalThis.fetch;
  mockExchangeCode.mockReset();
  mockIsConfigured.mockReturnValue(true);
  mockAdapter.verifyWebhook.mockReset();
  mockAdapter.parseInbound.mockReset();
  mockAdapter.listStatuses.mockReset();
  mockAdapter.importItems.mockReset();
  mockDispatch.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = savedFetch;
});

// ── signed OAuth state — the load-bearing security primitive ──
describe("clickup OAuth state sign/verify", () => {
  it("round-trips a valid {workspaceId, userId}", () => {
    const state = signClickUpOAuthState({ workspaceId: WS, userId: USER_ID });
    expect(verifyClickUpOAuthState(state)).toEqual({ workspaceId: WS, userId: USER_ID });
  });

  it("rejects a tampered payload (HMAC no longer matches)", () => {
    const state = signClickUpOAuthState({ workspaceId: WS, userId: USER_ID });
    const [, sig] = state.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ workspaceId: OTHER_WS, userId: "attacker" }),
    ).toString("base64url");
    expect(verifyClickUpOAuthState(`${forgedBody}.${sig}`)).toBeNull();
  });

  it("rejects a malformed / unsigned state", () => {
    expect(verifyClickUpOAuthState("")).toBeNull();
    expect(verifyClickUpOAuthState("not-a-signed-state")).toBeNull();
  });
});

// ── GET /api/clickup/config — gate + stable, byte-identical redirect_uri ──
describe("GET /api/clickup/config", () => {
  function makeApp() {
    const pg = {
      async isMember(workspaceId: string, userId: string) {
        return workspaceId === WS && userId === USER_ID;
      },
    } as unknown as PgSync;
    return createClickUpRoutes({ pg, requireAuth: authAs(USER_ID) });
  }

  it("returns { configured:false } when the ClickUp OAuth secrets are absent", async () => {
    mockIsConfigured.mockReturnValue(false);
    const res = await makeApp().request(`/api/clickup/config?workspaceId=${WS}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, authorizeUrl: null });
  });

  it("configured but no workspaceId → { configured:true, authorizeUrl:null }", async () => {
    const res = await makeApp().request(`/api/clickup/config`);
    expect(await res.json()).toEqual({ configured: true, authorizeUrl: null });
  });

  it("member → authorizeUrl carries a signed state + a stable redirect_uri (ignores X-Forwarded-Host)", async () => {
    const res = await makeApp().request(`/api/clickup/config?workspaceId=${WS}`, {
      headers: { "X-Forwarded-Host": "evil.example.com", "X-Forwarded-Proto": "https" },
    });
    const { configured, authorizeUrl } = (await res.json()) as {
      configured: boolean;
      authorizeUrl: string;
    };
    expect(configured).toBe(true);
    expect(authorizeUrl).not.toContain("evil.example.com");
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get("redirect_uri")).toBe(`${APP_URL}/api/clickup/oauth/callback`);
    expect(verifyClickUpOAuthState(url.searchParams.get("state") ?? "")).toEqual({
      workspaceId: WS,
      userId: USER_ID,
    });
  });

  it("non-member → 403", async () => {
    const res = await makeApp().request(`/api/clickup/config?workspaceId=${OTHER_WS}`);
    expect(res.status).toBe(403);
  });
});

// ── exchangeAndStoreClickUpInstall + PUBLIC callback ──
describe("clickup OAuth exchange + callback", () => {
  function makeCallbackApp(upserts: Array<Record<string, unknown>>) {
    const pg = {
      async upsertIntegrationInstallation(opts: Record<string, unknown>) {
        upserts.push(opts);
        return String(opts.id);
      },
    } as unknown as PgSync;
    return createClickUpRoutes({ pg, requireAuth: authAs(USER_ID) });
  }

  function validState(): string {
    return signClickUpOAuthState({ workspaceId: WS, userId: USER_ID });
  }

  it("valid state + successful exchange → 302 ?clickup=connected, install stored with the team id + encrypted token", async () => {
    const upserts: Array<Record<string, unknown>> = [];
    mockExchangeCode.mockResolvedValue({ ok: true, accessToken: "cu_tok_abc" });
    globalThis.fetch = vi.fn(async () =>
      fakeResponse({ teams: [{ id: TEAM_ID, name: "Acme" }] }),
    ) as unknown as typeof fetch;
    // A real encryption key so we can prove the token is encrypted at rest.
    process.env.CYBORG7_TOKEN_ENC_KEY = Buffer.alloc(32, 7).toString("base64");

    const res = await makeCallbackApp(upserts).request(
      `/api/clickup/oauth/callback?code=code_abc&state=${encodeURIComponent(validState())}`,
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith(`${APP_URL}/`)).toBe(true);
    expect(loc.endsWith("/settings/integrations/clickup?clickup=connected")).toBe(true);
    expect(upserts).toHaveLength(1);
    const stored = upserts[0];
    expect(stored).toMatchObject({
      workspaceId: WS,
      provider: "clickup",
      externalId: TEAM_ID,
      installedBy: USER_ID,
      config: { teamName: "Acme", teams: [{ id: TEAM_ID, name: "Acme" }] },
    });
    // The access token is ENCRYPTED at rest (never the plaintext) and decrypts back.
    expect(stored.accessToken).not.toBe("cu_tok_abc");
    expect(isEncryptedToken(String(stored.accessToken))).toBe(true);
    expect(decryptToken(String(stored.accessToken))).toBe("cu_tok_abc");
  });

  it("falls back to a stable per-workspace externalId when the /team lookup fails", async () => {
    const upserts: Array<Record<string, unknown>> = [];
    mockExchangeCode.mockResolvedValue({ ok: true, accessToken: "cu_tok_abc" });
    globalThis.fetch = vi.fn(async () => fakeResponse({}, false, 500)) as unknown as typeof fetch;
    const ok = await exchangeAndStoreClickUpInstall(
      makeFakePg(upserts) as unknown as PgSync,
      { workspaceId: WS, userId: USER_ID },
      "code_abc",
    );
    expect(ok).toBe(true);
    expect(upserts[0]).toMatchObject({ externalId: `clickup_ws_${WS}`, provider: "clickup" });
  });

  it("forged / unsigned state → 302 to root ?clickup=oauth_error, no exchange, no upsert", async () => {
    const upserts: Array<Record<string, unknown>> = [];
    const res = await makeCallbackApp(upserts).request(
      `/api/clickup/oauth/callback?code=code_abc&state=forged.state`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_URL}/?clickup=oauth_error`);
    expect(upserts).toHaveLength(0);
    expect(mockExchangeCode).not.toHaveBeenCalled();
  });

  it("exchange that throws → 302 ?clickup=oauth_error (caught, never a 500), no upsert", async () => {
    const upserts: Array<Record<string, unknown>> = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(noop);
    mockExchangeCode.mockRejectedValue(new Error("network boom"));
    const res = await makeCallbackApp(upserts).request(
      `/api/clickup/oauth/callback?code=code_abc&state=${encodeURIComponent(validState())}`,
    );
    expect(res.status).toBe(302);
    expect((res.headers.get("location") ?? "").endsWith("?clickup=oauth_error")).toBe(true);
    expect(upserts).toHaveLength(0);
    errorSpy.mockRestore();
  });
});

function makeFakePg(upserts: Array<Record<string, unknown>>) {
  return {
    async upsertIntegrationInstallation(opts: Record<string, unknown>) {
      upserts.push(opts);
      return String(opts.id);
    },
  };
}

// ── GET /api/clickup/installations — token + webhook secrets STRIPPED ──
describe("GET /api/clickup/installations — token-strip invariant", () => {
  const ROW = {
    id: INSTALL_ID,
    workspaceId: WS,
    provider: "clickup",
    externalId: TEAM_ID,
    config: { teamName: "Acme", webhooks: { [LIST_ID]: { id: "wh_1", secret: "SECRET" } } },
    accessToken: "cu-SECRET-NEVER-LEAK",
    botUserId: null,
    scopes: null,
    installedBy: USER_ID,
    createdAt: 123,
  };

  function makeApp(callerIsMember: boolean) {
    const pg = {
      async isMember(workspaceId: string, userId: string) {
        return callerIsMember && workspaceId === WS && userId === USER_ID;
      },
      async listIntegrationInstallations() {
        return [ROW];
      },
    } as unknown as PgSync;
    return createClickUpRoutes({ pg, requireAuth: authAs(USER_ID) });
  }

  it("member → 200; row carries teamName but NEVER accessToken or the webhook secrets", async () => {
    const res = await makeApp(true).request(`/api/clickup/installations?workspaceId=${WS}`);
    expect(res.status).toBe(200);
    const { installations } = (await res.json()) as {
      installations: Array<Record<string, unknown>>;
    };
    expect(installations).toHaveLength(1);
    expect("accessToken" in installations[0]).toBe(false);
    expect("config" in installations[0]).toBe(false);
    expect(installations[0]).toMatchObject({
      id: INSTALL_ID,
      externalId: TEAM_ID,
      teamName: "Acme",
    });
    expect(JSON.stringify(installations[0])).not.toContain("SECRET");
  });

  it("non-member → 403", async () => {
    const res = await makeApp(false).request(`/api/clickup/installations?workspaceId=${WS}`);
    expect(res.status).toBe(403);
  });
});

// ── DELETE /api/clickup/installation/:id — BOLA ──
describe("DELETE /api/clickup/installation/:id — BOLA (workspace ownership)", () => {
  function makeApp(installWorkspaceId: string | null, deletes: string[]) {
    const pg = {
      async isMember(workspaceId: string, userId: string) {
        return workspaceId === WS && userId === USER_ID;
      },
      async getIntegrationInstallationById(id: string) {
        return installWorkspaceId === null
          ? null
          : { id, workspaceId: installWorkspaceId, provider: "clickup" };
      },
      async deleteIntegrationInstallation(id: string) {
        deletes.push(id);
      },
    } as unknown as PgSync;
    return createClickUpRoutes({ pg, requireAuth: authAs(USER_ID) });
  }

  it("target owned by ANOTHER workspace → 404, delete NOT called", async () => {
    const deletes: string[] = [];
    const res = await makeApp(OTHER_WS, deletes).request(
      `/api/clickup/installation/${INSTALL_ID}?workspaceId=${WS}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
    expect(deletes).toHaveLength(0);
  });

  it("target in the caller's workspace → 200, delete called", async () => {
    const deletes: string[] = [];
    const res = await makeApp(WS, deletes).request(
      `/api/clickup/installation/${INSTALL_ID}?workspaceId=${WS}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    expect(deletes).toEqual([INSTALL_ID]);
  });
});

// ── POST /api/clickup/project-syncs — bind + seed mappings + register webhook ──
describe("POST /api/clickup/project-syncs", () => {
  interface CreateFake {
    statusMappings: Array<Record<string, unknown>>;
    configUpserts: Array<Record<string, unknown>>;
  }

  function makeApp(fake: CreateFake) {
    const install = {
      id: INSTALL_ID,
      workspaceId: WS,
      provider: "clickup",
      externalId: TEAM_ID,
      config: {},
      accessToken: "cu_tok",
      botUserId: null,
      scopes: null,
      installedBy: USER_ID,
      createdAt: 1,
    };
    const pg = {
      async isMember(workspaceId: string, userId: string) {
        return workspaceId === WS && userId === USER_ID;
      },
      async resolveTasksProjectId(id: string) {
        return id === TASKS_PROJECT ? TASKS_PROJECT : null;
      },
      async getTasksProjectWorkspace() {
        return WS;
      },
      async getIntegrationInstallationById(id: string) {
        return id === INSTALL_ID ? install : null;
      },
      async upsertProjectSync() {
        return "psync_1";
      },
      async getProjectStates() {
        return [
          {
            id: "st_unstarted",
            group: "unstarted",
            projectId: TASKS_PROJECT,
            workspaceId: WS,
            name: "Todo",
            color: "#000",
            sequence: 0,
            isDefault: true,
          },
          {
            id: "st_started",
            group: "started",
            projectId: TASKS_PROJECT,
            workspaceId: WS,
            name: "Doing",
            color: "#111",
            sequence: 1,
            isDefault: false,
          },
        ];
      },
      async upsertStatusMapping(opts: Record<string, unknown>) {
        fake.statusMappings.push(opts);
        return `stmap_${fake.statusMappings.length}`;
      },
      async upsertIntegrationInstallation(opts: Record<string, unknown>) {
        fake.configUpserts.push(opts);
        return INSTALL_ID;
      },
      async listStatusMappings() {
        return fake.statusMappings.map((m, i) => ({
          id: `stmap_${i + 1}`,
          workspaceId: WS,
          projectSyncId: "psync_1",
          provider: "clickup",
          sourceStatusId: (m.sourceStatusId as string) ?? null,
          sourceStatusName: m.sourceStatusName as string,
          taskStateId: (m.taskStateId as string) ?? null,
          skipBackward: false,
          createdBy: USER_ID,
          createdAt: 1,
        }));
      },
    } as unknown as PgSync;
    return createClickUpRoutes({ pg, requireAuth: authAs(USER_ID) });
  }

  function postBody(app: ReturnType<typeof makeApp>, body: Record<string, unknown>) {
    return app.request("/api/clickup/project-syncs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("binds, seeds a mapping per List status (by group affinity), and stores the webhook secret", async () => {
    const fake: CreateFake = { statusMappings: [], configUpserts: [] };
    mockAdapter.listStatuses.mockResolvedValue([
      { id: "s1", name: "To Do", category: "unstarted" },
      { id: "s2", name: "In Progress", category: "started" },
    ]);
    globalThis.fetch = vi.fn(async () =>
      fakeResponse({ id: "wh_1", webhook: { id: "wh_1", secret: "whsecret" } }),
    ) as unknown as typeof fetch;

    const res = await postBody(makeApp(fake), {
      tasksProjectId: TASKS_PROJECT,
      installationId: INSTALL_ID,
      externalProjectId: LIST_ID,
      externalProjectName: "Sprint Board",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      binding: Record<string, unknown>;
      mappings: Array<Record<string, unknown>>;
      webhookRegistered: boolean;
    };
    expect(json.binding).toMatchObject({
      id: "psync_1",
      externalProjectId: LIST_ID,
      provider: "clickup",
    });
    // One seeded mapping per source status, each pre-mapped to the same-group project state.
    expect(fake.statusMappings).toHaveLength(2);
    expect(fake.statusMappings[0]).toMatchObject({
      sourceStatusName: "To Do",
      taskStateId: "st_unstarted",
    });
    expect(fake.statusMappings[1]).toMatchObject({
      sourceStatusName: "In Progress",
      taskStateId: "st_started",
    });
    expect(json.mappings).toHaveLength(2);
    // Webhook registered → its secret persisted (encrypted; passthrough in tests) on the install config.
    expect(json.webhookRegistered).toBe(true);
    expect(fake.configUpserts).toHaveLength(1);
    const persisted = fake.configUpserts[0].config as {
      webhooks: Record<string, { secret: string }>;
    };
    expect(persisted.webhooks[LIST_ID].secret).toBe("whsecret");
  });

  it("rejects a foreign installation (not this workspace's) with 404", async () => {
    const fake: CreateFake = { statusMappings: [], configUpserts: [] };
    const res = await postBody(makeApp(fake), {
      tasksProjectId: TASKS_PROJECT,
      installationId: "intg_foreign",
      externalProjectId: LIST_ID,
    });
    expect(res.status).toBe(404);
    expect(fake.statusMappings).toHaveLength(0);
  });
});

// ── POST /api/clickup/webhook — signature gate + best-effort dispatch ──
describe("POST /api/clickup/webhook", () => {
  function makeApp() {
    const pg = {
      async getIntegrationInstallationById(id: string) {
        return id === INSTALL_ID
          ? {
              id: INSTALL_ID,
              workspaceId: WS,
              provider: "clickup",
              externalId: TEAM_ID,
              config: { webhooks: { [LIST_ID]: { id: "wh_1", secret: "whsecret" } } },
              accessToken: "cu_tok",
              botUserId: null,
              scopes: null,
              installedBy: USER_ID,
              createdAt: 1,
            }
          : null;
      },
    } as unknown as PgSync;
    return createClickUpRoutes({ pg, requireAuth: authAs(USER_ID) });
  }

  function postWebhook(app: ReturnType<typeof makeApp>) {
    return app.request(`/api/clickup/webhook?install=${INSTALL_ID}&list=${LIST_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": "deadbeef" },
      body: JSON.stringify({ event: "taskUpdated", task_id: "abc" }),
    });
  }

  it("bad signature → 401, never dispatches", async () => {
    mockAdapter.verifyWebhook.mockReturnValue(false);
    const res = await postWebhook(makeApp());
    expect(res.status).toBe(401);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("valid signature → 200 ack, dispatches the parsed events exactly once", async () => {
    mockAdapter.verifyWebhook.mockReturnValue(true);
    const event = {
      itemType: "task",
      externalProjectId: LIST_ID,
      itemNumber: "abc",
      providerItemId: "abc",
    };
    mockAdapter.parseInbound.mockReturnValue([event]);
    const res = await postWebhook(makeApp());
    expect(res.status).toBe(200);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0][2]).toEqual([event]);
    // The route stamps the List id from the query hint onto the payload before parseInbound.
    const parsed = mockAdapter.parseInbound.mock.calls[0][0] as { list_id: string };
    expect(parsed.list_id).toBe(LIST_ID);
  });

  it("valid signature but a dispatch failure still 200-acks (best-effort, no retry-storm)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(noop);
    mockAdapter.verifyWebhook.mockReturnValue(true);
    mockAdapter.parseInbound.mockReturnValue([{ itemType: "task" }]);
    mockDispatch.mockRejectedValueOnce(new Error("db down"));
    const res = await postWebhook(makeApp());
    expect(res.status).toBe(200);
    errorSpy.mockRestore();
  });
});

// ── POST /api/clickup/project-syncs/:id/import — paged backfill feeds the engine ──
describe("POST /api/clickup/project-syncs/:id/import", () => {
  function makeApp() {
    const pg = {
      async isMember() {
        return true;
      },
      async resolveTasksProjectId() {
        return TASKS_PROJECT;
      },
      async getTasksProjectWorkspace() {
        return WS;
      },
      async getProjectSyncsForTasksProject() {
        return [
          {
            id: "psync_1",
            workspaceId: WS,
            provider: "clickup",
            installationId: INSTALL_ID,
            tasksProjectId: TASKS_PROJECT,
            externalProjectId: LIST_ID,
            externalProjectName: null,
            externalUrl: null,
            syncDirection: "inbound",
            createdBy: USER_ID,
            createdAt: 1,
          },
        ];
      },
      async getIntegrationInstallationById() {
        return {
          id: INSTALL_ID,
          workspaceId: WS,
          provider: "clickup",
          externalId: TEAM_ID,
          config: {},
          accessToken: "cu_tok",
          botUserId: null,
          scopes: null,
          installedBy: USER_ID,
          createdAt: 1,
        };
      },
    } as unknown as PgSync;
    return createClickUpRoutes({ pg, requireAuth: authAs(USER_ID) });
  }

  it("pages until the last page and returns the total imported count", async () => {
    const item = (n: string) => ({
      itemType: "task",
      itemNumber: n,
      providerItemId: n,
      title: `T${n}`,
    });
    mockAdapter.importItems
      .mockResolvedValueOnce({ items: [item("1"), item("2")], nextCursor: "1" })
      .mockResolvedValueOnce({ items: [item("3")] });
    const res = await makeApp().request(
      `/api/clickup/project-syncs/psync_1/import?tasksProjectId=${TASKS_PROJECT}`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ imported: 3, pages: 2, rateLimited: false });
    expect(mockDispatch).toHaveBeenCalledTimes(2);
    // Items are converted to inbound events stamped with the binding's List id.
    expect(mockDispatch.mock.calls[0][2][0]).toMatchObject({
      itemNumber: "1",
      externalProjectId: LIST_ID,
    });
  });

  it("a 429 rate-limit stall (same cursor returned) breaks the loop with rateLimited:true", async () => {
    mockAdapter.importItems
      .mockResolvedValueOnce({ items: [], nextCursor: "0" })
      .mockResolvedValueOnce({ items: [], nextCursor: "0" });
    const res = await makeApp().request(
      `/api/clickup/project-syncs/psync_1/import?tasksProjectId=${TASKS_PROJECT}`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ imported: 0, rateLimited: true });
  });

  it("a binding id not in the project → 404", async () => {
    const res = await makeApp().request(
      `/api/clickup/project-syncs/psync_unknown/import?tasksProjectId=${TASKS_PROJECT}`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });
});
