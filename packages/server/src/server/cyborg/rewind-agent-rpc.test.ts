import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rmSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { CyborgAuth } from "./auth.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MessageRouter, type BroadcastFn } from "./message-router.js";
import { CyborgDispatcher } from "./dispatcher.js";
import type { CyborgAuthContext } from "./auth.js";
import type { AgentManager } from "../agent/agent-manager.js";

// 'Rewind to here' (#649): the dispatcher handler for cyborg:rewind_agent must
// forward to Paseo's agentManager.rewind for the cybo's session, gated by the
// agent binding (workspace membership), and report the outcome. The provider-level
// truncation itself is covered by Paseo's per-provider rewind tests; here we prove
// the cyborg surface wires through correctly + enforces the binding/auth.

interface Emitted {
  type: string;
  payload: Record<string, unknown>;
}

describe("cyborg:rewind_agent (dispatcher, local mode)", () => {
  let storage: DualStorage;
  let auth: CyborgAuth;
  let workspaceManager: WorkspaceManager;
  let dispatcher: CyborgDispatcher;
  let tmpDir: string;
  let owner: CyborgAuthContext;
  let workspaceId: string;
  let rewindMock: ReturnType<typeof vi.fn>;

  async function dispatch(msg: Record<string, unknown>, who = owner): Promise<Emitted[]> {
    const out: Emitted[] = [];
    await dispatcher.dispatch(msg as never, who, (m) => out.push(m as Emitted));
    return out;
  }

  function bindAgent(agentId: string, ws: string): void {
    storage.createAgentBinding({ agentId, workspaceId: ws, provider: "pi", cyboId: null });
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-rewind-"));
    storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "test.db")), null);
    auth = new CyborgAuth(storage);
    workspaceManager = new WorkspaceManager(storage);
    const broadcast: BroadcastFn = { toWorkspace() {}, toUser() {} };
    const messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
    dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);

    // Minimal AgentManager stand-in: getAgent returns a truthy handle so
    // ensureAgentLoaded short-circuits (no real provider load), and rewind is a spy.
    rewindMock = vi.fn().mockResolvedValue(undefined);
    dispatcher.setAgentManager({
      getAgent: () => ({ id: "live" }),
      rewind: rewindMock,
    } as unknown as AgentManager);

    owner = auth.validateToken(auth.createToken("owner@test.com", "Owner"))!;
    const ws = await dispatch({
      type: "cyborg:create_workspace",
      name: "Rewind WS",
      requestId: "w1",
    });
    workspaceId = (ws[0].payload.workspace as { id: string }).id;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("forwards to agentManager.rewind and replies ok", async () => {
    bindAgent("agent-1", workspaceId);
    const out = await dispatch({
      type: "cyborg:rewind_agent",
      requestId: "r1",
      workspaceId,
      agentId: "agent-1",
      messageId: "msg-42",
      mode: "conversation",
    });

    expect(rewindMock).toHaveBeenCalledWith("agent-1", "msg-42", "conversation");
    const resp = out.find((m) => m.type === "cyborg:rewind_agent_response");
    expect(resp).toBeDefined();
    expect(resp?.payload).toEqual({ requestId: "r1", status: "ok" });
  });

  it("defaults mode to conversation when omitted (only mode pi/cybos support)", async () => {
    bindAgent("agent-1", workspaceId);
    await dispatch({
      type: "cyborg:rewind_agent",
      requestId: "r2",
      workspaceId,
      agentId: "agent-1",
      messageId: "msg-7",
    });

    expect(rewindMock).toHaveBeenCalledWith("agent-1", "msg-7", "conversation");
  });

  it("honors an explicit mode (e.g. Claude files/both)", async () => {
    bindAgent("agent-1", workspaceId);
    await dispatch({
      type: "cyborg:rewind_agent",
      requestId: "r3",
      workspaceId,
      agentId: "agent-1",
      messageId: "msg-9",
      mode: "both",
    });

    expect(rewindMock).toHaveBeenCalledWith("agent-1", "msg-9", "both");
  });

  it("rejects an agent not bound to the workspace (membership/binding gate)", async () => {
    // Bound to a DIFFERENT real workspace — must not be rewindable from this one
    // (a member of WS A cannot rewind an agent that lives in WS B).
    const other = await dispatch({
      type: "cyborg:create_workspace",
      name: "Other WS",
      requestId: "w2",
    });
    const otherWorkspaceId = (other[0].payload.workspace as { id: string }).id;
    bindAgent("agent-foreign", otherWorkspaceId);
    const out = await dispatch({
      type: "cyborg:rewind_agent",
      requestId: "r4",
      workspaceId,
      agentId: "agent-foreign",
      messageId: "msg-1",
    });

    expect(rewindMock).not.toHaveBeenCalled();
    const err = out.find((m) => m.type === "cyborg:error");
    expect(err?.payload.code).toBe("not_found");
    expect(err?.payload.requestId).toBe("r4");
  });

  it("rejects an unknown agent", async () => {
    const out = await dispatch({
      type: "cyborg:rewind_agent",
      requestId: "r5",
      workspaceId,
      agentId: "does-not-exist",
      messageId: "msg-1",
    });

    expect(rewindMock).not.toHaveBeenCalled();
    const err = out.find((m) => m.type === "cyborg:error");
    expect(err?.payload.code).toBe("not_found");
  });

  it("surfaces a provider rewind failure as agent_error", async () => {
    bindAgent("agent-1", workspaceId);
    rewindMock.mockRejectedValueOnce(new Error("rewind target not in tracked conversation"));
    const out = await dispatch({
      type: "cyborg:rewind_agent",
      requestId: "r6",
      workspaceId,
      agentId: "agent-1",
      messageId: "msg-bad",
    });

    const err = out.find((m) => m.type === "cyborg:error");
    expect(err?.payload.code).toBe("agent_error");
    expect(err?.payload.message).toContain("not in tracked conversation");
    expect(err?.payload.requestId).toBe("r6");
  });

  it("reports unavailable when no agent manager is wired", async () => {
    bindAgent("agent-1", workspaceId);
    // Re-create a dispatcher with no agent manager set.
    const broadcast: BroadcastFn = { toWorkspace() {}, toUser() {} };
    const mr = new MessageRouter(storage, workspaceManager, broadcast);
    const bare = new CyborgDispatcher(mr, workspaceManager, storage);
    const out: Emitted[] = [];
    await bare.dispatch(
      {
        type: "cyborg:rewind_agent",
        requestId: "r7",
        workspaceId,
        agentId: "agent-1",
        messageId: "msg-1",
      } as never,
      owner,
      (m) => out.push(m as Emitted),
    );

    const err = out.find((m) => m.type === "cyborg:error");
    expect(err?.payload.code).toBe("unavailable");
  });
});
