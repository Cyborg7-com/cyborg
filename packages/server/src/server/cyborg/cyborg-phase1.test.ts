/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { CyborgAuth } from "./auth.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MessageRouter, type BroadcastFn } from "./message-router.js";
import { CyborgDispatcher } from "./dispatcher.js";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";

function createMockAgentManager() {
  const agents = new Map<
    string,
    { id: string; provider: string; lifecycle: string; labels: Record<string, string> }
  >();
  let idCounter = 0;
  let streamHandler:
    | ((agentId: string, prompt: string) => AsyncGenerator<AgentStreamEvent>)
    | null = null;

  const subscribers = new Set<(event: unknown) => void>();

  return {
    setStreamHandler(fn: typeof streamHandler) {
      streamHandler = fn;
    },

    subscribe(callback: (event: unknown) => void, _options?: { replayState?: boolean }) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },

    emit(event: unknown) {
      for (const cb of subscribers) cb(event);
    },

    getAgent(agentId: string) {
      const agent = agents.get(agentId);
      if (!agent) return null;
      return {
        ...agent,
        cwd: "/tmp",
        capabilities: {},
        config: { provider: agent.provider },
        createdAt: new Date(),
        updatedAt: new Date(),
        availableModes: [],
        currentModeId: null,
        pendingPermissions: new Map(),
        bufferedPermissionResolutions: new Map(),
        inFlightPermissionResponses: new Set(),
        pendingReplacement: false,
        persistence: null,
        historyPrimed: false,
        lastUserMessageAt: null,
        attention: { active: false },
        foregroundTurnWaiters: new Set(),
        finalizedForegroundTurnIds: new Set(),
        unsubscribeSession: null,
        session: {},
        activeForegroundTurnId: null,
      };
    },

    async closeAgent(agentId: string) {
      agents.delete(agentId);
    },

    async createAgent(
      config: { provider: string },
      _agentId?: string,
      options?: { labels?: Record<string, string>; workspaceId?: string },
    ) {
      const id = `agent-${++idCounter}`;
      agents.set(id, {
        id,
        provider: config.provider,
        lifecycle: "idle",
        labels: options?.labels ?? {},
      });
      return {
        id,
        provider: config.provider,
        lifecycle: "idle" as const,
        cwd: "/tmp",
        labels: options?.labels ?? {},
        capabilities: {},
        config,
        createdAt: new Date(),
        updatedAt: new Date(),
        availableModes: [],
        currentModeId: null,
        pendingPermissions: new Map(),
        bufferedPermissionResolutions: new Map(),
        inFlightPermissionResponses: new Set(),
        pendingReplacement: false,
        persistence: null,
        historyPrimed: false,
        lastUserMessageAt: null,
        attention: { active: false },
        foregroundTurnWaiters: new Set(),
        finalizedForegroundTurnIds: new Set(),
        unsubscribeSession: null,
        session: {},
        activeForegroundTurnId: null,
      };
    },

    listAgents() {
      return Array.from(agents.values());
    },

    // Mirrors the real AgentManager's contract: streaming drives subscriber
    // events (agent_state lifecycle transitions + agent_stream per event),
    // which message-router turns into cyborg:agent_status / cyborg:agent_stream
    // workspace broadcasts.
    streamAgent(agentId: string, prompt: string | unknown): AsyncGenerator<AgentStreamEvent> {
      const inner = streamHandler
        ? streamHandler(agentId, prompt as string)
        : (async function* (): AsyncGenerator<AgentStreamEvent> {})();
      const agent = agents.get(agentId);
      const emitState = (lifecycle: string, lastError?: string) => {
        if (!agent) return;
        agent.lifecycle = lifecycle;
        if (lastError) agent.lastError = lastError;
        for (const cb of subscribers) cb({ type: "agent_state", agent: { ...agent } });
      };
      const emitStream = (event: AgentStreamEvent) => {
        for (const cb of subscribers) cb({ type: "agent_stream", agentId, event });
      };
      async function* wrapped(): AsyncGenerator<AgentStreamEvent> {
        emitState("running");
        try {
          for await (const event of inner) {
            emitStream(event);
            yield event;
          }
          emitState("idle");
        } catch (err) {
          emitState("error", err instanceof Error ? err.message : String(err));
          emitState("idle");
          throw err;
        }
      }
      return wrapped();
    },
  };
}

describe("Cyborg7 Phase 1 — direct agent lifecycle (no bridge)", () => {
  let storage: DualStorage;
  let auth: CyborgAuth;
  let workspaceManager: WorkspaceManager;
  let messageRouter: MessageRouter;
  let dispatcher: CyborgDispatcher;
  let mockAgentManager: ReturnType<typeof createMockAgentManager>;
  let broadcasted: unknown[];
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-phase1-"));
    const dbPath = path.join(tmpDir, "test.db");
    storage = new DualStorage(new CyborgStorage(dbPath), null);
    auth = new CyborgAuth(storage);
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
    mockAgentManager = createMockAgentManager();
    messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
    messageRouter.setAgentManager(mockAgentManager as any);
    dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);
    dispatcher.setAgentManager(mockAgentManager as any);
  });

  afterEach(() => {
    storage.close();
    const dbPath = path.join(tmpDir, "test.db");
    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(`${dbPath}-wal`)) unlinkSync(`${dbPath}-wal`);
    if (existsSync(`${dbPath}-shm`)) unlinkSync(`${dbPath}-shm`);
  });

  async function createWorkspace(
    ctx: NonNullable<ReturnType<CyborgAuth["validateToken"]>>,
  ): Promise<string> {
    const emitted: unknown[] = [];
    await dispatcher.dispatch(
      { type: "cyborg:create_workspace", name: "Test WS", requestId: "r-ws" },
      ctx,
      (msg) => emitted.push(msg),
    );
    return (emitted[0] as any).payload.workspace.id;
  }

  it("creates an agent (stored in SQLite) and lists it", async () => {
    const ctx = auth.validateToken(auth.createToken("alice@test.com", "Alice"))!;
    const workspaceId = await createWorkspace(ctx);
    const emitted: unknown[] = [];
    const emit = (msg: unknown) => emitted.push(msg);

    await dispatcher.dispatch(
      {
        type: "cyborg:create_agent",
        workspaceId,
        provider: "claude",
        cwd: "/tmp",
        requestId: "r1",
      },
      ctx,
      emit,
    );

    const createResp = emitted[0] as any;
    expect(createResp.type).toBe("cyborg:create_agent_response");
    expect(createResp.payload.agent.agentId).toBeTruthy();
    expect(createResp.payload.agent.provider).toBe("claude");

    // Binding persisted in storage
    const binding = storage.getAgentBinding(createResp.payload.agent.agentId);
    expect(binding).toBeTruthy();
    expect(binding!.workspace_id).toBe(workspaceId);
    expect(binding!.provider).toBe("claude");

    // List agents returns from storage
    await dispatcher.dispatch(
      { type: "cyborg:list_agents", workspaceId, requestId: "r2" },
      ctx,
      emit,
    );
    const listResp = emitted[1] as any;
    expect(listResp.payload.agents).toHaveLength(1);
    expect(listResp.payload.agents[0].agentId).toBe(createResp.payload.agent.agentId);
  });

  // Cross-daemon initiated_by bridge (daemon half): the agent-list row must carry
  // the INITIATOR'S EMAIL so the relay can resolve the daemon-local initiated_by
  // to the viewer's global account id (a session R launched on S's daemon must
  // group under R's "You"). The email is the stable cross-namespace identity —
  // resolved from the local initiated_by via the daemon's own users table.
  it("list_agents row carries initiatedByEmail for the cross-daemon bridge", async () => {
    const ctx = auth.validateToken(auth.createToken("alice@test.com", "Alice"))!;
    const workspaceId = await createWorkspace(ctx);

    storage.createAgentBinding({
      agentId: "agent-attributed",
      workspaceId,
      channelId: null,
      provider: "claude",
      model: null,
      systemPrompt: "x",
      daemonId: null,
      cyboId: null,
      initiatedBy: ctx.user.id, // a LOCAL SQLite user id on this daemon
      cwd: null,
    });

    const emitted: unknown[] = [];
    await dispatcher.dispatch(
      { type: "cyborg:list_agents", workspaceId, requestId: "r-email" },
      ctx,
      (msg) => emitted.push(msg),
    );
    const agents = (emitted[0] as any).payload.agents as Array<{
      agentId: string;
      initiatedBy: string;
      initiatedByEmail: string | null;
    }>;
    const row = agents.find((a) => a.agentId === "agent-attributed")!;
    expect(row.initiatedBy).toBe(ctx.user.id); // still the local id on the wire
    expect(row.initiatedByEmail).toBe("alice@test.com"); // …plus the bridge key
  });

  // Ghost-session regression (2026-06-12) + ephemeral mention-session ownership
  // (problem 3) + PRIVACY (2026-06-30): mention/slash summons are channel-bound
  // EPHEMERAL bindings, and now EVERY channel-bound session (ephemeral or not) is
  // OWNER-SCOPED. The initiator sees their OWN sessions; NOTHING leaks into another
  // member's sidebar (the channel_id short-circuit that let every member see each
  // other's channel cybo sessions was removed).
  it("list_agents scopes ALL channel bindings (ephemeral AND interactive) to their initiator", async () => {
    const ctx = auth.validateToken(auth.createToken("alice@test.com", "Alice"))!;
    const bystander = auth.validateToken(auth.createToken("bob@test.com", "Bob"))!;
    const workspaceId = await createWorkspace(ctx);
    storage.addMember(workspaceId, bystander.user.id, "member");

    storage.createAgentBinding({
      agentId: "agent-ephemeral",
      workspaceId,
      channelId: "ch-general",
      provider: "claude",
      model: null,
      systemPrompt: "x",
      daemonId: null,
      cyboId: null,
      initiatedBy: ctx.user.id,
      cwd: null,
      ephemeral: true,
    });
    storage.createAgentBinding({
      agentId: "agent-visible",
      workspaceId,
      channelId: "ch-general",
      provider: "claude",
      model: null,
      systemPrompt: "x",
      daemonId: null,
      cyboId: null,
      initiatedBy: ctx.user.id,
      cwd: null,
    });

    const listFor = async (who: typeof ctx): Promise<string[]> => {
      const emitted: unknown[] = [];
      await dispatcher.dispatch(
        { type: "cyborg:list_agents", workspaceId, requestId: "r-eph" },
        who,
        (msg) => emitted.push(msg),
      );
      const agents = (emitted[0] as any).payload.agents as Array<{ agentId: string }>;
      return agents.map((a) => a.agentId).sort();
    };

    // The initiator sees BOTH their ephemeral summon and their interactive channel
    // agent (they own both).
    expect(await listFor(ctx)).toEqual(["agent-ephemeral", "agent-visible"]);
    // A bystander sees NEITHER — every channel-bound session is now owner-scoped, so
    // no member sees another member's cybo sessions (privacy fix).
    expect(await listFor(bystander)).toEqual([]);
  });

  // The agent_status broadcast is what populates other members' clients and
  // the relay's daemon_agents PG table. Ephemeral summons must never emit it
  // (ghost-session incident: every member saw the mention-spawned session).
  it("agent_state events for ephemeral bindings do NOT broadcast cyborg:agent_status", async () => {
    const ctx = auth.validateToken(auth.createToken("alice@test.com", "Alice"))!;
    const workspaceId = await createWorkspace(ctx);
    const base = {
      workspaceId,
      channelId: "ch-1",
      provider: "claude",
      model: null,
      systemPrompt: "x",
      daemonId: null,
      cyboId: null,
      initiatedBy: ctx.user.id,
      cwd: null,
    };
    storage.createAgentBinding({ ...base, agentId: "a-ephemeral", ephemeral: true });
    storage.createAgentBinding({ ...base, agentId: "a-visible" });

    broadcasted.length = 0;
    const agentState = (id: string) => ({
      type: "agent_state",
      agent: { id, lifecycle: "running", provider: "claude" },
    });
    mockAgentManager.emit(agentState("a-ephemeral"));
    mockAgentManager.emit(agentState("a-visible"));

    const statuses = broadcasted.filter((m: any) => m.type === "cyborg:agent_status") as Array<{
      payload: { agentId: string };
    }>;
    expect(statuses.map((s) => s.payload.agentId)).toEqual(["a-visible"]);
  });

  // #446: the 'every agent error emits turn_failed' invariant as a LOCAL
  // guarantee. Teardown is normally turn-event-driven; an error path that
  // forgets to emit turn_failed must still not leave a ghost ephemeral session
  // — the error agent_state alone tears it down. Non-ephemeral agents and
  // non-error lifecycles are untouched.
  it("an error agent_state tears down an ephemeral binding even without turn_failed", async () => {
    const ctx = auth.validateToken(auth.createToken("alice@test.com", "Alice"))!;
    const workspaceId = await createWorkspace(ctx);
    const base = {
      workspaceId,
      channelId: "ch-1",
      provider: "claude",
      model: null,
      systemPrompt: "x",
      daemonId: null,
      cyboId: null,
      initiatedBy: ctx.user.id,
      cwd: null,
    };
    storage.createAgentBinding({ ...base, agentId: "a-eph-err", ephemeral: true });
    storage.createAgentBinding({ ...base, agentId: "a-eph-run", ephemeral: true });
    storage.createAgentBinding({ ...base, agentId: "a-vis-err" });

    const agentState = (id: string, lifecycle: string) => ({
      type: "agent_state",
      agent: { id, lifecycle, provider: "claude" },
    });
    mockAgentManager.emit(agentState("a-eph-err", "error"));
    mockAgentManager.emit(agentState("a-eph-run", "running"));
    mockAgentManager.emit(agentState("a-vis-err", "error"));
    // teardownEphemeralAgent awaits closeAgent — give the microtask queue a beat.
    await new Promise((r) => setTimeout(r, 20));

    expect(storage.getAgentBinding("a-eph-err")).toBeUndefined(); // torn down
    expect(storage.getAgentBinding("a-eph-run")).toBeDefined(); // still mid-turn
    expect(storage.getAgentBinding("a-vis-err")).toBeDefined(); // never auto-torn
  });

  // Ephemeral agents are in-process: any ephemeral binding still present at
  // boot is a leaked teardown. The startup sweep removes them (accumulation
  // guard for the ghost-session incident).
  it("deleteEphemeralAgentBindings sweeps only ephemeral rows", async () => {
    const ctx = auth.validateToken(auth.createToken("alice@test.com", "Alice"))!;
    const workspaceId = await createWorkspace(ctx);
    const base = {
      workspaceId,
      channelId: "ch-1",
      provider: "claude",
      model: null,
      systemPrompt: "x",
      daemonId: null,
      cyboId: null,
      initiatedBy: ctx.user.id,
      cwd: null,
    };
    storage.createAgentBinding({ ...base, agentId: "a-eph-1", ephemeral: true });
    storage.createAgentBinding({ ...base, agentId: "a-eph-2", ephemeral: true });
    storage.createAgentBinding({ ...base, agentId: "a-keep" });

    expect(storage.sqlite.deleteEphemeralAgentBindings()).toBe(2);
    expect(storage.getAgentBinding("a-eph-1")).toBeUndefined();
    expect(storage.getAgentBinding("a-keep")).toBeDefined();
  });

  it("rejects agent creation without workspace permission", async () => {
    const alice = auth.validateToken(auth.createToken("alice@test.com", "Alice"))!;
    const bob = auth.validateToken(auth.createToken("bob@test.com", "Bob"))!;
    const workspaceId = await createWorkspace(alice);
    const emitted: unknown[] = [];

    // Bob is not a member
    await dispatcher.dispatch(
      {
        type: "cyborg:create_agent",
        workspaceId,
        provider: "claude",
        cwd: "/tmp",
        requestId: "r1",
      },
      bob,
      (msg) => emitted.push(msg),
    );

    const resp = emitted[0] as any;
    expect(resp.type).toBe("cyborg:error");
    expect(resp.payload.code).toBe("forbidden");
  });

  it("sends prompt and receives stream events via broadcast", async () => {
    const ctx = auth.validateToken(auth.createToken("alice@test.com", "Alice"))!;
    const workspaceId = await createWorkspace(ctx);
    const emitted: unknown[] = [];
    const emit = (msg: unknown) => emitted.push(msg);

    await dispatcher.dispatch(
      {
        type: "cyborg:create_agent",
        workspaceId,
        provider: "claude",
        cwd: "/tmp",
        requestId: "r1",
      },
      ctx,
      emit,
    );
    const agentId = (emitted[0] as any).payload.agent.agentId;

    mockAgentManager.setStreamHandler(async function* () {
      yield {
        type: "timeline",
        item: { type: "assistant_message", text: "Hello from PI!" },
      } as AgentStreamEvent;
      yield { type: "turn_completed", turnId: "t1" } as AgentStreamEvent;
    });

    broadcasted = [];

    await dispatcher.dispatch(
      { type: "cyborg:send_agent_prompt", workspaceId, agentId, prompt: "Hey PI", requestId: "r2" },
      ctx,
      emit,
    );

    const ack = emitted.find((e: any) => e.type === "cyborg:send_agent_prompt_response") as any;
    expect(ack.payload.status).toBe("routed");

    await new Promise((r) => setTimeout(r, 50));

    const statusRunning = broadcasted.find(
      (e: any) => e.type === "cyborg:agent_status" && e.payload.status === "running",
    );
    expect(statusRunning).toBeTruthy();

    const textStream = broadcasted.find(
      (e: any) => e.type === "cyborg:agent_stream" && e.payload.event?.type === "timeline",
    ) as any;
    expect(textStream.payload.event.item.text).toBe("Hello from PI!");
    expect(textStream.payload.workspaceId).toBe(workspaceId);

    const statusIdle = broadcasted.find(
      (e: any) => e.type === "cyborg:agent_status" && e.payload.status === "idle",
    );
    expect(statusIdle).toBeTruthy();
  });

  it("rejects prompt to agent from wrong workspace", async () => {
    const ctx = auth.validateToken(auth.createToken("alice@test.com", "Alice"))!;
    const workspaceId = await createWorkspace(ctx);
    const emitted: unknown[] = [];
    const emit = (msg: unknown) => emitted.push(msg);

    await dispatcher.dispatch(
      {
        type: "cyborg:create_agent",
        workspaceId,
        provider: "claude",
        cwd: "/tmp",
        requestId: "r1",
      },
      ctx,
      emit,
    );
    const agentId = (emitted[0] as any).payload.agent.agentId;

    // Try to send prompt from a different workspaceId
    emitted.length = 0;
    await dispatcher.dispatch(
      {
        type: "cyborg:send_agent_prompt",
        workspaceId: "ws_fake",
        agentId,
        prompt: "hack",
        requestId: "r2",
      },
      ctx,
      emit,
    );

    const resp = emitted[0] as any;
    expect(resp.type).toBe("cyborg:error");
    expect(resp.payload.code).toBe("forbidden");
  });

  it("broadcasts error status when agent stream fails", async () => {
    const ctx = auth.validateToken(auth.createToken("alice@test.com", "Alice"))!;
    const workspaceId = await createWorkspace(ctx);
    const emitted: unknown[] = [];
    const emit = (msg: unknown) => emitted.push(msg);

    await dispatcher.dispatch(
      {
        type: "cyborg:create_agent",
        workspaceId,
        provider: "claude",
        cwd: "/tmp",
        requestId: "r1",
      },
      ctx,
      emit,
    );
    const agentId = (emitted[0] as any).payload.agent.agentId;

    mockAgentManager.setStreamHandler(function failingGenerator() {
      async function* gen(): AsyncGenerator<AgentStreamEvent> {
        yield { type: "error", error: "Provider timeout" } as unknown as AgentStreamEvent;
        throw new Error("Provider timeout");
      }
      return gen();
    });

    broadcasted = [];

    await dispatcher.dispatch(
      { type: "cyborg:send_agent_prompt", workspaceId, agentId, prompt: "fail", requestId: "r2" },
      ctx,
      emit,
    );

    await new Promise((r) => setTimeout(r, 50));

    const statusError = broadcasted.find(
      (e: any) => e.type === "cyborg:agent_status" && e.payload.status === "error",
    ) as any;
    expect(statusError).toBeTruthy();
    expect(statusError.payload.error).toBe("Provider timeout");

    const statusIdle = broadcasted.find(
      (e: any) => e.type === "cyborg:agent_status" && e.payload.status === "idle",
    );
    expect(statusIdle).toBeTruthy();
  });

  it("routes mention in channel message to agent", async () => {
    const ctx = auth.validateToken(auth.createToken("alice@test.com", "Alice"))!;
    const workspaceId = await createWorkspace(ctx);
    const emitted: unknown[] = [];
    const emit = (msg: unknown) => emitted.push(msg);

    // Create agent
    await dispatcher.dispatch(
      {
        type: "cyborg:create_agent",
        workspaceId,
        provider: "claude",
        cwd: "/tmp",
        requestId: "r1",
      },
      ctx,
      emit,
    );
    const agentId = (emitted[0] as any).payload.agent.agentId;

    // Get #general channel
    await dispatcher.dispatch(
      { type: "cyborg:fetch_channels", workspaceId, requestId: "r2" },
      ctx,
      emit,
    );
    const channelId = (emitted[1] as any).payload.channels[0].id;

    let receivedPrompt = "";
    mockAgentManager.setStreamHandler(async function* (_agentId, prompt) {
      receivedPrompt = prompt;
      yield {
        type: "timeline",
        item: { type: "assistant_message", text: "On it!" },
      } as AgentStreamEvent;
    });

    broadcasted = [];

    // Send message mentioning the agent
    await dispatcher.dispatch(
      {
        type: "cyborg:channel_message",
        workspaceId,
        channelId,
        text: "fix the bug",
        mentions: [agentId],
      },
      ctx,
      emit,
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(receivedPrompt).toContain("Alice");
    expect(receivedPrompt).toContain("fix the bug");
    expect(receivedPrompt).toContain("#general");

    const textStream = broadcasted.find(
      (e: any) => e.type === "cyborg:agent_stream" && e.payload.event?.type === "timeline",
    ) as any;
    expect(textStream).toBeTruthy();
    expect(textStream.payload.event.item.text).toBe("On it!");
  });
});
