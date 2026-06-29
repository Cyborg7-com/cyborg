/* eslint-disable @typescript-eslint/no-explicit-any */
// internal docs FIX 5: the ephemeral mention drain used to SWALLOW a failed/empty
// cybo turn (turn_failed, auth error, immediate exit, timeout) — no text posted,
// no error surfaced: the silent black hole. These tests prove every failure mode
// now posts ONE concise, classified, secret-free channel notice, while a
// successful turn posts NO error notice.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, unlinkSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { WorkspaceManager } from "./workspace-manager.js";
import {
  MessageRouter,
  classifyEphemeralFailureNotice,
  type BroadcastFn,
} from "./message-router.js";

describe("classifyEphemeralFailureNotice (pure)", () => {
  it("auth failure on a native harness → actionable login remedy", () => {
    const out = classifyEphemeralFailureNotice({
      cyboName: "Rick",
      provider: "claude",
      failedEvent: { type: "turn_failed", error: "401 unauthorized: invalid x-api-key" },
      timedOut: false,
      interrupted: false,
    });
    expect(out).toContain("Rick");
    expect(out).toContain("claude login");
    expect(out).toContain("Claude");
  });

  it("generic turn error → 'hit an error' with a short classified reason", () => {
    const out = classifyEphemeralFailureNotice({
      cyboName: "Rick",
      provider: "claude",
      failedEvent: { type: "turn_failed", error: "Something exploded in the agent loop" },
      timedOut: false,
      interrupted: false,
    });
    expect(out).toContain("hit an error:");
    // Never leaks a raw stack — but the short reason text is shown.
    expect(out).not.toContain("\n");
  });

  it("rate-limit turn error stays a 'hit an error' notice (not a login remedy)", () => {
    const out = classifyEphemeralFailureNotice({
      cyboName: "Rick",
      provider: "claude",
      failedEvent: { type: "turn_failed", error: "429 rate_limit_error: too many requests" },
      timedOut: false,
      interrupted: false,
    });
    expect(out).toContain("hit an error");
    expect(out).not.toContain("claude login");
  });

  it("timeout with no event → 'didn't return a reply' notice", () => {
    const out = classifyEphemeralFailureNotice({
      cyboName: "Rick",
      provider: "claude",
      failedEvent: null,
      timedOut: true,
      interrupted: false,
    });
    expect(out).toContain("didn't return a reply");
  });

  it("daemon dropped mid-turn → 'daemon went offline' notice", () => {
    const out = classifyEphemeralFailureNotice({
      cyboName: "Rick",
      provider: "claude",
      failedEvent: null,
      timedOut: false,
      interrupted: true,
    });
    expect(out).toContain("daemon went offline");
  });

  it("falls back to a generic name when the cybo name is empty", () => {
    const out = classifyEphemeralFailureNotice({
      cyboName: "",
      provider: null,
      failedEvent: null,
      timedOut: true,
      interrupted: false,
    });
    expect(out).toContain("The cybo");
  });
});

describe("MessageRouter — ephemeral mention drain posts classified failures", () => {
  let storage: DualStorage;
  let workspaceManager: WorkspaceManager;
  let router: MessageRouter;
  let broadcasted: any[];
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-ephemeral-fail-"));
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

  // Build a workspace + channel + a named cybo + an EPHEMERAL channel-bound agent
  // binding (the shape spawnCybo creates for an @-mention), wired to a fake
  // AgentManager whose streamAgent yields the given events.
  function setupEphemeralAgent(events: unknown[]): { agentId: string } {
    const agentId = `agent-ephemeral-${Math.random().toString(36).slice(2)}`;
    const owner = storage.upsertUser("owner@test.dev", "Owner");
    const workspace = storage.createWorkspace("Mention Test", owner.id);
    const channel = storage.createChannel(workspace.id, "general", owner.id);
    const cybo = storage.createCybo({
      workspaceId: workspace.id,
      slug: "rick",
      name: "Rick",
      soul: "wubba lubba dub dub",
      provider: "claude",
      createdBy: owner.id,
    });
    storage.createAgentBinding({
      agentId,
      workspaceId: workspace.id,
      channelId: channel.id,
      provider: "claude",
      cyboId: cybo.id,
      initiatedBy: owner.id,
      ephemeral: true,
    });
    const fakeAgentManager = {
      subscribe: () => () => {},
      getAgent: () => ({ id: agentId, provider: "claude" }),
      appendTimelineItem: async () => {},
      closeAgent: async () => {},
      cancelAgentRun: async () => true,
      streamAgent: async function* () {
        for (const e of events) yield e;
      },
    };
    router.setAgentManager(fakeAgentManager as any);
    return { agentId };
  }

  function channelMessages(): any[] {
    return broadcasted.filter((b) => b.type === "cyborg:channel_message_broadcast");
  }

  it("a signed-out native daemon turn_failed posts the actionable login notice", async () => {
    const { agentId } = setupEphemeralAgent([
      { type: "turn_started", provider: "claude" },
      {
        type: "turn_failed",
        provider: "claude",
        error: "401 unauthorized: invalid x-api-key (not logged in)",
      },
    ]);
    await router.routeToAgent(agentId, "hola");
    const msgs = channelMessages();
    expect(msgs.length).toBe(1);
    const text = JSON.stringify(msgs[0]);
    expect(text).toContain("Rick");
    expect(text).toContain("claude login");
    // Ephemeral agent torn down.
    expect(storage.getAgentBinding(agentId)).toBeUndefined();
  });

  it("a generic turn_failed posts a classified 'hit an error' notice", async () => {
    const { agentId } = setupEphemeralAgent([
      { type: "turn_started", provider: "claude" },
      { type: "turn_failed", provider: "claude", error: "Something exploded in the agent loop" },
    ]);
    await router.routeToAgent(agentId, "hola");
    const msgs = channelMessages();
    expect(msgs.length).toBe(1);
    expect(JSON.stringify(msgs[0])).toContain("hit an error");
  });

  it("a timeout (watchdog) posts the no-reply notice", async () => {
    vi.useFakeTimers();
    // Stream stalls until cancelled, then ends with turn_canceled — the watchdog
    // path: timedOut=true, no failedEvent, no interruption.
    const agentId = `agent-ephemeral-timeout`;
    const owner = storage.upsertUser("o@test.dev", "Owner");
    const workspace = storage.createWorkspace("WS", owner.id);
    const channel = storage.createChannel(workspace.id, "general", owner.id);
    const cybo = storage.createCybo({
      workspaceId: workspace.id,
      slug: "rick",
      name: "Rick",
      soul: "s",
      provider: "claude",
      createdBy: owner.id,
    });
    storage.createAgentBinding({
      agentId,
      workspaceId: workspace.id,
      channelId: channel.id,
      provider: "claude",
      cyboId: cybo.id,
      initiatedBy: owner.id,
      ephemeral: true,
    });
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
        release();
        return true;
      },
      streamAgent: async function* () {
        yield { type: "turn_started", provider: "claude" };
        await stalled;
        yield { type: "turn_canceled", provider: "claude" };
      },
    };
    router.setAgentManager(fakeAgentManager as any);

    const routing = router.routeToAgent(agentId, "hola");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(181_000);
    await routing;

    const msgs = channelMessages();
    expect(msgs.length).toBe(1);
    expect(JSON.stringify(msgs[0])).toContain("didn't return a reply");
  });

  it("a successful turn (assistant text) posts the reply and NO error notice", async () => {
    const { agentId } = setupEphemeralAgent([
      { type: "turn_started", provider: "claude" },
      { type: "timeline", item: { type: "assistant_message", text: "wubba lubba dub dub" } },
      { type: "turn_completed", provider: "claude" },
    ]);
    await router.routeToAgent(agentId, "hola");
    const msgs = channelMessages();
    expect(msgs.length).toBe(1);
    const text = JSON.stringify(msgs[0]);
    expect(text).toContain("wubba lubba dub dub");
    expect(text).not.toContain("hit an error");
    expect(text).not.toContain("didn't return a reply");
    expect(text).not.toContain("claude login");
  });

  it("a clean empty completion (cybo chose not to reply) posts NOTHING", async () => {
    const { agentId } = setupEphemeralAgent([
      { type: "turn_started", provider: "claude" },
      { type: "turn_completed", provider: "claude" },
    ]);
    await router.routeToAgent(agentId, "hola");
    expect(channelMessages().length).toBe(0);
  });
});
