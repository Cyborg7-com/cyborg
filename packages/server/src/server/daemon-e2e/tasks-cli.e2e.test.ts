import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

// ── E2E: the new task/project CLI commands against a REAL solo daemon ──────────
//
// Boots a real Paseo daemon (solo SQLite, no Postgres, ephemeral port) and drives
// EVERY new task/project CLI command end-to-end by spawning the BUILT cli at
// packages/cli/dist/cyborg.js as a subprocess. This exercises the true wire path:
//   CLI (dist) → WebSocket → daemon session → CyborgDispatcher → DualStorage.
//
// Auth: the test daemon does NOT enable the dev-token HTTP endpoint (it is gated on
// config.isDev, which the test fixture leaves unset). So we pin a known HS256 secret
// in the daemon's env and mint a guest JWT locally with that same secret (matching
// CyborgAuth.createToken exactly), then pass it to the CLI via --token. The first
// cyborg:auth upserts the user; ws:create / ch:create then build the fixtures.

const TEST_JWT_SECRET = "cyborg7-cli-e2e-secret-do-not-use-in-prod";
const QA_EMAIL = "qa-tasks-cli@example.com";
const QA_NAME = "QA Tasks CLI";

// repo root: this file is at packages/server/src/server/daemon-e2e/<file>
const SERVER_ROOT = path.resolve(import.meta.dirname, "../../..");
const REPO_ROOT = path.resolve(SERVER_ROOT, "../..");
const CLI_ENTRY = path.join(REPO_ROOT, "packages/cli/dist/cyborg.js");

function base64Url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

// Mirror CyborgAuth.createToken byte-for-byte so signer (this test) == verifier
// (the daemon's CyborgAuth, constructed with the same CYBORG7_JWT_SECRET).
function mintDevToken(email: string, name: string): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64Url(JSON.stringify({ email, name, exp: now + 86_400, iat: now }));
  const signature = createHmac("sha256", TEST_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

// Tolerant JSON extractor: the CLI writes pretty JSON to stdout on success and
// `{ "error": {...} }` to stderr on failure. Strip any stray leading/trailing
// noise by slicing to the outermost brace/bracket before parsing.
function parseJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstObj = trimmed.indexOf("{");
    const firstArr = trimmed.indexOf("[");
    const candidates = [firstObj, firstArr].filter((i) => i !== -1);
    const start = candidates.length === 0 ? -1 : Math.min(...candidates);
    if (start === -1) return undefined;
    const open = trimmed[start];
    const close = open === "{" ? "}" : "]";
    const end = trimmed.lastIndexOf(close);
    if (end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ok: boolean;
  data: unknown;
  error?: { code?: string; message?: string; details?: unknown };
}

let daemon: TestPaseoDaemon;
let host: string;
let token: string;
let cliHome: string;
const originalSecret = process.env.CYBORG7_JWT_SECRET;

// Spawn the built CLI; --host/--token/--json are appended to every invocation.
function runCli(args: string[], timeoutMs = 20_000): Promise<CliResult> {
  return new Promise<CliResult>((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ["--disable-warning=DEP0040", CLI_ENTRY, ...args, "--host", host, "--token", token, "--json"],
      {
        env: { ...process.env, PASEO_HOME: cliHome, CYBORG7_JWT_SECRET: TEST_JWT_SECRET },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const killTimer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeoutMs}ms: cyborg ${args.join(" ")}`));
    }, timeoutMs);
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    proc.on("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(killTimer);
      const ok = code === 0;
      const errBody = ok
        ? undefined
        : (parseJson(stderr) as { error?: CliResult["error"] } | undefined);
      resolve({
        code,
        stdout,
        stderr,
        ok,
        data: ok ? parseJson(stdout) : undefined,
        error: errBody?.error,
      });
    });
  });
}

interface ProjectRow {
  id: string;
  identifier: string;
  name: string;
  isInbox: boolean;
  chatProjectId: string | null;
}
interface TaskRow {
  id: string;
  title: string;
  status: string;
  priority?: string | null;
  project_id?: string | null;
  archivedAt?: number | null;
}

let workspaceId: string;
let channelId: string;
let inboxId: string;
let inboxTaskId: string;
let explicitTaskId: string;

beforeAll(async () => {
  // Pin the secret BEFORE booting so the daemon's CyborgAuth trusts our minted JWT.
  process.env.CYBORG7_JWT_SECRET = TEST_JWT_SECRET;
  cliHome = await mkdtemp(path.join(os.tmpdir(), "cyborg-cli-e2e-"));
  daemon = await createTestPaseoDaemon({ relayEnabled: false });
  host = `127.0.0.1:${daemon.port}`;
  token = mintDevToken(QA_EMAIL, QA_NAME);

  // Build fixtures through the CLI itself (QAs ws:create + ch:create). The channel
  // is deliberately project-less so a channel-scoped task falls back to the Inbox.
  const ws = await runCli(["ws:create", "QA Tasks WS"]);
  expect(ws.ok, `ws:create failed: ${ws.stderr}`).toBe(true);
  workspaceId = (ws.data as { id: string }).id;
  expect(workspaceId).toBeTruthy();

  const ch = await runCli(["ch:create", workspaceId, "general"]);
  expect(ch.ok, `ch:create failed: ${ch.stderr}`).toBe(true);
  channelId = (ch.data as { id: string }).id;
  expect(channelId).toBeTruthy();
}, 60_000);

afterAll(async () => {
  await daemon?.close();
  if (cliHome) await rm(cliHome, { recursive: true, force: true });
  if (originalSecret === undefined) delete process.env.CYBORG7_JWT_SECRET;
  else process.env.CYBORG7_JWT_SECRET = originalSecret;
});

describe("task/project CLI e2e (real solo daemon)", () => {
  // 1. project:list on a fresh workspace → succeeds (Inbox-or-empty).
  test("1. project:list on a fresh workspace succeeds (empty)", async () => {
    const res = await runCli(["project:list", workspaceId]);
    expect(res.ok, res.stderr).toBe(true);
    expect(Array.isArray(res.data)).toBe(true);
    // A brand-new workspace has no Tasks-projects until the first task is filed.
    expect((res.data as ProjectRow[]).length).toBe(0);
  });

  // 2. task:create with NEITHER --project NOR --channel NOR --parent → MUST fail
  //    FAST with the server's real message. The daemon's handleCreateTask now
  //    catches storage.createTask's "provide projectId or channelId" throw and emits
  //    a cyborg:error the CLI matches by requestId — so the request rejects right
  //    away instead of hanging to the client's 15s request timeout (DEFAULT_TIMEOUT)
  //    on an unmatched rpc_error.
  test("2. task:create with no project/channel/parent fails fast with the message", async () => {
    const started = Date.now();
    const res = await runCli(["task:create", workspaceId, "Orphan task"], 25_000);
    const elapsedMs = Date.now() - started;
    expect(res.ok).toBe(false);
    // Fails FAST — well under the CLI client's 15s request timeout. A regression that
    // re-buries the error in an rpc_error would hang to ~15s and trip this.
    expect(elapsedMs, `expected a fast failure, took ${elapsedMs}ms`).toBeLessThan(8_000);
    // ...and carries the server's actual validation message, not a timeout string.
    const failureText = `${res.error?.message ?? ""} ${res.stderr}`;
    expect(failureText).toContain("provide projectId or channelId");
    // Prove nothing was created.
    const list = await runCli(["task:list", workspaceId]);
    expect(list.ok, list.stderr).toBe(true);
    expect((list.data as TaskRow[]).length).toBe(0);
  }, 35_000);

  // 3. task:create --channel (project-less channel) → lands in the workspace Inbox.
  //    NOTE on the contract: the wire `project_id` is the CHAT project id, not the
  //    tasks_projects id. The Inbox has no chat project, so an Inbox task reads back
  //    `project_id: null`. Membership is proven via the project filter (which matches
  //    the STORED tasks_projects.id before that translation), not the field value.
  test("3. task:create --channel lands in the Inbox", async () => {
    const res = await runCli(["task:create", workspaceId, "T-inbox", "--channel", channelId]);
    expect(res.ok, res.stderr).toBe(true);
    const task = res.data as TaskRow;
    expect(task.id).toBeTruthy();
    expect(task.title).toBe("T-inbox");
    // Inbox task → wire project_id is null (Inbox has no chat project). Locked in.
    expect(task.project_id ?? null).toBeNull();
    inboxTaskId = task.id;

    // Prove it actually landed in the Inbox: find the Inbox, then scope the list to it.
    const projects = await runCli(["project:list", workspaceId]);
    expect(projects.ok, projects.stderr).toBe(true);
    const inbox = (projects.data as ProjectRow[]).find((p) => p.isInbox);
    expect(inbox, "expected an Inbox project after the first channel task").toBeTruthy();
    inboxId = inbox!.id;
    const scoped = await runCli(["task:list", workspaceId, "--project", inboxId]);
    expect(scoped.ok, scoped.stderr).toBe(true);
    expect((scoped.data as TaskRow[]).map((t) => t.id)).toContain(inboxTaskId);
  });

  // 4. project:list → now includes the Inbox (isInbox true, identifier "INBOX").
  test("4. project:list now includes the Inbox", async () => {
    const res = await runCli(["project:list", workspaceId]);
    expect(res.ok, res.stderr).toBe(true);
    const projects = res.data as ProjectRow[];
    const inbox = projects.find((p) => p.isInbox);
    expect(inbox, "expected an Inbox project").toBeTruthy();
    expect(inbox!.identifier).toBe("INBOX");
    expect(inbox!.chatProjectId).toBeNull();
    expect(inbox!.id).toBe(inboxId);
  });

  // 5. task:create --project <inboxId> → succeeds (explicit project id path).
  test("5. task:create --project <inboxId> succeeds", async () => {
    const res = await runCli(["task:create", workspaceId, "T2", "--project", inboxId]);
    expect(res.ok, res.stderr).toBe(true);
    const task = res.data as TaskRow;
    expect(task.title).toBe("T2");
    // Same translation: stored project_id == inboxId, but the wire echoes the chat id
    // (null for the Inbox). Membership is verified via the filter below.
    expect(task.project_id ?? null).toBeNull();
    explicitTaskId = task.id;

    const scoped = await runCli(["task:list", workspaceId, "--project", inboxId]);
    expect(scoped.ok, scoped.stderr).toBe(true);
    expect((scoped.data as TaskRow[]).map((t) => t.id)).toContain(explicitTaskId);
  });

  // 6. task:list → includes the created tasks.
  test("6. task:list includes both created tasks", async () => {
    const res = await runCli(["task:list", workspaceId]);
    expect(res.ok, res.stderr).toBe(true);
    const ids = (res.data as TaskRow[]).map((t) => t.id);
    expect(ids).toContain(inboxTaskId);
    expect(ids).toContain(explicitTaskId);
  });

  // 7. task:list --project <inboxId> → filtered to that project's tasks only.
  //    The filter resolves inboxId to the stored tasks_projects.id and scopes on it,
  //    so the result is exactly the two Inbox tasks (and nothing else). An unknown
  //    project id fails closed with not_found.
  test("7. task:list --project <inboxId> is scoped to the Inbox", async () => {
    const res = await runCli(["task:list", workspaceId, "--project", inboxId]);
    expect(res.ok, res.stderr).toBe(true);
    const ids = (res.data as TaskRow[]).map((t) => t.id);
    expect(ids).toContain(inboxTaskId);
    expect(ids).toContain(explicitTaskId);
    // Only the Inbox tasks come back under this scope (no other tasks exist anyway).
    expect(new Set(ids)).toEqual(new Set([inboxTaskId, explicitTaskId]));
    // A bogus project filter fails closed (proves the filter resolves projects).
    const bogus = await runCli(["task:list", workspaceId, "--project", "tproj_does_not_exist"]);
    expect(bogus.ok).toBe(false);
  });

  // 8. task:update --status done → reflected on a follow-up task:list.
  test("8. task:update --status done is persisted", async () => {
    const res = await runCli(["task:update", workspaceId, explicitTaskId, "--status", "done"]);
    expect(res.ok, res.stderr).toBe(true);
    expect((res.data as TaskRow).status).toBe("done");
    const after = await taskById(explicitTaskId);
    expect(after.status).toBe("done");
  });

  // 9. task:archive → archived; --unarchive restores. (Visibility note in report:
  //    the daemon's task:list does NOT hide archived tasks; archivedAt is the signal.)
  test("9. task:archive sets archivedAt; --unarchive clears it", async () => {
    const arch = await runCli(["task:archive", workspaceId, explicitTaskId]);
    expect(arch.ok, arch.stderr).toBe(true);
    expect(typeof (arch.data as TaskRow).archivedAt).toBe("number");

    const unarch = await runCli(["task:archive", workspaceId, explicitTaskId, "--unarchive"]);
    expect(unarch.ok, unarch.stderr).toBe(true);
    expect((unarch.data as TaskRow).archivedAt).toBeNull();
  });

  // 10. task:bulk-update --priority high → applied to all listed tasks.
  test("10. task:bulk-update --priority high applies to all", async () => {
    const res = await runCli([
      "task:bulk-update",
      workspaceId,
      inboxTaskId,
      explicitTaskId,
      "--priority",
      "high",
    ]);
    expect(res.ok, res.stderr).toBe(true);
    const tasks = res.data as TaskRow[];
    expect(tasks.length).toBe(2);
    for (const t of tasks) expect(t.priority).toBe("high");
    // Confirm via an independent read.
    expect((await taskById(inboxTaskId)).priority).toBe("high");
    expect((await taskById(explicitTaskId)).priority).toBe("high");
  });

  // 11. task:delete → deleted:true; follow-up task:list no longer includes it.
  test("11. task:delete removes the task", async () => {
    const res = await runCli(["task:delete", workspaceId, explicitTaskId]);
    expect(res.ok, res.stderr).toBe(true);
    expect((res.data as { deleted: boolean }).deleted).toBe(true);
    const list = await runCli(["task:list", workspaceId]);
    expect(list.ok, list.stderr).toBe(true);
    const ids = (list.data as TaskRow[]).map((t) => t.id);
    expect(ids).not.toContain(explicitTaskId);
    expect(ids).toContain(inboxTaskId); // the other task is untouched
  });
});

// Helper: fetch a single task row by id via task:list (no get-by-id CLI command).
async function taskById(taskId: string): Promise<TaskRow> {
  const res = await runCli(["task:list", workspaceId]);
  expect(res.ok, res.stderr).toBe(true);
  const found = (res.data as TaskRow[]).find((t) => t.id === taskId);
  expect(found, `task ${taskId} not found in list`).toBeTruthy();
  return found!;
}
