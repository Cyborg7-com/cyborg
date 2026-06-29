/* eslint-disable @typescript-eslint/no-explicit-any */
// FIX 1 (internal docs): the @-mention spawn path must apply the same native
// login gate the explicit spawn path uses. A native-claude cybo mentioned on a
// SIGNED-OUT daemon must FAIL LOUDLY with a clear channel notice instead of
// spawning and auth-failing into the silent ephemeral-drain black hole.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

// Force the native login probe deterministically — the daemon under test is
// signed OUT of Claude. isNativeHarnessProvider keeps its real implementation.
const loginState = { state: "logged_out" as "logged_out" | "logged_in" };
vi.mock("./native-harness-login.js", async (importActual) => {
  const actual = await importActual<typeof import("./native-harness-login.js")>();
  return {
    ...actual,
    probeNativeHarnessLogin: async () =>
      loginState.state === "logged_out"
        ? { state: "logged_out", reason: "Claude is signed out on this daemon." }
        : { state: "logged_in" },
  };
});

import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { CyborgAuth } from "./auth.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MessageRouter, type BroadcastFn } from "./message-router.js";
import { CyborgDispatcher } from "./dispatcher.js";

function createMockAgentManager() {
  const createdConfigs: any[] = [];
  return {
    createdConfigs,
    async createAgent(
      config: any,
      agentId?: string,
      options?: { labels?: Record<string, string> },
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

describe("cybo-mention native-harness login gate (FIX 1)", () => {
  let tmpDir: string;
  let storage: DualStorage;
  let dispatcher: CyborgDispatcher;
  let messageRouter: MessageRouter;
  let mockManager: ReturnType<typeof createMockAgentManager>;
  let workspaceId: string;
  let owner: NonNullable<ReturnType<CyborgAuth["validateToken"]>>;

  beforeEach(() => {
    loginState.state = "logged_out";
    tmpDir = mkdtempSync(path.join(tmpdir(), "cybo-mention-native-"));
    storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "test.db")), null);
    const auth = new CyborgAuth(storage);
    const workspaceManager = new WorkspaceManager(storage);
    const broadcast: BroadcastFn = { toWorkspace() {}, toUser() {} };
    messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
    dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);
    mockManager = createMockAgentManager();
    dispatcher.setAgentManager(mockManager as any);
    messageRouter.setAgentManager(mockManager as any);
    (messageRouter as any).routeToAgent = async () => {};

    owner = auth.validateToken(auth.createToken("seb@test.com", "Seb"))!;
    workspaceId = workspaceManager.createWorkspace("Jex", owner.user.id).id;
  });

  afterEach(() => {
    storage.close();
    const dbPath = path.join(tmpDir, "test.db");
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRick(): { id: string } {
    return storage.createCybo({
      workspaceId,
      slug: "rick",
      name: "Rick",
      soul: "You are Rick.",
      provider: "claude",
      model: "claude-haiku-4-5",
      createdBy: owner.user.id,
    });
  }

  async function mention(cyboId: string): Promise<any[]> {
    const emitted: any[] = [];
    await dispatcher.dispatch(
      {
        type: "cyborg:invoke_cybo_mention",
        workspaceId,
        channelId: "ch-general",
        channelName: "general",
        messageId: "m-rick-1",
        cyboId,
        prompt: "hola",
        rawPrompt: "@rick hola",
      } as any,
      owner,
      (m) => emitted.push(m),
    );
    return emitted;
  }

  it("native-claude cybo on a SIGNED-OUT daemon → channel notice, NO spawn (no silent hang)", async () => {
    const rick = makeRick();
    const emitted = await mention(rick.id);

    const notices = emitted.filter((m) => m.type === "cyborg:cybo_mention_notice");
    expect(notices).toHaveLength(1);
    expect(notices[0].payload.channelId).toBe("ch-general");
    expect(notices[0].payload.toUserId).toBe(owner.user.id);
    // Branded, ACTIONABLE native-harness gap message (internal docs PART 1): names
    // the cybo, the missing Claude login, and the concrete `claude login` fix.
    expect(notices[0].payload.text).toContain("Rick");
    expect(notices[0].payload.text).toContain("Claude");
    expect(notices[0].payload.text).toContain("claude login");
    // THE artifact: the dead spawn never happened.
    expect(mockManager.createdConfigs).toHaveLength(0);
  });

  it("native-claude cybo on a LOGGED-IN daemon → spawns normally (gate is fail-open)", async () => {
    loginState.state = "logged_in";
    const rick = makeRick();
    const emitted = await mention(rick.id);

    expect(emitted.filter((m) => m.type === "cyborg:cybo_mention_notice")).toHaveLength(0);
    expect(mockManager.createdConfigs).toHaveLength(1);
    expect(mockManager.createdConfigs[0].config.provider).toBe("claude");
  });
});
