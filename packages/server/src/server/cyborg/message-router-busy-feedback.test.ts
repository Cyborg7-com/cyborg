/* eslint-disable @typescript-eslint/no-explicit-any */
// Regression: a prompt routed to an agent whose run is already active used to be
// dropped SILENTLY — streamAgent throws "already has an active run" synchronously,
// before any turn exists, so AgentManager never dispatches turn_failed and the
// old catch block only logged. The user's message was persisted in the chat but
// the agent never answered and no error reached the client (observed live with a
// zombie turn on a remote daemon after a daemon restart).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MessageRouter, type BroadcastFn } from "./message-router.js";

describe("MessageRouter — busy agent prompt feedback", () => {
  let storage: DualStorage;
  let workspaceManager: WorkspaceManager;
  let router: MessageRouter;
  let broadcasted: any[];
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-busy-"));
    storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "test.db")), null);
    workspaceManager = new WorkspaceManager(storage);
    broadcasted = [];
    const broadcast: BroadcastFn = {
      toWorkspace(_workspaceId: string, msg: unknown) {
        broadcasted.push(msg);
      },
      toUser(_userId: string, msg: unknown) {
        broadcasted.push(msg);
      },
    };
    router = new MessageRouter(storage, workspaceManager, broadcast);
  });

  afterEach(() => {
    storage.close();
    const dbPath = path.join(tmpDir, "test.db");
    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(`${dbPath}-wal`)) unlinkSync(`${dbPath}-wal`);
    if (existsSync(`${dbPath}-shm`)) unlinkSync(`${dbPath}-shm`);
  });

  function setupAgent(streamAgentImpl: () => AsyncGenerator<unknown>): string {
    const agentId = "agent-busy-1";
    const owner = storage.upsertUser("owner@test.dev", "Owner");
    const workspace = storage.createWorkspace("Busy Test", owner.id);
    storage.createAgentBinding({
      agentId,
      workspaceId: workspace.id,
      provider: "claude",
      initiatedBy: null,
    });
    const fakeAgentManager = {
      subscribe: () => () => {},
      getAgent: () => ({ id: agentId, provider: "claude" }),
      appendTimelineItem: async () => {},
      streamAgent: streamAgentImpl,
    };
    router.setAgentManager(fakeAgentManager as any);
    return agentId;
  }

  it("broadcasts turn_failed when streamAgent rejects synchronously with an active run", async () => {
    const agentId = setupAgent(() => {
      throw new Error(`Agent ${agentId} already has an active run`);
    });

    await router.routeToAgent(agentId, "hola", { rawPrompt: "hola" });

    const failures = broadcasted.filter(
      (b) => b.type === "cyborg:agent_stream" && b.payload?.event?.type === "turn_failed",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].payload.agentId).toBe(agentId);
    expect(failures[0].payload.event.error).toContain("busy with another run");
  });

  it("broadcasts the raw error for other synchronous stream rejections", async () => {
    const agentId = setupAgent(() => {
      throw new Error("provider exploded before turn start");
    });

    await router.routeToAgent(agentId, "hola");

    const failures = broadcasted.filter(
      (b) => b.type === "cyborg:agent_stream" && b.payload?.event?.type === "turn_failed",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].payload.event.error).toBe("provider exploded before turn start");
  });

  it("does not broadcast a duplicate turn_failed when the stream itself fails mid-turn", async () => {
    // Async (mid-turn) failures are dispatched by AgentManager's subscriber
    // system — the router must stay silent to avoid duplicate error events.
    const agentId = setupAgent(async function* () {
      yield { type: "turn_started" };
      throw new Error("mid-turn failure");
    });

    await router.routeToAgent(agentId, "hola");

    const failures = broadcasted.filter(
      (b) => b.type === "cyborg:agent_stream" && b.payload?.event?.type === "turn_failed",
    );
    expect(failures).toHaveLength(0);
  });
});
