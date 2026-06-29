import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Logger } from "pino";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { getPool, closePool } from "./db/connection.js";
import { PgSync } from "./db/pg-sync.js";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { WorkspaceRelay } from "./workspace-relay.js";
import { ScheduleRunner } from "./schedule-runner.js";
import {
  createCyborg7McpServer,
  type Cyborg7McpContext,
  type Cyborg7McpDeps,
} from "./cyborg7-mcp-tools.js";
import type {
  CyboReadRequest,
  CyboReadResponse,
  CyboWriteRequest,
  CyboWriteResponse,
} from "./relay-protocol.js";
import type { StoredSchedule } from "./storage.js";
import { MessageRouter } from "./message-router.js";
import type { AgentManager } from "../agent/agent-manager.js";

// PG-GATED, REAL-DB integration proof for the non-cybo agent task/schedule feature
// (branch feat/agent-cyborg-mcp-tools). The solo/SQLite e2e and the mocked unit
// tests cannot exercise what actually breaks in production: the CLOUD relay write
// path against real Postgres, the membership permission gate, and the real MCP
// HTTP transport. This file drives each of those against a live PG (DATABASE_URL),
// using a UNIQUE throwaway workspace per run and cleaning every row it created.
//
// Skipped when DATABASE_URL is unset, so it is committable and a no-op in CI:
//   DATABASE_URL=postgresql://cyborg7:cyborg7@localhost:5432/cyborg7 \
//     pnpm --filter @getpaseo/server exec vitest run \
//     src/server/cyborg/agent-tools-pg.integration.test.ts
const hasPg = !!process.env.DATABASE_URL;

const MCP_ROUTE = "/mcp/cyborg7";

interface TaskRow {
  created_by: string;
  title: string;
  status: string;
}
interface ScheduleRow {
  created_by: string;
  cron_expr: string;
  prompt: string;
}

describe.skipIf(!hasPg)(
  "non-cybo agent task/schedule — real Postgres (requires DATABASE_URL)",
  () => {
    // One unique throwaway workspace + users per run (cleaned up in afterAll).
    const runId = randomUUID().slice(0, 8);
    const memberId = `u_member_${randomUUID()}`; // the spawning user — a non-viewer member
    const viewerId = `u_viewer_${randomUUID()}`; // a viewer — must be rejected by the gate
    const wsId = `ws_pgit_${randomUUID()}`;
    const agentUuid = randomUUID(); // the ephemeral non-cybo agent (NOT a workspace member)
    let cyboId: string; // a cybo owned by the member (control: the unchanged cybo path)

    // Feature 1/2 fixtures (seeded in beforeAll). chId: the cybo IS a member +
    // memberId is a human member. chNoCybo: memberId is a member, the cybo is NOT
    // (membership-gate reject). chEmpty: no members at all (empty-roster []). The
    // foreign workspace + task prove the cross-workspace IDOR rejection.
    const chId = `ch_${randomUUID()}`;
    const chNoCybo = `ch_${randomUUID()}`;
    const chEmpty = `ch_${randomUUID()}`;
    const otherWsId = `ws_other_${randomUUID()}`;
    const otherMemberId = `u_other_${randomUUID()}`;
    let foreignTaskId: string; // a task in otherWsId (cross-workspace IDOR target)

    let tmpDir: string;
    let storage: DualStorage; // SQLite cache + REAL PG (connected daemon)
    let relay: WorkspaceRelay; // the cloud relay, wired to REAL PG
    let nonCyboDeps: Cyborg7McpDeps;
    let nonCyboCtx: Cyborg7McpContext;

    // ── helpers ──────────────────────────────────────────────────────

    async function pgTaskById(id: string): Promise<TaskRow | undefined> {
      const out = await getPool().query<TaskRow>(
        "SELECT created_by, title, status FROM tasks WHERE id = $1",
        [id],
      );
      return out.rows[0];
    }

    async function pgTaskCountByTitle(title: string): Promise<number> {
      const out = await getPool().query<{ n: string }>(
        "SELECT count(*)::text AS n FROM tasks WHERE workspace_id = $1 AND title = $2",
        [wsId, title],
      );
      return Number(out.rows[0].n);
    }

    async function pgScheduleById(id: string): Promise<ScheduleRow | undefined> {
      const out = await getPool().query<ScheduleRow>(
        "SELECT created_by, cron_expr, prompt FROM schedules WHERE id = $1",
        [id],
      );
      return out.rows[0];
    }

    // Poll a real-PG read until it returns a row (the DualStorage PG mirror is
    // async fire-and-forget, so a connected-daemon write lands a tick later).
    async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    // Drive the CLOUD write directly: invoke the relay's private handleCyboWrite
    // (the exact path daemon → relay → PG takes) and return the single reply it
    // sends back over the (fake) socket.
    async function relayWrite(
      partial: Partial<CyboWriteRequest> & Pick<CyboWriteRequest, "kind">,
    ): Promise<CyboWriteResponse> {
      const replies: CyboWriteResponse[] = [];
      const fakeWs = {
        readyState: 1, // WebSocket.OPEN — the relay's send() gate
        send: (raw: string) => replies.push(JSON.parse(raw) as CyboWriteResponse),
      };
      const msg = {
        type: "cybo_write_request",
        requestId: randomUUID(),
        workspaceId: wsId,
        ...partial,
      } as CyboWriteRequest;
      await (
        relay as unknown as { handleCyboWrite(ws: unknown, m: CyboWriteRequest): Promise<void> }
      ).handleCyboWrite(fakeWs, msg);
      expect(replies).toHaveLength(1);
      return replies[0];
    }

    // Drive the CLOUD read directly (daemon → relay → PG), same shape as relayWrite.
    async function relayRead(
      partial: Partial<CyboReadRequest> & Pick<CyboReadRequest, "kind" | "cyboId">,
    ): Promise<CyboReadResponse> {
      const replies: CyboReadResponse[] = [];
      const fakeWs = {
        readyState: 1,
        send: (raw: string) => replies.push(JSON.parse(raw) as CyboReadResponse),
      };
      const msg = {
        type: "cybo_read_request",
        requestId: randomUUID(),
        workspaceId: wsId,
        ...partial,
      } as CyboReadRequest;
      await (
        relay as unknown as { handleCyboRead(ws: unknown, m: CyboReadRequest): Promise<void> }
      ).handleCyboRead(fakeWs, msg);
      expect(replies).toHaveLength(1);
      return replies[0];
    }

    // Drive the CLOUD message-persist path (daemon → relay → PG): the exact path a
    // forwarded agent channel post takes, so we can prove the relay-side mention
    // activity fan-out (emitAgentMentionActivity) writes the human's feed row.
    async function relayPersist(message: Record<string, unknown>): Promise<void> {
      await (
        relay as unknown as {
          persistMessage(wsId: string, seq: number, m: Record<string, unknown>): Promise<void>;
        }
      ).persistMessage(wsId, 1, message);
    }

    // Poll until a real-PG read goes EMPTY (delete mirror is async fire-and-forget).
    async function waitForGone(read: () => Promise<unknown>, label: string): Promise<void> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        if ((await read()) === undefined) return;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} to be gone`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    // Count 'mention' activity rows for a recipient against a given source message.
    async function pgMentionCount(userId: string, sourceId: string): Promise<number> {
      const out = await getPool().query<{ n: string }>(
        "SELECT count(*)::text AS n FROM activity_events WHERE user_id = $1 AND source_id = $2 AND event_type = 'mention'",
        [userId, sourceId],
      );
      return Number(out.rows[0].n);
    }

    // The persisted message's mentions[] (jsonb) — null when none.
    async function pgMessageMentions(id: string): Promise<string[] | null> {
      const out = await getPool().query<{ mentions: string[] | null }>(
        "SELECT mentions FROM messages WHERE id = $1",
        [id],
      );
      return out.rows[0]?.mentions ?? null;
    }

    // Whether a task is archived in real PG (archived_at IS NOT NULL); undefined if
    // the row is gone (so it composes with waitFor/waitForGone).
    async function pgTaskArchived(id: string): Promise<boolean | undefined> {
      const out = await getPool().query<{ archived: boolean }>(
        "SELECT (archived_at IS NOT NULL) AS archived FROM tasks WHERE id = $1",
        [id],
      );
      return out.rows[0]?.archived;
    }

    async function pgTaskStatus(id: string): Promise<string | undefined> {
      const out = await getPool().query<{ status: string }>(
        "SELECT status FROM tasks WHERE id = $1",
        [id],
      );
      return out.rows[0]?.status;
    }

    function textOf(res: unknown): string {
      const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
      return content.map((c) => c.text ?? "").join("\n");
    }

    function parseTaskId(text: string): string {
      const m = text.match(/Task created: (\S+)/);
      if (!m) throw new Error(`no task id in MCP result: ${text}`);
      return m[1];
    }

    // Call a cyborg7 tool through a REAL MCP client/server pair over the SDK's
    // in-memory transport (the same request handler /mcp/cyborg7 connects), for the
    // NON-cybo context. Used by the connected-daemon + schedule cases.
    async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
      const server = createCyborg7McpServer(nonCyboDeps, nonCyboCtx);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "pg-it", version: "1.0.0" });
      await client.connect(clientTransport);
      try {
        return textOf(await client.callTool({ name, arguments: args }));
      } finally {
        await client.close();
        await server.close();
      }
    }

    // Call a cyborg7 tool through a REAL MCP client/server pair, but with the CLOUD
    // deps wired: cyboWrite/cyboRead route to the relay's handleCyboWrite/Read (the
    // exact daemon → relay → PG path), so the cloud task-write tools are exercised
    // against real Postgres. Used by the cloud bulk-update cases.
    async function callCloudTool(name: string, args: Record<string, unknown>): Promise<string> {
      const cloudDeps: Cyborg7McpDeps = {
        ...nonCyboDeps,
        cyboWrite: async (req) => {
          const r = await relayWrite({ ...req });
          return { ok: r.ok, error: r.error, task: r.task };
        },
        cyboRead: async (req) => {
          const r = await relayRead({ ...req });
          return { ok: r.ok, error: r.error, tasks: r.tasks, members: r.members };
        },
      };
      const server = createCyborg7McpServer(cloudDeps, { ...nonCyboCtx });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "pg-it-cloud", version: "1.0.0" });
      await client.connect(clientTransport);
      try {
        return textOf(await client.callTool({ name, arguments: args }));
      } finally {
        await client.close();
        await server.close();
      }
    }

    // Stand up the cyborg7 MCP server over a REAL HTTP StreamableHTTP transport —
    // the same StreamableHTTPServerTransport + Express wiring bootstrap mounts at
    // /mcp/cyborg7. (We set the non-cybo ctx directly instead of resolving it from
    // an agent binding, but the transport, the request handler, and the tool are
    // the production ones.)
    async function startHttpMcp(): Promise<{ url: string; close: () => Promise<void> }> {
      const transports = new Map<string, InstanceType<typeof StreamableHTTPServerTransport>>();

      async function makeTransport(): Promise<InstanceType<typeof StreamableHTTPServerTransport>> {
        const server = createCyborg7McpServer(nonCyboDeps, { ...nonCyboCtx });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized(id: string) {
            transports.set(id, transport);
          },
          enableDnsRebindingProtection: false,
        });
        await server.connect(transport);
        return transport;
      }

      async function runReq(req: express.Request, res: express.Response): Promise<void> {
        const sessionId = req.header("mcp-session-id");
        let transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          if (req.method !== "POST" || !isInitializeRequest(req.body)) {
            res.status(400).json({
              jsonrpc: "2.0",
              error: { code: -32000, message: "init expected" },
              id: null,
            });
            return;
          }
          transport = await makeTransport();
        }
        await transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body,
        );
      }

      const handler: express.RequestHandler = (req, res) => {
        void runReq(req, res);
      };
      const app = express();
      app.use(express.json());
      app.post(MCP_ROUTE, handler);
      app.get(MCP_ROUTE, handler);
      app.delete(MCP_ROUTE, handler);

      const httpServer: Server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });
      const { port } = httpServer.address() as AddressInfo;
      return {
        url: `http://127.0.0.1:${port}${MCP_ROUTE}?workspaceId=${encodeURIComponent(wsId)}&agentId=${encodeURIComponent(agentUuid)}`,
        close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
      };
    }

    // ── seed: real PG (authoritative) + the SQLite cache (DualStorage reads) ──

    beforeAll(async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-pg-it-"));
      const sqlite = new CyborgStorage(path.join(tmpDir, "cache.db"));
      const pg = new PgSync(); // REAL PG (getPool reads DATABASE_URL)
      storage = new DualStorage(sqlite, pg); // connected daemon: SQLite + PG
      const workspaceManager = new WorkspaceManager(storage);
      relay = new WorkspaceRelay({ pg }); // the cloud relay, on the SAME PG

      // SQLite cache (so the connected-daemon DualStorage reads resolve locally) —
      // the cybo gets a generated id here that we reuse verbatim in PG below.
      sqlite.ensureUser(memberId);
      sqlite.ensureUser(viewerId);
      sqlite.createWorkspaceWithId(wsId, `PG IT ${runId}`, memberId);
      sqlite.addMember(wsId, memberId, "member");
      sqlite.addMember(wsId, viewerId, "viewer");
      const sqliteCybo = sqlite.createCybo({
        workspaceId: wsId,
        slug: "apex",
        name: "Apex",
        soul: "You are Apex.",
        provider: "claude",
        createdBy: memberId,
      });
      cyboId = sqliteCybo.id;

      // REAL PG seed (awaited + ordered, so FKs are satisfied and the relay/PG
      // reads in the cases below see a fully-provisioned workspace).
      await pg.upsertUser(memberId, `member-${runId}@pg-it.dev`, "Member");
      await pg.upsertUser(viewerId, `viewer-${runId}@pg-it.dev`, "Viewer");
      await pg.createWorkspace(wsId, `PG IT ${runId}`, memberId);
      await pg.addMember(wsId, memberId, "member"); // non-viewer member (the spawning user)
      await pg.addMember(wsId, viewerId, "viewer");
      await pg.createCybo({
        id: cyboId,
        workspaceId: wsId,
        slug: "apex",
        name: "Apex",
        soul: "You are Apex.",
        provider: "claude",
        createdBy: memberId,
      });

      // Feature 1/2 channels (PG owns channel_members). createChannel adds the
      // creator (memberId) as an admin channel member.
      await pg.createChannel(chId, wsId, "general", memberId);
      await pg.addCyboToChannel(chId, cyboId); // the cybo joins → may list/read here
      await pg.createChannel(chNoCybo, wsId, "no-cybo", memberId); // cybo NOT added
      await pg.createChannel(chEmpty, wsId, "empty", memberId);
      await pg.removeChannelMember(chEmpty, memberId); // truly empty roster

      // A foreign workspace + task for the cross-workspace IDOR cases. storage.createTask
      // (DualStorage) writes SQLite (the solo anchor reads) AND mirrors to PG (the relay
      // anchor reads), so the foreign task is genuinely cross-workspace in both stores.
      sqlite.ensureUser(otherMemberId);
      sqlite.createWorkspaceWithId(otherWsId, `Other ${runId}`, otherMemberId);
      sqlite.addMember(otherWsId, otherMemberId, "member");
      await pg.upsertUser(otherMemberId, `other-${runId}@pg-it.dev`, "Other");
      await pg.createWorkspace(otherWsId, `Other ${runId}`, otherMemberId);
      await pg.addMember(otherWsId, otherMemberId, "member");
      // Project-agnostic seed: a project-less channel routes the task to the
      // workspace Inbox, satisfying the require-project resolver.
      const foreign = storage.createTask({
        workspaceId: otherWsId,
        title: `foreign ${runId}`,
        createdBy: otherMemberId,
        channelId: "no-project-channel",
      });
      foreignTaskId = foreign.id;
      await waitFor(() => pgTaskById(foreignTaskId), "foreign task mirrored to PG");

      nonCyboDeps = {
        storage,
        messageRouter: {} as unknown as MessageRouter,
        workspaceManager,
        // No cyboWrite/cyboRead: the connected-daemon + HTTP cases exercise the
        // DualStorage write-through to PG, not the relay round-trip.
      };
      nonCyboCtx = {
        workspaceId: wsId,
        agentId: agentUuid,
        initiatedByUserId: memberId, // the spawning user; no cyboId (non-cybo agent)
        strictPermissions: false, // unrestricted, matching a real non-cybo agent
      };
    });

    afterAll(async () => {
      // Cascade-delete everything workspace-scoped (tasks/schedules/cybos/memberships/
      // projects/activity all reference workspaces ON DELETE CASCADE), then the users.
      await getPool().query("DELETE FROM workspaces WHERE id = ANY($1::text[])", [
        [wsId, otherWsId],
      ]);
      await getPool().query("DELETE FROM users WHERE id = ANY($1::text[])", [
        [memberId, viewerId, otherMemberId],
      ]);
      await storage.close(); // closes the SQLite handle AND the shared PG pool
      rmSync(tmpDir, { recursive: true, force: true });
      await closePool(); // no-op if already closed by storage.close()
    });

    // ── A. CLOUD relay path (daemon → relay → real PG) ───────────────

    it("A1+A2: non-cybo user-owned create THEN update land in PG (the fixed cloud path)", async () => {
      // A1 — create_task as a NON-cybo user-owned writer (createdBy = member, no cyboId).
      const createTitle = `A1 user task ${runId}`;
      const created = await relayWrite({
        kind: "create_task",
        createdBy: memberId,
        title: createTitle,
      });
      expect(created.ok).toBe(true);
      expect(created.task).toBeDefined();
      const taskId = created.task!.id;
      const afterCreate = await pgTaskById(taskId);
      expect(afterCreate).toBeDefined();
      expect(afterCreate!.created_by).toBe(memberId); // owned by the spawning user, in REAL PG
      expect(afterCreate!.title).toBe(createTitle);

      // A2 — update_task as the SAME user-owned writer. This is the path the fix
      // restored: the gate was cybo-only, so a non-cybo update skipped the relay and
      // errored "task not found"; now it routes through handleCyboWrite and persists.
      const updated = await relayWrite({
        kind: "update_task",
        createdBy: memberId,
        taskId,
        status: "done",
      });
      expect(updated.ok).toBe(true);
      const afterUpdate = await pgTaskById(taskId);
      expect(afterUpdate).toBeDefined();
      expect(afterUpdate!.status).toBe("done"); // the PG row actually moved
      expect(afterUpdate!.created_by).toBe(memberId); // ownership unchanged
    });

    it("A3: create_task attributed to a VIEWER is rejected by the membership gate (no row)", async () => {
      const title = `A3 viewer task ${runId}`;
      const res = await relayWrite({ kind: "create_task", createdBy: viewerId, title });
      expect(res.ok).toBe(false);
      expect(res.error ?? "").toMatch(/can't create tasks/i);
      expect(await pgTaskCountByTitle(title)).toBe(0); // nothing persisted
    });

    it("A4 (control): a cybo create still works and is attributed to the agent/cybo", async () => {
      const title = `A4 cybo task ${runId}`;
      const a4Agent = `agent_${randomUUID()}`;
      const res = await relayWrite({
        kind: "create_task",
        cyboId, // cybo path (no createdBy) — unchanged behavior
        agentId: a4Agent,
        title,
      });
      expect(res.ok).toBe(true);
      const row = await pgTaskById(res.task!.id);
      expect(row).toBeDefined();
      expect(row!.created_by).toBe(a4Agent); // the agent/cybo, NOT the member
      expect(row!.created_by).not.toBe(memberId);
    });

    // ── B. CONNECTED daemon path (DualStorage SQLite + real PG) ──────

    it("B: connected-daemon create_task (no relay) mirrors to PG owned by the member", async () => {
      const title = `B connected task ${runId}`;
      const text = await callTool("cyborg7_create_task", { title });
      expect(text).toContain("Task created");
      const id = parseTaskId(text);
      const row = await waitFor(() => pgTaskById(id), "B task mirrored to PG");
      expect(row.title).toBe(title);
      expect(row.created_by).toBe(memberId); // DualStorage mirrored created_by = member
    });

    // ── C. REAL MCP HTTP TRANSPORT (StreamableHTTP, as bootstrap mounts) ──

    it("C: cyborg7_create_task over a real MCP HTTP transport persists owned by the member", async () => {
      const http = await startHttpMcp();
      const transport = new StreamableHTTPClientTransport(new URL(http.url));
      const client = new Client({ name: "pg-it-http", version: "1.0.0" });
      try {
        await client.connect(transport);
        const title = `C http task ${runId}`;
        const text = textOf(
          await client.callTool({ name: "cyborg7_create_task", arguments: { title } }),
        );
        expect(text).toContain("Task created");
        const id = parseTaskId(text);
        const row = await waitFor(() => pgTaskById(id), "C task mirrored to PG");
        expect(row.title).toBe(title);
        expect(row.created_by).toBe(memberId);
      } finally {
        await client.close();
        await http.close();
      }
    });

    // ── D. SCHEDULE (created_by = member in PG; runner authorizes the member) ──

    it("D: schedule_create is owned by the member in PG and passes isCreatorStillAuthorized", async () => {
      const prompt = `D summarize ${runId}`;
      const text = await callTool("cyborg7_schedule_create", {
        cybo: "apex",
        cron: "0 9 * * *",
        prompt,
      });
      expect(text).toContain("Schedule created");

      const schedule = storage
        .listSchedules(wsId)
        .find((s) => s.prompt === prompt) as StoredSchedule;
      expect(schedule).toBeDefined();
      expect(schedule.created_by).toBe(memberId);

      // Real PG mirror carries the member as created_by.
      const pgRow = await waitFor(() => pgScheduleById(schedule.id), "D schedule mirrored to PG");
      expect(pgRow.created_by).toBe(memberId);

      // A REAL ScheduleRunner authorization check (no serverId → membership gate,
      // which reads SQLite). The member is a live member → authorized; the same
      // schedule re-attributed to a random agent UUID is NOT a member → deauthorized
      // (the exact "schedule never fires" bug the spawning-user attribution avoids).
      const stub = () => {};
      const runner = new ScheduleRunner({
        storage,
        agentManager: { runAgent: async () => ({}) } as unknown as AgentManager,
        logger: { warn: stub, info: stub, error: stub, debug: stub } as unknown as Logger,
      });
      const isAuthorized = (
        runner as unknown as {
          isCreatorStillAuthorized: (s: StoredSchedule) => Promise<boolean>;
        }
      ).isCreatorStillAuthorized.bind(runner);

      await expect(isAuthorized(schedule)).resolves.toBe(true);
      await expect(isAuthorized({ ...schedule, created_by: randomUUID() })).resolves.toBe(false);
    });

    // ── E. Feature 1: agent → HUMAN mention (notify) ─────────────────

    it("E1 (solo): handleAgentMessage mentions persist humans-only + emit a 'mention'; cybo/unknown dropped, never invoked", async () => {
      const captured: { toWorkspace: unknown[]; toUser: { uid: string; m: unknown }[] } = {
        toWorkspace: [],
        toUser: [],
      };
      const broadcast = {
        toWorkspace: (_wid: string, m: unknown) => captured.toWorkspace.push(m),
        toUser: (uid: string, m: unknown) => captured.toUser.push({ uid, m }),
      };
      const router = new MessageRouter(storage, nonCyboDeps.workspaceManager, broadcast);
      // mentions: a human member, the cybo (MUST be dropped — never notify-as-invoke),
      // and an unknown id (ignored gracefully).
      router.handleAgentMessage(agentUuid, wsId, chId, null, `solo ping ${runId}`, [
        memberId,
        cyboId,
        `u_unknown_${randomUUID()}`,
      ]);

      // The live broadcast carries the resolved HUMAN-only mentions.
      const payload = (captured.toWorkspace[0] as { payload: { id: string; mentions: string[] } })
        .payload;
      expect(payload.mentions).toEqual([memberId]);
      const msgId = payload.id;

      // Persisted message row (PG mirror) carries the same humans-only mentions.
      const mentions = await waitFor(
        async () => (await pgMessageMentions(msgId)) ?? undefined,
        "E1 message mentions mirrored",
      );
      expect(mentions).toEqual([memberId]);

      // The human got a 'mention' activity row; the cybo did NOT.
      await waitFor(
        async () => ((await pgMentionCount(memberId, msgId)) > 0 ? true : undefined),
        "E1 human mention activity",
      );
      expect(await pgMentionCount(cyboId, msgId)).toBe(0);
      // A live activity_new push went to the human (badge increment).
      expect(captured.toUser.some((e) => e.uid === memberId)).toBe(true);
    });

    it("E2 (cloud): a relayed agent channel post fans out a 'mention' to the human; cybo/unknown get none", async () => {
      const msgId = `msg_${randomUUID()}`;
      const unknownId = `u_unknown_${randomUUID()}`;
      await relayPersist({
        type: "cyborg:channel_message_broadcast",
        payload: {
          id: msgId,
          workspaceId: wsId,
          channelId: chId,
          fromId: cyboId,
          fromType: "agent",
          fromName: "Apex",
          text: `cloud ping ${runId}`,
          mentions: [memberId, cyboId, unknownId],
          createdAt: Date.now(),
        },
      });
      // FIX 2 (defense in depth): the relay re-filters the STORED mentions to the
      // channel's HUMAN members, so the cybo id and the unknown id are dropped from
      // the persisted array even though the inbound frame carried them — matching the
      // daemon-prefiltered humans-only invariant. The ACTIVITY fan-out is humans-only.
      expect(await pgMessageMentions(msgId)).toEqual([memberId]);
      expect(await pgMentionCount(memberId, msgId)).toBe(1);
      // A cybo channel member and an unknown id are NOT notified — an agent mention
      // never notifies-as-invokes a cybo.
      expect(await pgMentionCount(cyboId, msgId)).toBe(0);
      expect(await pgMentionCount(unknownId, msgId)).toBe(0);
    });

    it("E3 (connected daemon + relay on the SAME PG): an agent @mention writes ONE 'mention' row, not two", async () => {
      // The real connected-daemon topology: handleAgentMessage runs on the
      // DualStorage (SQLite + THIS PG) — it persists the message AND fans out the
      // human's 'mention' activity to PG — and the SAME post is also broadcast to
      // the relay (which shares this PG) where emitAgentMentionActivity fans out its
      // cloud mirror. Both writers must collapse to a SINGLE activity row, or the
      // mentioned human double-badges/double-notifies for one agent post.
      const captured: { toWorkspace: unknown[] } = { toWorkspace: [] };
      const broadcast = {
        toWorkspace: (_wid: string, m: unknown) => captured.toWorkspace.push(m),
        toUser: () => {},
      };
      const router = new MessageRouter(storage, nonCyboDeps.workspaceManager, broadcast);
      router.handleAgentMessage(agentUuid, wsId, chId, null, `dual ping ${runId}`, [memberId]);

      const payload = (captured.toWorkspace[0] as { payload: { id: string; mentions: string[] } })
        .payload;
      expect(payload.mentions).toEqual([memberId]);
      const msgId = payload.id;

      // The daemon's PG mirror lands exactly one row.
      await waitFor(
        async () => ((await pgMentionCount(memberId, msgId)) > 0 ? true : undefined),
        "E3 daemon mention activity",
      );
      expect(await pgMentionCount(memberId, msgId)).toBe(1);

      // Now the relay receives that broadcast and runs its cloud-mirror fan-out. The
      // deterministic activity id makes its write a no-op upsert — NOT a second row.
      await relayPersist(captured.toWorkspace[0] as Record<string, unknown>);
      expect(await pgMentionCount(memberId, msgId)).toBe(1);
    });

    // ── F. Feature 2: cyborg7_list_channel_members ───────────────────

    it("F1 (cloud): relay 'members' returns humans + cybos with names + memberType", async () => {
      const res = await relayRead({ cyboId, kind: "members", channelId: chId });
      expect(res.ok).toBe(true);
      const members = res.members ?? [];
      expect(members.find((m) => m.id === memberId)).toMatchObject({
        memberType: "user",
        name: "Member",
      });
      expect(members.find((m) => m.id === cyboId)).toMatchObject({
        memberType: "cybo",
        name: "Apex",
      });
    });

    it("F2 (cloud): the membership gate rejects a channel the cybo has NOT joined", async () => {
      const res = await relayRead({ cyboId, kind: "members", channelId: chNoCybo });
      expect(res.ok).toBe(false);
      expect(res.error ?? "").toMatch(/not a member/i);
      expect(res.members).toBeUndefined();
    });

    it("F3 (PG-direct): an empty channel returns no members", async () => {
      const text = await callTool("cyborg7_list_channel_members", { channel: chEmpty });
      expect(text).toBe("(no members)");
    });

    it("F4 (PG-direct): the tool unions humans + cybos for a populated channel", async () => {
      const text = await callTool("cyborg7_list_channel_members", { channel: chId });
      expect(text).toContain("[user]");
      expect(text).toContain(memberId);
      expect(text).toContain("[cybo]");
      expect(text).toContain("Apex");
    });

    it("F5 (solo, SQLite-only): falls back to the workspace roster (humans + cybos)", async () => {
      const soloDir = mkdtempSync(path.join(tmpdir(), "cyborg7-solo-"));
      const soloSqlite = new CyborgStorage(path.join(soloDir, "solo.db"));
      const soloUser = `u_solo_${randomUUID()}`;
      const soloWs = `ws_solo_${randomUUID()}`;
      soloSqlite.ensureUser(soloUser);
      soloSqlite.createWorkspaceWithId(soloWs, "Solo", soloUser);
      soloSqlite.addMember(soloWs, soloUser, "member");
      soloSqlite.createCybo({
        workspaceId: soloWs,
        slug: "nova",
        name: "Nova",
        soul: "You are Nova.",
        provider: "claude",
        createdBy: soloUser,
      });
      const soloChannel = soloSqlite.createChannel(soloWs, "general", soloUser);
      const soloStorage = new DualStorage(soloSqlite, null);
      const soloDeps: Cyborg7McpDeps = {
        storage: soloStorage,
        messageRouter: {} as unknown as MessageRouter,
        workspaceManager: new WorkspaceManager(soloStorage),
      };
      const soloCtx: Cyborg7McpContext = { workspaceId: soloWs, agentId: randomUUID() };
      const server = createCyborg7McpServer(soloDeps, soloCtx);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      const client = new Client({ name: "solo", version: "1.0.0" });
      await client.connect(ct);
      try {
        const out = textOf(
          await client.callTool({
            name: "cyborg7_list_channel_members",
            arguments: { channel: soloChannel.id },
          }),
        );
        expect(out).toContain("[user]");
        expect(out).toContain(soloUser);
        expect(out).toContain("[cybo]");
        expect(out).toContain("Nova");
      } finally {
        await client.close();
        await server.close();
        await soloStorage.close();
        rmSync(soloDir, { recursive: true, force: true });
      }
    });

    // ── R. get_workspace_roster fix: relay-aware workspace roster ─────
    // The old tool read the daemon's LOCAL SQLite (owner + the cybo only) on a
    // cloud daemon, so a cybo saw a fraction of the real members. These prove the
    // relay/PG path now returns the FULL workspace roster.

    it("R1 (cloud): relay 'roster' returns ALL workspace members + cybos, not just the owner", async () => {
      const res = await relayRead({ cyboId, kind: "roster" });
      expect(res.ok).toBe(true);
      const members = res.members ?? [];
      expect(members.find((m) => m.id === memberId)).toMatchObject({ memberType: "user" });
      expect(members.find((m) => m.id === viewerId)).toMatchObject({ memberType: "user" });
      expect(members.find((m) => m.id === cyboId)).toMatchObject({
        memberType: "cybo",
        name: "Apex",
      });
    });

    it("R2 (PG-direct): the get_workspace_roster tool surfaces every member + the cybo", async () => {
      const text = await callTool("cyborg7_get_workspace_roster", {});
      const humanLines = text.split("\n").filter((l) => l.startsWith("[human]"));
      expect(humanLines.length).toBeGreaterThanOrEqual(2); // member + viewer, not just one
      expect(text).toContain("Member");
      expect(text).toContain("[agent] Apex");
    });

    // ── G. Feature 3: archive / delete / bulk-update task ops ─────────

    async function listToolNames(platformPermissions: string[]): Promise<string[]> {
      const server = createCyborg7McpServer(nonCyboDeps, {
        ...nonCyboCtx,
        cyboId,
        platformPermissions,
      });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      const client = new Client({ name: "names", version: "1.0.0" });
      await client.connect(ct);
      try {
        const { tools } = await client.listTools();
        return tools.map((t) => t.name);
      } finally {
        await client.close();
        await server.close();
      }
    }

    it("G1 (cloud): archive then restore a task via the relay update_task+archivedAt path", async () => {
      const created = await relayWrite({
        kind: "create_task",
        createdBy: memberId,
        title: `G1 ${runId}`,
      });
      const taskId = created.task!.id;
      const arch = await relayWrite({
        kind: "update_task",
        createdBy: memberId,
        taskId,
        archivedAt: Date.now(),
      });
      expect(arch.ok).toBe(true);
      expect(await pgTaskArchived(taskId)).toBe(true);
      const rest = await relayWrite({
        kind: "update_task",
        createdBy: memberId,
        taskId,
        archivedAt: null,
      });
      expect(rest.ok).toBe(true);
      expect(await pgTaskArchived(taskId)).toBe(false);
    });

    it("G2 (cloud): delete a task via the relay delete_task kind", async () => {
      const created = await relayWrite({
        kind: "create_task",
        createdBy: memberId,
        title: `G2 ${runId}`,
      });
      const taskId = created.task!.id;
      expect(await pgTaskById(taskId)).toBeDefined();
      const del = await relayWrite({ kind: "delete_task", createdBy: memberId, taskId });
      expect(del.ok).toBe(true);
      expect(await pgTaskById(taskId)).toBeUndefined();
    });

    it("G3 (cloud): delete_task rejects a cross-workspace task id (IDOR)", async () => {
      const res = await relayWrite({
        kind: "delete_task",
        createdBy: memberId,
        taskId: foreignTaskId,
      });
      expect(res.ok).toBe(false);
      expect(res.error ?? "").toMatch(/not found in this workspace/i);
      expect(await pgTaskById(foreignTaskId)).toBeDefined(); // untouched
    });

    it("G4 (cloud): a VIEWER cannot delete (membership gate)", async () => {
      const created = await relayWrite({
        kind: "create_task",
        createdBy: memberId,
        title: `G4 ${runId}`,
      });
      const taskId = created.task!.id;
      const res = await relayWrite({ kind: "delete_task", createdBy: viewerId, taskId });
      expect(res.ok).toBe(false);
      expect(await pgTaskById(taskId)).toBeDefined(); // not deleted
    });

    it("G5 (solo): cyborg7_archive_task archives via DualStorage (PG mirror reflects it)", async () => {
      const t = storage.createTask({
        workspaceId: wsId,
        title: `G5 ${runId}`,
        createdBy: memberId,
        channelId: "no-project-channel",
      });
      await waitFor(() => pgTaskById(t.id), "G5 task mirrored");
      const text = await callTool("cyborg7_archive_task", { taskId: t.id });
      expect(text).toMatch(/archived/i);
      await waitFor(
        async () => ((await pgTaskArchived(t.id)) === true ? true : undefined),
        "G5 archived in PG",
      );
    });

    it("G6 (solo): cyborg7_delete_task removes the task (PG mirror reflects it)", async () => {
      const t = storage.createTask({
        workspaceId: wsId,
        title: `G6 ${runId}`,
        createdBy: memberId,
        channelId: "no-project-channel",
      });
      await waitFor(() => pgTaskById(t.id), "G6 task mirrored");
      const text = await callTool("cyborg7_delete_task", { taskId: t.id });
      expect(text).toMatch(/deleted/i);
      await waitForGone(() => pgTaskById(t.id), "G6 task deleted from PG");
    });

    it("G7 (solo): cyborg7_bulk_update_tasks applies the patch to all ids (PG mirror reflects it)", async () => {
      const t1 = storage.createTask({
        workspaceId: wsId,
        title: `G7a ${runId}`,
        createdBy: memberId,
        channelId: "no-project-channel",
      });
      const t2 = storage.createTask({
        workspaceId: wsId,
        title: `G7b ${runId}`,
        createdBy: memberId,
        channelId: "no-project-channel",
      });
      await waitFor(() => pgTaskById(t1.id), "G7a mirrored");
      await waitFor(() => pgTaskById(t2.id), "G7b mirrored");
      const text = await callTool("cyborg7_bulk_update_tasks", {
        taskIds: [t1.id, t2.id],
        status: "done",
      });
      expect(text).toContain("2/2");
      await waitFor(
        async () => ((await pgTaskStatus(t1.id)) === "done" ? true : undefined),
        "G7a done in PG",
      );
      await waitFor(
        async () => ((await pgTaskStatus(t2.id)) === "done" ? true : undefined),
        "G7b done in PG",
      );
    });

    it("G8 (solo): every task op rejects a cross-workspace task id (IDOR)", async () => {
      expect(await callTool("cyborg7_archive_task", { taskId: foreignTaskId })).toMatch(
        /not found in this workspace/i,
      );
      expect(await callTool("cyborg7_delete_task", { taskId: foreignTaskId })).toMatch(
        /not found in this workspace/i,
      );
      expect(
        await callTool("cyborg7_bulk_update_tasks", { taskIds: [foreignTaskId], status: "done" }),
      ).toMatch(/not found in this workspace/i);
      // The foreign task is untouched in the local store.
      expect(storage.getTaskById(foreignTaskId)).toBeDefined();
    });

    it("G10 (cloud): bulk_update with a MIX of valid + cross-workspace ids rejects the WHOLE op (atomic, like solo)", async () => {
      const created = await relayWrite({
        kind: "create_task",
        createdBy: memberId,
        title: `G10 ${runId}`,
      });
      const validId = created.task!.id;
      const before = await pgTaskStatus(validId);
      expect(before).not.toBe("done"); // so the assertion below is meaningful
      const text = await callCloudTool("cyborg7_bulk_update_tasks", {
        taskIds: [validId, foreignTaskId],
        status: "done",
      });
      expect(text).toMatch(/not found in this workspace/i);
      // Atomic: the valid task was NOT moved and the foreign task is untouched —
      // matching the solo path's all-or-nothing contract (no per-id divergence).
      expect(await pgTaskStatus(validId)).toBe(before);
      expect(await pgTaskById(foreignTaskId)).toBeDefined();
    });

    it("G11 (cloud): bulk_update with ALL valid ids applies the patch to every id", async () => {
      const a = await relayWrite({
        kind: "create_task",
        createdBy: memberId,
        title: `G11a ${runId}`,
      });
      const b = await relayWrite({
        kind: "create_task",
        createdBy: memberId,
        title: `G11b ${runId}`,
      });
      const text = await callCloudTool("cyborg7_bulk_update_tasks", {
        taskIds: [a.task!.id, b.task!.id],
        status: "done",
      });
      expect(text).toContain("2/2");
      expect(await pgTaskStatus(a.task!.id)).toBe("done");
      expect(await pgTaskStatus(b.task!.id)).toBe("done");
    });

    it("G12 (cloud): a cybo create/update/delete fans out cyborg:tasks_changed to workspace guests (live board)", async () => {
      // FIX 4: the cybo write path must fan out the SAME cyborg:tasks_changed broadcast
      // the human path does — through the onBroadcast → broadcastToGuests seam — or an
      // agent- or watcher-filed task only appears on the next refetch/reconnect, never
      // live on an open board. Capture that seam with an onBroadcast spy relay (sharing
      // this run's PG via a fresh PgSync over the same pool).
      const events: { op: string; taskId: string | undefined }[] = [];
      const spyRelay = new WorkspaceRelay({
        pg: new PgSync(),
        onBroadcast: (_wid, message) => {
          const m = message as {
            type?: string;
            payload?: { op?: string; task?: { id?: string } };
          };
          if (m.type === "cyborg:tasks_changed") {
            events.push({ op: m.payload?.op ?? "", taskId: m.payload?.task?.id });
          }
        },
      });
      const writeViaSpy = async (
        partial: Partial<CyboWriteRequest> & Pick<CyboWriteRequest, "kind">,
      ): Promise<CyboWriteResponse> => {
        const replies: CyboWriteResponse[] = [];
        const fakeWs = {
          readyState: 1,
          send: (raw: string) => replies.push(JSON.parse(raw) as CyboWriteResponse),
        };
        await (
          spyRelay as unknown as {
            handleCyboWrite(ws: unknown, m: CyboWriteRequest): Promise<void>;
          }
        ).handleCyboWrite(fakeWs, {
          type: "cybo_write_request",
          requestId: randomUUID(),
          workspaceId: wsId,
          ...partial,
        } as CyboWriteRequest);
        expect(replies).toHaveLength(1);
        return replies[0];
      };

      const created = await writeViaSpy({
        kind: "create_task",
        createdBy: memberId,
        title: `G12 ${runId}`,
      });
      expect(created.ok).toBe(true);
      const taskId = created.task!.id;
      const updated = await writeViaSpy({
        kind: "update_task",
        createdBy: memberId,
        taskId,
        status: "done",
      });
      expect(updated.ok).toBe(true);
      const deleted = await writeViaSpy({ kind: "delete_task", createdBy: memberId, taskId });
      expect(deleted.ok).toBe(true);

      // One tasks_changed per op, in order, each carrying this task's id.
      const ops = events.filter((e) => e.taskId === taskId).map((e) => e.op);
      expect(ops).toEqual(["created", "updated", "deleted"]);
    });

    it("G9: the task ops are gated on create_task; the members read tool is always exposed", async () => {
      const sendOnly = await listToolNames(["send_message"]);
      expect(sendOnly).not.toContain("cyborg7_archive_task");
      expect(sendOnly).not.toContain("cyborg7_delete_task");
      expect(sendOnly).not.toContain("cyborg7_bulk_update_tasks");
      expect(sendOnly).toContain("cyborg7_list_channel_members"); // read tool — always on
      const granted = await listToolNames(["create_task"]);
      expect(granted).toContain("cyborg7_archive_task");
      expect(granted).toContain("cyborg7_delete_task");
      expect(granted).toContain("cyborg7_bulk_update_tasks");
    });

    // ── H. SECURITY: cybo task READS inherit the OWNER's project ACL ──
    //
    // A cybo must see only what its OWNER (cybos.created_by) can see — never more.
    // The cybo read used to call getTasks WITHOUT a userId, so taskVisibilityCondition
    // was bypassed and a cybo saw EVERY workspace task, including project-restricted
    // ones its owner couldn't see. The fix scopes the read to the owner. This drives
    // the exact daemon → relay → PG read path (relayRead → handleCyboRead) against
    // real PG, with a project restricted to a private channel.
    it("H: a cybo's tasks read is scoped to its owner's project visibility", async () => {
      const db = (relay as unknown as { pg: PgSync }).pg;

      // Two NON-admin workspace members. `insider` is a member of the private channel
      // tagged to the secret project (so that project — and tasks in it — are visible);
      // `outsider` is not, so the project is invisible to it.
      const insiderId = `u_insider_${randomUUID()}`;
      const outsiderId = `u_outsider_${randomUUID()}`;
      await db.upsertUser(insiderId, `insider-${runId}@pg-it.dev`, "Insider");
      await db.upsertUser(outsiderId, `outsider-${runId}@pg-it.dev`, "Outsider");
      await db.addMember(wsId, insiderId, "member"); // plain member — not owner/admin
      await db.addMember(wsId, outsiderId, "member"); // plain member — not owner/admin

      // A private channel tagged to a chat project → a restricted tasks_project. The
      // workspace owner (memberId, the channel creator) steps out so the only human who
      // can see it is the insider channel member. We pass the tasks_project id to
      // create_task to land the task directly inside it.
      const privCh = `ch_priv_${randomUUID()}`;
      const chatProjId = `proj_${randomUUID()}`;
      await db.createChannel(privCh, wsId, `priv-${runId}`, memberId);
      await db.removeChannelMember(privCh, memberId); // owner steps out — truly private
      await db.addChannelMember(privCh, insiderId, "member"); // insider is the only member
      await db.createProject(chatProjId, wsId, `Secret ${runId}`, "#abc");
      await db.setChannelProject(privCh, chatProjId);
      const tasksProjId = await db.provisionTasksProject(wsId, chatProjId, `Secret ${runId}`);

      // The restricted task, filed into the private project.
      const restrictedTaskId = `task_${randomUUID()}`;
      await db.createTask({
        id: restrictedTaskId,
        workspaceId: wsId,
        title: `H restricted ${runId}`,
        createdBy: insiderId,
        projectId: tasksProjId,
      });

      // Two cybos: one owned by the insider (can see the project), one owned by the
      // outsider (cannot). Both live in the same workspace.
      const insiderCybo = `cybo_ins_${randomUUID()}`;
      const outsiderCybo = `cybo_out_${randomUUID()}`;
      await db.createCybo({
        id: insiderCybo,
        workspaceId: wsId,
        slug: `ins-${runId}`,
        name: "InsiderBot",
        soul: "x",
        provider: "claude",
        createdBy: insiderId,
      });
      await db.createCybo({
        id: outsiderCybo,
        workspaceId: wsId,
        slug: `out-${runId}`,
        name: "OutsiderBot",
        soul: "x",
        provider: "claude",
        createdBy: outsiderId,
      });

      // The OUTSIDER's cybo must NOT receive the restricted task (its owner can't see
      // the project) — the leak the fix closes.
      const outRes = await relayRead({ kind: "tasks", cyboId: outsiderCybo });
      expect(outRes.ok).toBe(true);
      const outIds = (outRes.tasks ?? []).map((t) => t.id);
      expect(outIds).not.toContain(restrictedTaskId);

      // The INSIDER's cybo DOES receive it (its owner is a member of the private
      // channel tagged to the project) — proving the gate scopes, not blanket-denies.
      const inRes = await relayRead({ kind: "tasks", cyboId: insiderCybo });
      expect(inRes.ok).toBe(true);
      const inIds = (inRes.tasks ?? []).map((t) => t.id);
      expect(inIds).toContain(restrictedTaskId);

      // Defense in depth: once the owner is REMOVED from the workspace, the cybo's
      // task read is denied outright — a cybo must not outlive its owner's access.
      await db.removeMember(wsId, insiderId);
      const afterRemoval = await relayRead({ kind: "tasks", cyboId: insiderCybo });
      expect(afterRemoval.ok).toBe(false);
      expect(afterRemoval.error ?? "").toMatch(/no longer a member/i);
    });
  },
);
