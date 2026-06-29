import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Logger } from "pino";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { createCyborg7McpServer, type Cyborg7McpDeps } from "./cyborg7-mcp-tools.js";
import { ScheduleRunner } from "./schedule-runner.js";
import type { StoredSchedule } from "./storage.js";
import type { AgentManager } from "../agent/agent-manager.js";

// E2E: a PLAIN (non-cybo) agent drives the real cyborg7 MCP server against a real
// (solo SQLite) DualStorage — the same server bootstrap mounts at /mcp/cyborg7.
// We assert the end-to-end contract this feature ships:
//   1. a non-cybo agent CAN call cyborg7_create_task + cyborg7_schedule_create,
//   2. the created task/schedule is owned by the SPAWNING USER (the binding's
//      initiated_by), not the ephemeral agent UUID and not the cybo's owner, and
//   3. the schedule is NOT deauthorized — ScheduleRunner.isCreatorStillAuthorized
//      passes for the user-owned schedule, and would FAIL for an agent-UUID owner
//      (the exact bug this attribution avoids).
//
// A full provider-driven spawn is out of proportion for this invariant, so per the
// task we drive the MCP server directly with a non-cybo context (initiatedByUserId
// set, no cyboId) against the real storage layer.
describe("E2E: non-cybo agent task/schedule ownership (spawning user)", () => {
  let tmpDir: string;
  let dbPath: string;
  let storage: DualStorage;
  let workspaceManager: WorkspaceManager;
  let workspaceId: string;
  let ownerUserId: string; // the cybo's owner (a member)
  let spawnerUserId: string; // the non-cybo agent's spawning user (a different member)
  const agentUuid = randomUUID(); // the ephemeral agent — NOT a workspace member

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-agent-tools-"));
    dbPath = path.join(tmpDir, "test.db");
    storage = new DualStorage(new CyborgStorage(dbPath), null); // solo: local SQLite only
    workspaceManager = new WorkspaceManager(storage);

    const owner = storage.upsertUser("owner@example.com", "Owner");
    ownerUserId = owner.id;
    const ws = storage.createWorkspace("Test WS", ownerUserId); // owner is a member
    workspaceId = ws.id;

    const spawner = storage.upsertUser("spawner@example.com", "Spawner");
    spawnerUserId = spawner.id;
    storage.addMember(workspaceId, spawnerUserId, "member"); // a live, write-capable member

    // A cybo for cyborg7_schedule_create to target — owned by a DIFFERENT user than
    // the spawning user, so we can prove the schedule is attributed to the spawner
    // (not the cybo's owner).
    storage.createCybo({
      workspaceId,
      slug: "apex",
      name: "Apex",
      soul: "You are Apex.",
      provider: "claude",
      createdBy: ownerUserId,
    });
  });

  afterEach(() => {
    storage.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = `${dbPath}${suffix}`;
      if (existsSync(f)) unlinkSync(f);
    }
  });

  // Connect a fresh MCP client to a cyborg7 server built for a NON-cybo agent
  // (initiatedByUserId = the spawning user, no cyboId). Solo deps: no cyboRead/
  // cyboWrite, so reads/writes hit the local DualStorage directly.
  async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const deps = {
      storage,
      messageRouter: {},
      workspaceManager,
    } as unknown as Cyborg7McpDeps;
    const server = createCyborg7McpServer(deps, {
      workspaceId,
      agentId: agentUuid,
      initiatedByUserId: spawnerUserId,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      return await run(client);
    } finally {
      await client.close();
      await server.close();
    }
  }

  function callText(res: unknown): string {
    return (res as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");
  }

  it("exposes the task + schedule tools to the non-cybo agent", async () => {
    const { tools } = await withClient((client) => client.listTools());
    const names = tools.map((t) => t.name);
    expect(names).toContain("cyborg7_create_task");
    expect(names).toContain("cyborg7_schedule_create");
  });

  it("cyborg7_create_task: the persisted task is owned by the spawning user", async () => {
    const text = await withClient((client) =>
      client
        .callTool({ name: "cyborg7_create_task", arguments: { title: "Plain agent task" } })
        .then(callText),
    );
    expect(text).toContain("Task created");

    const tasks = storage.getTasks(workspaceId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Plain agent task");
    // The spawning user owns it — NOT the ephemeral agent UUID.
    expect(tasks[0].created_by).toBe(spawnerUserId);
    expect(tasks[0].created_by).not.toBe(agentUuid);
  });

  it("cyborg7_schedule_create: schedule is owned by the spawning user (not the cybo owner / agent)", async () => {
    const text = await withClient((client) =>
      client
        .callTool({
          name: "cyborg7_schedule_create",
          arguments: { cybo: "apex", cron: "0 9 * * *", prompt: "summarize the channel" },
        })
        .then(callText),
    );
    expect(text).toContain("Schedule created");

    const schedules = storage.listSchedules(workspaceId);
    expect(schedules).toHaveLength(1);
    const schedule = schedules[0];
    expect(schedule.created_by).toBe(spawnerUserId);
    expect(schedule.created_by).not.toBe(ownerUserId); // not the cybo's owner
    expect(schedule.created_by).not.toBe(agentUuid); // not the ephemeral agent
  });

  it("the spawning-user-owned schedule is NOT deauthorized (isCreatorStillAuthorized passes)", async () => {
    await withClient((client) =>
      client.callTool({
        name: "cyborg7_schedule_create",
        arguments: { cybo: "apex", cron: "0 9 * * *", prompt: "summarize the channel" },
      }),
    );
    const schedule = storage.listSchedules(workspaceId)[0];

    const runner = new ScheduleRunner({
      storage,
      agentManager: { runAgent: async () => ({}) } as unknown as AgentManager,
      logger: { warn() {}, info() {}, error() {} } as unknown as Logger,
      serverId: "daemon_test",
    });
    // isCreatorStillAuthorized is private; it gates whether the runner will fire a
    // schedule. In solo mode it returns Boolean(getMembership(ws, created_by)).
    const isAuthorized = (
      runner as unknown as {
        isCreatorStillAuthorized: (s: StoredSchedule) => Promise<boolean>;
      }
    ).isCreatorStillAuthorized.bind(runner);

    // The user-owned schedule passes — it WILL fire.
    await expect(isAuthorized(schedule)).resolves.toBe(true);
    // The same schedule attributed to the ephemeral agent UUID (the OLD behavior)
    // is deauthorized — the agent is not a workspace member, so it never fires.
    await expect(isAuthorized({ ...schedule, created_by: agentUuid })).resolves.toBe(false);
  });
});
