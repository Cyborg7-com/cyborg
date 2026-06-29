import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { Context, Next } from "hono";
import { createGithubRoutes, validateWorkspaceAccess } from "./github.js";
import { consumeInbound, _resetEchoGuardForTest } from "../github-outbound.js";
import type { PgSync } from "../db/pg-sync.js";
import type { RelayEnv } from "./types.js";

// The GET /api/github/installation-repos callback enumerates the repos an
// installation can access — scoped to the workspace the caller is binding into.
// An adversarial review flagged a BOLA: any authed user could enumerate ANY
// installation's repos by guessing an installationId. These tests pin the
// membership guard by driving the REAL Hono app via createGithubRoutes with a
// typed-fake pg (no live PG) and a stub requireAuth that sets a chosen caller id.
//
// The GitHub App creds are deliberately ABSENT in this suite, so a MEMBER request
// reaches the gated `isGithubAppConfigured()` branch and returns
// { configured:false, repos:[] } (200) — no network, fully deterministic.

const WS = "ws_alpha";
const OTHER_WS = "ws_beta";
const PROJECT_CHAT_ID = "proj_chat_1"; // what the UI passes (resolveTasksProjectId accepts either)
const TASKS_PROJECT_ID = "tp_1"; // the resolved tasks_projects.id
const MEMBER = "u_member";
const OUTSIDER = "u_outsider";
const INSTALLATION_ID = "12345678";

interface FakeOpts {
  // The caller's userId (what the stub requireAuth sets).
  callerId: string;
  // The workspace memberships: workspaceId → set of member userIds.
  members?: Set<string>;
  // Which workspace owns each installation id (the github_installations row). Defaults
  // to { [INSTALLATION_ID]: WS } so the happy path resolves without per-test setup.
  installOwners?: Record<string, string>;
  // Records of pg writes the tests assert against.
  binds?: Array<Record<string, unknown>>;
  // The task-state ids that belong to TASKS_PROJECT_ID (cross-project validation). A
  // state id NOT in this set is treated as belonging to a different project → rejected.
  validStateIds?: Set<string>;
  // Records of PR-mapping upserts the tests assert against.
  prMappingUpserts?: Array<Record<string, unknown>>;
}

// Build the real Hono app over a typed-fake pg + a stub requireAuth that injects
// `callerId`. The fake pg resolves the project id → workspace and answers
// isMember from the provided membership set.
function makeApp(opts: FakeOpts) {
  const members = new Set(opts.members ?? []);
  const installOwners = opts.installOwners ?? { [INSTALLATION_ID]: WS };
  const binds = opts.binds;
  const validStateIds = opts.validStateIds ?? new Set<string>();
  const prMappingUpserts = opts.prMappingUpserts;

  const requireAuth = async (c: Context<RelayEnv>, next: Next) => {
    c.set("userId", opts.callerId);
    c.set("userEmail", `${opts.callerId}@e2e.dev`);
    await next();
  };

  const pg = {
    async resolveTasksProjectId(idParam: string) {
      // Accept either the chat project id or the tasks_projects.id (parity with
      // the real resolver), and resolve both to the canonical tasks_projects.id.
      if (idParam === PROJECT_CHAT_ID || idParam === TASKS_PROJECT_ID) return TASKS_PROJECT_ID;
      return null;
    },
    async getTasksProjectWorkspace(tasksProjectId: string) {
      return tasksProjectId === TASKS_PROJECT_ID ? WS : null;
    },
    async isMember(workspaceId: string, userId: string) {
      return members.has(userId) && (workspaceId === WS || workspaceId === OTHER_WS);
    },
    async getInstallationWorkspace(installationId: string) {
      return installOwners[installationId] ?? null;
    },
    async bindRepoSync(o: Record<string, unknown>) {
      binds?.push(o);
      return "ghrs_new";
    },
    async stateBelongsToProject(stateId: string, tasksProjectId: string) {
      return tasksProjectId === TASKS_PROJECT_ID && validStateIds.has(stateId);
    },
    async upsertPrStateMapping(o: Record<string, unknown>) {
      prMappingUpserts?.push(o);
      return "ghprm_new";
    },
  } as unknown as PgSync;

  return createGithubRoutes({ pg, requireAuth });
}

function get(app: ReturnType<typeof makeApp>, path: string): Promise<Response> {
  return app.request(path, { method: "GET" });
}

function postJson(app: ReturnType<typeof makeApp>, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/github/installation-repos — BOLA membership guard", () => {
  it("a MEMBER of the project's workspace is allowed (200, degrades to manual mode)", async () => {
    const app = makeApp({ callerId: MEMBER, members: new Set([MEMBER]) });

    const res = await get(
      app,
      `/api/github/installation-repos?installationId=${INSTALLATION_ID}` +
        `&tasksProjectId=${PROJECT_CHAT_ID}`,
    );

    // App creds are absent in tests → the gated branch returns configured:false.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, repos: [] });
  });

  it("a NON-member is denied with 403 (can't enumerate another workspace's install)", async () => {
    // The outsider is authed but NOT a member of the project's workspace.
    const app = makeApp({ callerId: OUTSIDER, members: new Set([MEMBER]) });

    const res = await get(
      app,
      `/api/github/installation-repos?installationId=${INSTALLATION_ID}` +
        `&tasksProjectId=${PROJECT_CHAT_ID}`,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not a member" });
  });

  it("a missing tasksProjectId is rejected with 400 (the BOLA precondition)", async () => {
    const app = makeApp({ callerId: MEMBER, members: new Set([MEMBER]) });

    const res = await get(app, `/api/github/installation-repos?installationId=${INSTALLATION_ID}`);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "tasksProjectId required" });
  });

  it("an unknown tasksProjectId is rejected with 404 (no workspace to authorize against)", async () => {
    const app = makeApp({ callerId: MEMBER, members: new Set([MEMBER]) });

    const res = await get(
      app,
      `/api/github/installation-repos?installationId=${INSTALLATION_ID}&tasksProjectId=nope`,
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "project not found" });
  });

  it("a member is denied (404) when the installationId belongs to ANOTHER workspace", async () => {
    // The caller is a member of the project's workspace, but the installationId they
    // passed is owned by a DIFFERENT workspace. Membership alone must NOT grant a live
    // token for it — the BOLA fix requires installation ∈ caller's workspace.
    const app = makeApp({
      callerId: MEMBER,
      members: new Set([MEMBER]),
      installOwners: { [INSTALLATION_ID]: OTHER_WS },
    });

    const res = await get(
      app,
      `/api/github/installation-repos?installationId=${INSTALLATION_ID}` +
        `&tasksProjectId=${PROJECT_CHAT_ID}`,
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "installation not found" });
  });

  it("a member is denied (404) when the installationId is unknown (no install row)", async () => {
    const app = makeApp({
      callerId: MEMBER,
      members: new Set([MEMBER]),
      installOwners: {}, // no installation rows at all
    });

    const res = await get(
      app,
      `/api/github/installation-repos?installationId=${INSTALLATION_ID}` +
        `&tasksProjectId=${PROJECT_CHAT_ID}`,
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "installation not found" });
  });
});

describe("GET /api/github/config — the App's public slug for the Connect button", () => {
  const ORIGINAL_SLUG = process.env.GITHUB_APP_SLUG;
  afterEach(() => {
    if (ORIGINAL_SLUG === undefined) delete process.env.GITHUB_APP_SLUG;
    else process.env.GITHUB_APP_SLUG = ORIGINAL_SLUG;
  });

  it("returns the slug + configured:true when GITHUB_APP_SLUG is set", async () => {
    process.env.GITHUB_APP_SLUG = "cyborg7-tasks";
    const app = makeApp({ callerId: MEMBER, members: new Set([MEMBER]) });

    const res = await get(app, "/api/github/config");

    expect(res.status).toBe(200);
    // Wave-1 added a server-built install URL to the config payload (carries the
    // workspace `state` when a workspaceId is passed; absent here → bare install URL).
    expect(await res.json()).toEqual({
      configured: true,
      slug: "cyborg7-tasks",
      installUrl: "https://github.com/apps/cyborg7-tasks/installations/new",
    });
  });

  it("returns configured:false + slug:null when GITHUB_APP_SLUG is unset", async () => {
    delete process.env.GITHUB_APP_SLUG;
    const app = makeApp({ callerId: MEMBER, members: new Set([MEMBER]) });

    const res = await get(app, "/api/github/config");

    expect(res.status).toBe(200);
    // No slug → no install URL either (githubAppInstallUrl returns null).
    expect(await res.json()).toEqual({ configured: false, slug: null, installUrl: null });
  });
});

describe("validateWorkspaceAccess — the membership wrapper both branches use", () => {
  it("returns true for a member and false for a non-member", async () => {
    const pg = {
      async isMember(workspaceId: string, userId: string) {
        return workspaceId === WS && userId === MEMBER;
      },
    } as unknown as PgSync;

    await expect(validateWorkspaceAccess(pg, WS, MEMBER)).resolves.toBe(true);
    await expect(validateWorkspaceAccess(pg, WS, OUTSIDER)).resolves.toBe(false);
  });
});

describe("POST /api/github/repo-sync — installation-ownership guard (BOLA)", () => {
  const bindBody = {
    tasksProjectId: PROJECT_CHAT_ID,
    installationId: INSTALLATION_ID,
    repoId: "999",
    owner: "acme",
    name: "app",
  };

  it("binds when the installation belongs to the caller's workspace", async () => {
    const binds: Array<Record<string, unknown>> = [];
    const app = makeApp({ callerId: MEMBER, members: new Set([MEMBER]), binds });

    const res = await postJson(app, "/api/github/repo-sync", bindBody);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "ghrs_new" });
    expect(binds).toHaveLength(1);
    expect(binds[0]).toMatchObject({ installationId: INSTALLATION_ID, workspaceId: WS });
  });

  it("rejects (404) binding a repo under an installation owned by ANOTHER workspace", async () => {
    // The reassignment vector: previously this bootstrapped (and reassigned) the install
    // row to the caller's workspace. Now a foreign install is refused and never written.
    const binds: Array<Record<string, unknown>> = [];
    const app = makeApp({
      callerId: MEMBER,
      members: new Set([MEMBER]),
      installOwners: { [INSTALLATION_ID]: OTHER_WS },
      binds,
    });

    const res = await postJson(app, "/api/github/repo-sync", bindBody);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "installation not found" });
    expect(binds).toHaveLength(0); // nothing bound under a foreign install
  });

  it("rejects (404) when the installation has no row at all", async () => {
    const app = makeApp({ callerId: MEMBER, members: new Set([MEMBER]), installOwners: {} });

    const res = await postJson(app, "/api/github/repo-sync", bindBody);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "installation not found" });
  });
});

describe("POST /api/github/installations/confirm — claim a fresh install (no-reassign)", () => {
  it("a non-member is denied with 403", async () => {
    const app = makeApp({ callerId: OUTSIDER, members: new Set([MEMBER]) });

    const res = await postJson(app, "/api/github/installations/confirm", {
      workspaceId: WS,
      installationId: INSTALLATION_ID,
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not a member" });
  });

  it("is idempotent (ok) when the install is already claimed by the SAME workspace", async () => {
    const app = makeApp({
      callerId: MEMBER,
      members: new Set([MEMBER]),
      installOwners: { [INSTALLATION_ID]: WS },
    });

    const res = await postJson(app, "/api/github/installations/confirm", {
      workspaceId: WS,
      installationId: INSTALLATION_ID,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("refuses (409) to reassign an install another workspace already owns", async () => {
    const app = makeApp({
      callerId: MEMBER,
      members: new Set([MEMBER]),
      installOwners: { [INSTALLATION_ID]: OTHER_WS },
    });

    const res = await postJson(app, "/api/github/installations/confirm", {
      workspaceId: WS,
      installationId: INSTALLATION_ID,
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "installation already linked to another workspace",
    });
  });

  it("reports configured:false for a NEW claim when the App can't verify it (creds absent)", async () => {
    // App creds are absent in this suite, so a brand-new claim can't be verified against
    // GitHub → no row is written and the UI is told the App isn't configured.
    const app = makeApp({ callerId: MEMBER, members: new Set([MEMBER]), installOwners: {} });

    const res = await postJson(app, "/api/github/installations/confirm", {
      workspaceId: WS,
      installationId: INSTALLATION_ID,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false });
  });

  it("rejects a missing installationId with 400", async () => {
    const app = makeApp({ callerId: MEMBER, members: new Set([MEMBER]) });

    const res = await postJson(app, "/api/github/installations/confirm", { workspaceId: WS });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "workspaceId, installationId required" });
  });
});

describe("POST /api/github/webhook — echo guard marks ONLY the field this event moved", () => {
  const SECRET = "test-webhook-secret";
  const REPO_ID = "555";
  const ISSUE_NUMBER = 7;
  const TASK_ID = "task_echo";

  const ORIGINAL_SECRET = process.env.GITHUB_APP_WEBHOOK_SECRET;
  beforeEach(() => {
    _resetEchoGuardForTest();
    process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.GITHUB_APP_WEBHOOK_SECRET;
    else process.env.GITHUB_APP_WEBHOOK_SECRET = ORIGINAL_SECRET;
  });

  // A fake pg with the minimal surface handleIssues touches for an EXISTING linked issue.
  function webhookApp() {
    const requireAuth = async (_c: Context<RelayEnv>, next: Next) => {
      await next();
    };
    const pg = {
      async getRepoSync(installationId: string, repoId: string) {
        if (installationId === INSTALLATION_ID && repoId === REPO_ID) {
          return {
            id: "ghrs_echo",
            workspaceId: WS,
            installationId,
            tasksProjectId: TASKS_PROJECT_ID,
            repoId,
            owner: "acme",
            name: "app",
            repoUrl: "https://github.com/acme/app",
            syncDirection: "bidirectional",
            issueOpenStateId: null,
            issueClosedStateId: null,
            createdBy: MEMBER,
            createdAt: 0,
          };
        }
        return null;
      },
      async getTaskByIssue() {
        return { syncId: "ghis_echo", taskId: TASK_ID };
      },
      async getGithubSyncStates() {
        return { openStateId: null, closedStateId: null };
      },
      async updateTask() {},
      async upsertIssueSync() {},
      async recordTaskActivity() {},
    } as unknown as PgSync;
    return createGithubRoutes({ pg, requireAuth });
  }

  function postIssue(app: ReturnType<typeof webhookApp>, payload: unknown): Promise<Response> {
    const raw = JSON.stringify(payload);
    const sig = `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
    return app.request("/api/github/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issues",
        "X-Hub-Signature-256": sig,
      },
      body: raw,
    });
  }

  const baseIssue = {
    repository: { id: Number(REPO_ID), name: "app", owner: { login: "acme" } },
    installation: { id: Number(INSTALLATION_ID) },
  };

  it("an `edited` event that changed only the BODY marks body but NOT title or state", async () => {
    const app = webhookApp();
    const res = await postIssue(app, {
      ...baseIssue,
      action: "edited",
      issue: { number: ISSUE_NUMBER, id: 1, title: "Same title", body: "new body", state: "open" },
      changes: { body: { from: "old body" } },
    });
    expect(res.status).toBe(200);
    // Only "body" is marked — a later genuine title/state edit is NOT falsely suppressed.
    expect(consumeInbound(TASK_ID, "body")).toBe(true);
    expect(consumeInbound(TASK_ID, "title")).toBe(false);
    expect(consumeInbound(TASK_ID, "reopen")).toBe(false);
    expect(consumeInbound(TASK_ID, "close")).toBe(false);
  });

  it("a `closed` event marks ONLY the close state, not title/body", async () => {
    const app = webhookApp();
    const res = await postIssue(app, {
      ...baseIssue,
      action: "closed",
      issue: { number: ISSUE_NUMBER, id: 1, title: "T", body: "B", state: "closed" },
    });
    expect(res.status).toBe(200);
    expect(consumeInbound(TASK_ID, "close")).toBe(true);
    expect(consumeInbound(TASK_ID, "title")).toBe(false);
    expect(consumeInbound(TASK_ID, "body")).toBe(false);
  });
});

describe("POST /api/github/pr-mappings — cross-project state validation", () => {
  const STATE_IN_PROJECT = "ts_tp_1_started";
  const STATE_OTHER_PROJECT = "ts_tp_other_started";

  it("rejects (400) a taskStateId that belongs to a DIFFERENT project", async () => {
    const prMappingUpserts: Array<Record<string, unknown>> = [];
    const app = makeApp({
      callerId: MEMBER,
      members: new Set([MEMBER]),
      validStateIds: new Set([STATE_IN_PROJECT]),
      prMappingUpserts,
    });

    const res = await postJson(app, "/api/github/pr-mappings", {
      tasksProjectId: PROJECT_CHAT_ID,
      prState: "MR_OPENED",
      taskStateId: STATE_OTHER_PROJECT,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "state does not belong to project" });
    expect(prMappingUpserts).toHaveLength(0); // nothing persisted for a foreign state
  });

  it("accepts a taskStateId that belongs to the target project", async () => {
    const prMappingUpserts: Array<Record<string, unknown>> = [];
    const app = makeApp({
      callerId: MEMBER,
      members: new Set([MEMBER]),
      validStateIds: new Set([STATE_IN_PROJECT]),
      prMappingUpserts,
    });

    const res = await postJson(app, "/api/github/pr-mappings", {
      tasksProjectId: PROJECT_CHAT_ID,
      prState: "MR_OPENED",
      taskStateId: STATE_IN_PROJECT,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "ghprm_new" });
    expect(prMappingUpserts).toHaveLength(1);
    expect(prMappingUpserts[0]).toMatchObject({
      tasksProjectId: TASKS_PROJECT_ID,
      prState: "MR_OPENED",
      taskStateId: STATE_IN_PROJECT,
    });
  });

  it("accepts an empty taskStateId (clearing the chosen state) without a project check", async () => {
    const prMappingUpserts: Array<Record<string, unknown>> = [];
    const app = makeApp({
      callerId: MEMBER,
      members: new Set([MEMBER]),
      validStateIds: new Set([STATE_IN_PROJECT]),
      prMappingUpserts,
    });

    const res = await postJson(app, "/api/github/pr-mappings", {
      tasksProjectId: PROJECT_CHAT_ID,
      prState: "MR_OPENED",
      taskStateId: "",
    });

    expect(res.status).toBe(200);
    expect(prMappingUpserts[0]).toMatchObject({ taskStateId: null });
  });
});

describe("POST /api/github/repo-sync — cross-project issue-state validation", () => {
  const STATE_IN_PROJECT = "ts_tp_1_unstarted";
  const STATE_OTHER_PROJECT = "ts_tp_other_completed";
  const bindBody = {
    tasksProjectId: PROJECT_CHAT_ID,
    installationId: INSTALLATION_ID,
    repoId: "999",
    owner: "acme",
    name: "app",
  };

  it("rejects (400) an issueOpenStateId from a DIFFERENT project", async () => {
    const binds: Array<Record<string, unknown>> = [];
    const app = makeApp({
      callerId: MEMBER,
      members: new Set([MEMBER]),
      validStateIds: new Set([STATE_IN_PROJECT]),
      binds,
    });

    const res = await postJson(app, "/api/github/repo-sync", {
      ...bindBody,
      issueOpenStateId: STATE_OTHER_PROJECT,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "state does not belong to project" });
    expect(binds).toHaveLength(0); // not bound with a foreign state
  });

  it("binds when both issue-state overrides belong to the target project", async () => {
    const binds: Array<Record<string, unknown>> = [];
    const app = makeApp({
      callerId: MEMBER,
      members: new Set([MEMBER]),
      validStateIds: new Set([STATE_IN_PROJECT]),
      binds,
    });

    const res = await postJson(app, "/api/github/repo-sync", {
      ...bindBody,
      issueOpenStateId: STATE_IN_PROJECT,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "ghrs_new" });
    expect(binds).toHaveLength(1);
    expect(binds[0]).toMatchObject({ issueOpenStateId: STATE_IN_PROJECT });
  });
});

describe("GET /api/github/callback — open-redirect hardening (redirect base)", () => {
  const ORIGINAL_APP_URL = process.env.CYBORG_APP_URL;
  afterEach(() => {
    if (ORIGINAL_APP_URL === undefined) delete process.env.CYBORG_APP_URL;
    else process.env.CYBORG_APP_URL = ORIGINAL_APP_URL;
  });

  it("redirects to CYBORG_APP_URL, NOT an attacker-controlled X-Forwarded-Host", async () => {
    process.env.CYBORG_APP_URL = "https://app.cyborg7.com";
    const app = makeApp({ callerId: MEMBER, members: new Set([MEMBER]) });

    const res = await app.request(
      `/api/github/callback?state=${WS}&installation_id=${INSTALLATION_ID}`,
      {
        method: "GET",
        headers: { "X-Forwarded-Host": "evil.example.com", "X-Forwarded-Proto": "https" },
      },
    );

    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith("https://app.cyborg7.com/")).toBe(true);
    expect(loc).not.toContain("evil.example.com");
  });

  it("falls back to the request origin only when CYBORG_APP_URL is unset (dev)", async () => {
    delete process.env.CYBORG_APP_URL;
    const app = makeApp({ callerId: MEMBER, members: new Set([MEMBER]) });

    const res = await app.request(`/api/github/callback?state=${WS}`, {
      method: "GET",
      headers: { "X-Forwarded-Host": "localhost:5173", "X-Forwarded-Proto": "http" },
    });

    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith("http://localhost:5173/")).toBe(true);
  });
});

describe("malformed JSON bodies — a null/array payload returns 400, never a 500 crash", () => {
  // FIX (Gemini, security): each POST/PATCH parses `c.req.json()` then indexes the
  // result / uses the `in` operator on it. A `null`, array, or primitive body slipped
  // past the `as Record<string, unknown>` cast and crashed property access / `in` with
  // a TypeError → 500. The obj()-coerce guard turns every non-object body into {} so
  // the normal field validation rejects it cleanly with a 400.
  const member = { callerId: MEMBER, members: new Set([MEMBER]) };

  it("POST /installations/confirm with a null body → 400 (not 500)", async () => {
    const res = await postJson(makeApp(member), "/api/github/installations/confirm", null);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "workspaceId, installationId required" });
  });

  it("POST /installations/confirm with an array body → 400 (not 500)", async () => {
    const res = await postJson(makeApp(member), "/api/github/installations/confirm", []);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "workspaceId, installationId required" });
  });

  it("POST /repo-sync with a null body → 400 (not 500)", async () => {
    const res = await postJson(makeApp(member), "/api/github/repo-sync", null);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "tasksProjectId, installationId, repoId, owner, name required",
    });
  });

  it("POST /pr-mappings with a null body → 400 (not 500)", async () => {
    const res = await postJson(makeApp(member), "/api/github/pr-mappings", null);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "tasksProjectId, prState required" });
  });
});

describe("GET /api/github/oauth/callback — invalid token / empty login → oauth_error (no upsert)", () => {
  const APP_URL = "https://app.cyborg7.com";
  const SECRET = "test-oauth-secret";
  const CLIENT_ID = "Iv1.testclient";

  const ORIGINAL_APP_URL = process.env.CYBORG_APP_URL;
  const ORIGINAL_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID;
  const ORIGINAL_CLIENT_SECRET = process.env.GITHUB_OAUTH_CLIENT_SECRET;

  beforeEach(() => {
    process.env.CYBORG_APP_URL = APP_URL;
    process.env.GITHUB_OAUTH_CLIENT_ID = CLIENT_ID;
    process.env.GITHUB_OAUTH_CLIENT_SECRET = SECRET;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL_APP_URL === undefined) delete process.env.CYBORG_APP_URL;
    else process.env.CYBORG_APP_URL = ORIGINAL_APP_URL;
    if (ORIGINAL_CLIENT_ID === undefined) delete process.env.GITHUB_OAUTH_CLIENT_ID;
    else process.env.GITHUB_OAUTH_CLIENT_ID = ORIGINAL_CLIENT_ID;
    if (ORIGINAL_CLIENT_SECRET === undefined) delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
    else process.env.GITHUB_OAUTH_CLIENT_SECRET = ORIGINAL_CLIENT_SECRET;
  });

  // Mint a `state` the PUBLIC callback will trust — same scheme the route signs with:
  // base64url(json).hmac-sha256(clientSecret).
  function signState(): string {
    const body = Buffer.from(
      JSON.stringify({ workspaceId: WS, userId: MEMBER, returnTo: "" }),
    ).toString("base64url");
    const sig = createHmac("sha256", SECRET).update(body).digest("base64url");
    return `${body}.${sig}`;
  }

  // App over a pg that records whether the credential row was ever written.
  function oauthApp(upserts: Array<Record<string, unknown>>) {
    const requireAuth = async (_c: Context<RelayEnv>, next: Next) => {
      await next();
    };
    const pg = {
      async upsertGithubUserConnection(o: Record<string, unknown>) {
        upserts.push(o);
        return "ghuc_new";
      },
    } as unknown as PgSync;
    return createGithubRoutes({ pg, requireAuth });
  }

  // First fetch = the token exchange (always returns a token); the second = GET /user,
  // whose ok-ness and body the test controls.
  function stubFetch(user: { ok: boolean; body: unknown }) {
    vi.stubGlobal("fetch", async (url: unknown) => {
      if (typeof url === "string" && url.includes("login/oauth/access_token")) {
        return { ok: true, json: async () => ({ access_token: "ghu_token", scope: "repo" }) };
      }
      return { ok: user.ok, json: async () => user.body };
    });
  }

  function callback(app: ReturnType<typeof oauthApp>): Promise<Response> {
    return app.request(
      `/api/github/oauth/callback?code=abc123&state=${encodeURIComponent(signState())}`,
      { method: "GET" },
    );
  }

  it("a non-ok GitHub /user response → oauth_error redirect, no connection persisted", async () => {
    const upserts: Array<Record<string, unknown>> = [];
    stubFetch({ ok: false, body: { message: "Bad credentials" } });

    const res = await callback(oauthApp(upserts));

    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("github=oauth_error");
    expect(loc).not.toContain("personal_connected");
    expect(upserts).toHaveLength(0);
  });

  it("a 2xx /user response with an empty login → oauth_error redirect, no connection", async () => {
    const upserts: Array<Record<string, unknown>> = [];
    stubFetch({ ok: true, body: { login: "" } });

    const res = await callback(oauthApp(upserts));

    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("github=oauth_error");
    expect(upserts).toHaveLength(0);
  });

  it("a valid token + login persists the connection and lands on personal_connected", async () => {
    const upserts: Array<Record<string, unknown>> = [];
    stubFetch({ ok: true, body: { login: "octocat" } });

    const res = await callback(oauthApp(upserts));

    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("github=personal_connected");
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ workspaceId: WS, userId: MEMBER, githubLogin: "octocat" });
  });
});

describe("GitHub OAuth redirect_uri — stable base, byte-identical at authorize + token-exchange", () => {
  // OAuth requires the redirect_uri to be byte-identical at authorize-time
  // (oauth/start) and token-exchange-time (oauth/callback). These run on SEPARATE
  // requests whose Host headers can differ and are attacker-influenceable behind a
  // proxy, so oauthCallbackUrl() must resolve a STABLE configured base, never the host.
  const APP_URL = "https://app.cyborg7.com";
  const SECRET = "test-oauth-secret";
  const CLIENT_ID = "Iv1.testclient";
  const EXPECTED_REDIRECT = `${APP_URL}/api/github/oauth/callback`;

  const ORIGINAL_APP_URL = process.env.CYBORG_APP_URL;
  const ORIGINAL_CALLBACK_BASE = process.env.GITHUB_OAUTH_CALLBACK_BASE;
  const ORIGINAL_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID;
  const ORIGINAL_CLIENT_SECRET = process.env.GITHUB_OAUTH_CLIENT_SECRET;

  beforeEach(() => {
    process.env.CYBORG_APP_URL = APP_URL;
    delete process.env.GITHUB_OAUTH_CALLBACK_BASE;
    process.env.GITHUB_OAUTH_CLIENT_ID = CLIENT_ID;
    process.env.GITHUB_OAUTH_CLIENT_SECRET = SECRET;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL_APP_URL === undefined) delete process.env.CYBORG_APP_URL;
    else process.env.CYBORG_APP_URL = ORIGINAL_APP_URL;
    if (ORIGINAL_CALLBACK_BASE === undefined) delete process.env.GITHUB_OAUTH_CALLBACK_BASE;
    else process.env.GITHUB_OAUTH_CALLBACK_BASE = ORIGINAL_CALLBACK_BASE;
    if (ORIGINAL_CLIENT_ID === undefined) delete process.env.GITHUB_OAUTH_CLIENT_ID;
    else process.env.GITHUB_OAUTH_CLIENT_ID = ORIGINAL_CLIENT_ID;
    if (ORIGINAL_CLIENT_SECRET === undefined) delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
    else process.env.GITHUB_OAUTH_CLIENT_SECRET = ORIGINAL_CLIENT_SECRET;
  });

  function signState(): string {
    const body = Buffer.from(
      JSON.stringify({ workspaceId: WS, userId: MEMBER, returnTo: "" }),
    ).toString("base64url");
    const sig = createHmac("sha256", SECRET).update(body).digest("base64url");
    return `${body}.${sig}`;
  }

  async function startRedirectUri(): Promise<string | null> {
    const app = makeApp({ callerId: MEMBER, members: new Set([MEMBER]) });
    const res = await app.request(`/api/github/oauth/start?workspaceId=${WS}`, {
      method: "GET",
      headers: { "X-Forwarded-Host": "evil.example.com", "X-Forwarded-Proto": "https" },
    });
    expect(res.status).toBe(200);
    const { configured, url } = (await res.json()) as { configured: boolean; url: string };
    expect(configured).toBe(true);
    expect(url).not.toContain("evil.example.com");
    return new URL(url).searchParams.get("redirect_uri");
  }

  it("oauth/start builds redirect_uri from the stable base, NOT an attacker X-Forwarded-Host", async () => {
    expect(await startRedirectUri()).toBe(EXPECTED_REDIRECT);
  });

  it("GITHUB_OAUTH_CALLBACK_BASE overrides CYBORG_APP_URL for the callback origin", async () => {
    process.env.GITHUB_OAUTH_CALLBACK_BASE = "https://relay.cyborg7.com/";
    const app = makeApp({ callerId: MEMBER, members: new Set([MEMBER]) });
    const res = await app.request(`/api/github/oauth/start?workspaceId=${WS}`, { method: "GET" });
    const { url } = (await res.json()) as { url: string };
    expect(new URL(url).searchParams.get("redirect_uri")).toBe(
      "https://relay.cyborg7.com/api/github/oauth/callback",
    );
  });

  it("oauth/callback sends the SAME redirect_uri to GitHub's token endpoint (byte-identical)", async () => {
    const startRedirect = await startRedirectUri();

    let exchangeRedirect: string | null = null;
    vi.stubGlobal("fetch", async (u: unknown, init?: { body?: string }) => {
      if (typeof u === "string" && u.includes("login/oauth/access_token")) {
        const parsed = JSON.parse(init?.body ?? "{}") as { redirect_uri?: string };
        exchangeRedirect = parsed.redirect_uri ?? null;
        return { ok: true, json: async () => ({ access_token: "ghu_token", scope: "repo" }) };
      }
      return { ok: true, json: async () => ({ login: "octocat" }) };
    });

    const requireAuth = async (_c: Context<RelayEnv>, next: Next) => {
      await next();
    };
    const pg = {
      async upsertGithubUserConnection() {
        return "ghuc_new";
      },
    } as unknown as PgSync;
    const app = createGithubRoutes({ pg, requireAuth });
    const res = await app.request(
      `/api/github/oauth/callback?code=abc123&state=${encodeURIComponent(signState())}`,
      { method: "GET" },
    );

    expect(res.status).toBe(302);
    expect(exchangeRedirect).toBe(EXPECTED_REDIRECT);
    expect(exchangeRedirect).toBe(startRedirect);
  });
});
