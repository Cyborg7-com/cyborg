/* eslint-disable @typescript-eslint/no-explicit-any */
// Regression: a claude-native cybo invoked via @-mention spawned its ephemeral
// session, but the turn HUNG for 10+ minutes and never posted a reply. The
// ephemeral channel summon has no completion path other than the routeToAgent
// drain loop seeing a terminal stream event — so a provider turn that STALLS
// (e.g. the cybo's cyborg7_send_message MCP round-trip never resolves) blocks
// the `for await` forever: no reply, no error, no teardown, and the agent +
// subprocess leak. The fix bounds the ephemeral turn with a watchdog that
// cancels the run after EPHEMERAL_TURN_TIMEOUT_MS, so a terminal event fires,
// the drain unwinds, and the agent is torn down.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, unlinkSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MessageRouter, type BroadcastFn } from "./message-router.js";

describe("MessageRouter — ephemeral mention turn watchdog", () => {
  let storage: DualStorage;
  let workspaceManager: WorkspaceManager;
  let router: MessageRouter;
  let broadcasted: any[];
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-ephemeral-"));
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
    vi.useRealTimers();
    storage.close();
    const dbPath = path.join(tmpDir, "test.db");
    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(`${dbPath}-wal`)) unlinkSync(`${dbPath}-wal`);
    if (existsSync(`${dbPath}-shm`)) unlinkSync(`${dbPath}-shm`);
  });

  // Build a workspace + channel + an EPHEMERAL channel-bound agent binding (the
  // shape spawnCybo creates for an @-mention), then wire a fake AgentManager
  // whose streamAgent emits `turn_started` and then STALLS (never terminates)
  // until its run is cancelled — exactly the wedged-MCP-tool symptom.
  function setupHangingEphemeralAgent(): { agentId: string; cancelled: () => boolean } {
    const agentId = "agent-ephemeral-1";
    const owner = storage.upsertUser("owner@test.dev", "Owner");
    const workspace = storage.createWorkspace("Mention Test", owner.id);
    const channel = storage.createChannel(workspace.id, "general", owner.id);
    storage.createAgentBinding({
      agentId,
      workspaceId: workspace.id,
      channelId: channel.id,
      provider: "claude",
      cyboId: null,
      initiatedBy: owner.id,
      ephemeral: true,
    });

    let cancelled = false;
    // A gate the stream awaits forever until cancelAgentRun releases it.
    let release: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });

    const fakeAgentManager = {
      subscribe: () => () => {},
      getAgent: () => ({ id: agentId, provider: "claude" }),
      appendTimelineItem: async () => {},
      closeAgent: async () => {},
      cancelAgentRun: async () => {
        cancelled = true;
        // Mirror the real manager: cancellation drives the turn to a terminal
        // event, which ends the generator. Release the stall so the drain unwinds.
        release();
        return true;
      },
      streamAgent: async function* () {
        yield { type: "turn_started", provider: "claude" };
        await stalled; // hang until cancelled
        yield { type: "turn_canceled", provider: "claude" };
      },
    };
    router.setAgentManager(fakeAgentManager as any);
    return { agentId, cancelled: () => cancelled };
  }

  it("cancels a stalled ephemeral mention turn after the timeout and tears it down", async () => {
    vi.useFakeTimers();
    const { agentId, cancelled } = setupHangingEphemeralAgent();
    expect(storage.getAgentBinding(agentId)).toBeTruthy();

    const routing = router.routeToAgent(agentId, "hola");

    // The drain is parked on the stalled stream; nothing has cancelled yet.
    await Promise.resolve();
    expect(cancelled()).toBe(false);

    // Advance past the watchdog bound (default 180s) — it must cancel the run.
    await vi.advanceTimersByTimeAsync(181_000);
    await routing;

    expect(cancelled()).toBe(true);
    // Ephemeral binding torn down — no leaked session.
    expect(storage.getAgentBinding(agentId)).toBeUndefined();
    // A timeout note was posted to the channel so the mention isn't a silent hole.
    const channelMsgs = broadcasted.filter((b) => b.type === "cyborg:channel_message_broadcast");
    expect(channelMsgs.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT arm the watchdog for a non-ephemeral turn", async () => {
    vi.useFakeTimers();
    const agentId = "agent-interactive-1";
    const owner = storage.upsertUser("o2@test.dev", "Owner2");
    const workspace = storage.createWorkspace("Interactive", owner.id);
    storage.createAgentBinding({
      agentId,
      workspaceId: workspace.id,
      provider: "claude",
      initiatedBy: owner.id,
    });
    let cancelled = false;
    const fakeAgentManager = {
      subscribe: () => () => {},
      getAgent: () => ({ id: agentId, provider: "claude" }),
      appendTimelineItem: async () => {},
      cancelAgentRun: async () => {
        cancelled = true;
        return true;
      },
      streamAgent: async function* () {
        yield { type: "turn_started", provider: "claude" };
        yield {
          type: "timeline",
          item: { type: "assistant_message", text: "hi" },
        };
        yield { type: "turn_completed", provider: "claude" };
      },
    };
    router.setAgentManager(fakeAgentManager as any);

    await router.routeToAgent(agentId, "hola");
    await vi.advanceTimersByTimeAsync(300_000);
    // A clean interactive turn finishes on its own; the watchdog never fires.
    expect(cancelled).toBe(false);
  });
});
