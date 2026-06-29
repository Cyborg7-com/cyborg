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

// Reload/restart a session (#592): the dispatcher handler for
// cyborg:reload_session must forward to Paseo's agentManager.reloadAgentSession
// (passing rehydrateFromDisk), gated by the agent binding (workspace
// membership), and report the outcome. The cancel→close→resume + rehydrate
// mechanics are Paseo's; here we prove the cyborg surface wires through and
// enforces the binding/auth.

interface Emitted {
  type: string;
  payload: Record<string, unknown>;
}

describe("cyborg:reload_session (dispatcher, local mode)", () => {
  let storage: DualStorage;
  let auth: CyborgAuth;
  let workspaceManager: WorkspaceManager;
  let dispatcher: CyborgDispatcher;
  let tmpDir: string;
  let owner: CyborgAuthContext;
  let workspaceId: string;
  let reloadMock: ReturnType<typeof vi.fn>;

  async function dispatch(msg: Record<string, unknown>, who = owner): Promise<Emitted[]> {
    const out: Emitted[] = [];
    await dispatcher.dispatch(msg as never, who, (m) => out.push(m as Emitted));
    return out;
  }

  function bindAgent(agentId: string, ws: string): void {
    storage.createAgentBinding({ agentId, workspaceId: ws, provider: "pi", cyboId: null });
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-reload-"));
    storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "test.db")), null);
    auth = new CyborgAuth(storage);
    workspaceManager = new WorkspaceManager(storage);
    const broadcast: BroadcastFn = { toWorkspace() {}, toUser() {} };
    const messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
    dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);

    // getAgent returns a truthy handle so ensureAgentLoaded short-circuits;
    // reloadAgentSession is a spy.
    reloadMock = vi.fn().mockResolvedValue({ id: "live" });
    dispatcher.setAgentManager({
      getAgent: () => ({ id: "live" }),
      reloadAgentSession: reloadMock,
    } as unknown as AgentManager);

    owner = auth.validateToken(auth.createToken("owner@test.com", "Owner"))!;
    const ws = await dispatch({
      type: "cyborg:create_workspace",
      name: "Reload WS",
      requestId: "w1",
    });
    workspaceId = (ws[0].payload.workspace as { id: string }).id;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("forwards to reloadAgentSession with rehydrateFromDisk and replies ok", async () => {
    bindAgent("agent-1", workspaceId);
    const out = await dispatch({
      type: "cyborg:reload_session",
      requestId: "r1",
      workspaceId,
      agentId: "agent-1",
      rehydrateFromDisk: true,
    });

    expect(reloadMock).toHaveBeenCalledWith("agent-1", undefined, { rehydrateFromDisk: true });
    const resp = out.find((m) => m.type === "cyborg:reload_session_response");
    expect(resp).toBeDefined();
    expect(resp?.payload).toEqual({ requestId: "r1", status: "ok" });
  });

  it("defaults rehydrateFromDisk to false when omitted", async () => {
    bindAgent("agent-1", workspaceId);
    await dispatch({
      type: "cyborg:reload_session",
      requestId: "r2",
      workspaceId,
      agentId: "agent-1",
    });

    expect(reloadMock).toHaveBeenCalledWith("agent-1", undefined, { rehydrateFromDisk: false });
  });

  it("rejects an agent bound to a different workspace (binding gate)", async () => {
    const other = await dispatch({
      type: "cyborg:create_workspace",
      name: "Other WS",
      requestId: "w2",
    });
    const otherWorkspaceId = (other[0].payload.workspace as { id: string }).id;
    bindAgent("agent-foreign", otherWorkspaceId);
    const out = await dispatch({
      type: "cyborg:reload_session",
      requestId: "r3",
      workspaceId,
      agentId: "agent-foreign",
    });

    expect(reloadMock).not.toHaveBeenCalled();
    const err = out.find((m) => m.type === "cyborg:error");
    expect(err?.payload.code).toBe("not_found");
    expect(err?.payload.requestId).toBe("r3");
  });

  it("rejects an unknown agent", async () => {
    const out = await dispatch({
      type: "cyborg:reload_session",
      requestId: "r4",
      workspaceId,
      agentId: "does-not-exist",
    });
    expect(reloadMock).not.toHaveBeenCalled();
    expect(out.find((m) => m.type === "cyborg:error")?.payload.code).toBe("not_found");
  });

  it("surfaces a reload failure as agent_error", async () => {
    bindAgent("agent-1", workspaceId);
    reloadMock.mockRejectedValueOnce(new Error("provider resume failed"));
    const out = await dispatch({
      type: "cyborg:reload_session",
      requestId: "r5",
      workspaceId,
      agentId: "agent-1",
      rehydrateFromDisk: true,
    });

    const err = out.find((m) => m.type === "cyborg:error");
    expect(err?.payload.code).toBe("agent_error");
    expect(err?.payload.message).toContain("provider resume failed");
    expect(err?.payload.requestId).toBe("r5");
  });

  it("reports unavailable when no agent manager is wired", async () => {
    bindAgent("agent-1", workspaceId);
    const broadcast: BroadcastFn = { toWorkspace() {}, toUser() {} };
    const mr = new MessageRouter(storage, workspaceManager, broadcast);
    const bare = new CyborgDispatcher(mr, workspaceManager, storage);
    const out: Emitted[] = [];
    await bare.dispatch(
      {
        type: "cyborg:reload_session",
        requestId: "r6",
        workspaceId,
        agentId: "agent-1",
      } as never,
      owner,
      (m) => out.push(m as Emitted),
    );
    expect(out.find((m) => m.type === "cyborg:error")?.payload.code).toBe("unavailable");
  });
});
