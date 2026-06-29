/* eslint-disable @typescript-eslint/no-explicit-any */
// END-TO-END flow repro for cloud cybo-mention invocation (P0): the exact
// "@apex hola" path, with the REAL relay-side orchestrator deciding and the
// REAL daemon-side dispatcher handler spawning — only the wire and PG are
// stubbed. Proves: channel message with a cybo mention → slash-style daemon
// pick → forwarded invoke → ephemeral channel-bound spawn → prompt routed.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { CyborgAuth } from "./auth.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MessageRouter, type BroadcastFn } from "./message-router.js";
import { CyborgDispatcher } from "./dispatcher.js";
import {
  invokeMentionedCybosViaRelay,
  type CyboMentionInvoke,
  type MentionInvokeDeps,
} from "./cybo-mention-invoke.js";

function createMockAgentManager() {
  const createdConfigs: any[] = [];
  return {
    createdConfigs,
    async createAgent(
      config: any,
      agentId?: string,
      options?: { labels?: Record<string, string>; workspaceId?: string },
    ) {
      const id = agentId ?? `agent-${createdConfigs.length}`;
      createdConfigs.push({ config, agentId: id, options });
      return {
        id,
        provider: config.provider,
        lifecycle: "idle" as const,
        cwd: config.cwd ?? "/tmp",
        labels: options?.labels ?? {},
        config,
        createdAt: new Date(),
      };
    },
    getAgent: () => undefined,
    subscribe: () => () => {},
  };
}

describe("cloud cybo-mention: full flow (relay orchestrator → daemon handler)", () => {
  let tmpDir: string;
  let storage: DualStorage;
  let auth: CyborgAuth;
  let workspaceManager: WorkspaceManager;
  let messageRouter: MessageRouter;
  let dispatcher: CyborgDispatcher;
  let mockManager: ReturnType<typeof createMockAgentManager>;
  let workspaceId: string;
  let owner: NonNullable<ReturnType<CyborgAuth["validateToken"]>>;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cybo-mention-flow-"));
    storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "test.db")), null);
    auth = new CyborgAuth(storage);
    workspaceManager = new WorkspaceManager(storage);
    const broadcast: BroadcastFn = { toWorkspace() {}, toUser() {} };
    messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
    dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);
    mockManager = createMockAgentManager();
    dispatcher.setAgentManager(mockManager as any);
    messageRouter.setAgentManager(mockManager as any);

    owner = auth.validateToken(auth.createToken("alice@test.com", "Alice"))!;
    workspaceId = workspaceManager.createWorkspace("Mention WS", owner.user.id).id;
  });

  afterEach(() => {
    storage.close();
    const dbPath = path.join(tmpDir, "test.db");
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("@apex hola → slash daemon pick → forwarded invoke → ephemeral channel-bound spawn → prompt routed", async () => {
    // A real cybo row (the PG stub serves it — in prod it's the PG roster).
    const apex = storage.createCybo({
      workspaceId,
      slug: "apex",
      name: "Apex",
      soul: "You are Apex.",
      provider: "pi",
      createdBy: owner.user.id,
    });

    // ── Relay side: the REAL orchestrator decides, the "wire" is captured ──
    const forwards: Array<{ daemonId: string; invoke: CyboMentionInvoke }> = [];
    const notices: string[] = [];
    const deps: MentionInvokeDeps = {
      pg: {
        getChannelCyboMembers: async () => [apex.id], // apex IS a channel member
        getCybos: async () => [apex as any],
        getMessages: async () => [
          { id: "m0", from_name: "Bob", from_id: "u-bob", text: "context line" },
          { id: "m-current", from_name: "Alice", from_id: owner.user.id, text: "@apex hola" },
        ],
        getWorkspaceSlashConfig: async () => ({
          defaultSlashDaemonId: "d-slash",
          fallbackDaemons: [],
        }),
        getDaemonsForWorkspace: async () => [{ id: "d-slash", ownerId: "admin" }],
      },
      getOnlineDaemonIds: () => ["d-slash"],
      forwardInvoke: (daemonId, invoke) => {
        forwards.push({ daemonId, invoke });
        return true;
      },
      notifyAuthor: (text) => notices.push(text),
      log: () => {},
    };

    await invokeMentionedCybosViaRelay(deps, {
      workspaceId,
      channelId: "ch-general",
      channelName: "general",
      messageId: "m-current",
      text: "@apex hola",
      mentions: ["cybo:" + apex.id],
      authorId: owner.user.id,
      authorName: "Alice",
      authorType: "human",
    });

    expect(notices).toEqual([]);
    expect(forwards).toHaveLength(1);
    expect(forwards[0].daemonId).toBe("d-slash"); // slash-style routing

    // ── Daemon side: feed the forwarded invoke into the REAL dispatcher ──
    const routed: Array<{ agentId: string; prompt: string; rawPrompt?: string }> = [];
    (messageRouter as any).routeToAgent = async (
      agentId: string,
      prompt: string,
      opts?: { rawPrompt?: string },
    ) => {
      routed.push({ agentId, prompt, rawPrompt: opts?.rawPrompt });
    };

    const emitted: unknown[] = [];
    await dispatcher.dispatch(
      { type: "cyborg:invoke_cybo_mention", ...forwards[0].invoke } as any,
      owner,
      (m) => emitted.push(m),
    );

    // The spawn happened, ephemeral and BOUND TO THE CHANNEL.
    expect(mockManager.createdConfigs).toHaveLength(1);
    const created = mockManager.createdConfigs[0];
    expect(created.options.labels.cyboId).toBe(apex.id);
    expect(created.options.labels.channelId).toBe("ch-general");
    const binding = storage.getAgentBinding(created.agentId);
    expect(binding?.channel_id).toBe("ch-general");
    expect(binding?.ephemeral).toBe(1);

    // The prompt reached the agent, with the mention + transcript context.
    expect(routed).toHaveLength(1);
    expect(routed[0].agentId).toBe(created.agentId);
    expect(routed[0].prompt).toContain("You were @-mentioned in #general.");
    expect(routed[0].prompt).toContain("@Bob: context line");
    expect(routed[0].prompt).toContain("Alice mentioned you: @apex hola");
    expect(routed[0].rawPrompt).toBe("@apex hola");

    // No failure notice was emitted.
    expect(emitted.filter((m: any) => m.type === "cyborg:cybo_mention_notice")).toHaveLength(0);
  });

  it("spawn failure on the daemon emits the author-only ephemeral notice (P2)", async () => {
    const emitted: any[] = [];
    await dispatcher.dispatch(
      {
        type: "cyborg:invoke_cybo_mention",
        workspaceId,
        channelId: "ch-general",
        channelName: "general",
        cyboId: "cybo_missing",
        prompt: "p",
        rawPrompt: "@ghost hola",
        // No resolvedCybo and not in local storage → CyboNotFoundError.
      } as any,
      owner,
      (m: any) => emitted.push(m),
    );
    const notices = emitted.filter((m) => m.type === "cyborg:cybo_mention_notice");
    expect(notices).toHaveLength(1);
    expect(notices[0].payload.toUserId).toBe(owner.user.id);
    expect(notices[0].payload.channelId).toBe("ch-general");
    expect(notices[0].payload.text).toContain("couldn't start");
  });

  // Ghost-session regression (2026-06-12): one @Rick mention got TWO responding
  // sessions. The dispatcher must be idempotent per (messageId, cyboId) — a
  // replayed/duplicated forward spawns NOTHING the second time.
  it("the same forwarded invoke (same messageId) spawns the cybo exactly ONCE", async () => {
    const apex = storage.createCybo({
      workspaceId,
      slug: "rick",
      name: "Rick",
      soul: "You are Rick.",
      provider: "pi",
      createdBy: owner.user.id,
    });
    (messageRouter as any).routeToAgent = async () => {};

    const invoke = {
      type: "cyborg:invoke_cybo_mention",
      workspaceId,
      channelId: "ch-general",
      channelName: "general",
      messageId: `msg-dup-${apex.id}`,
      cyboId: apex.id,
      prompt: "p",
      rawPrompt: "@rick how we doing",
    } as any;

    const emitted: unknown[] = [];
    await dispatcher.dispatch(invoke, owner, (m) => emitted.push(m));
    await dispatcher.dispatch(invoke, owner, (m) => emitted.push(m));

    expect(mockManager.createdConfigs).toHaveLength(1);
  });
});
