/* eslint-disable @typescript-eslint/no-explicit-any */
// Launch-critical (#1078 follow-up): the cyborg:send_agent_prompt path frames its
// prompt as a DM ("[DM from …]"), so the cybo's reply is meant for THIS user — NOT
// the cybo's persistent bound channel. handleSendAgentPrompt previously called bare
// routeToAgent, which never armed the per-turn DM guard (dmTurnRecipient); a
// channel-bound cybo then auto-posted its narration + reply into its channel. It must
// route through routeDmTurn so the guard is armed for the turn (same chokepoint the
// local handleDm + the cloud agent_prompt_forward path already use).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

interface Emitted {
  type: string;
  payload: Record<string, unknown>;
}

describe("cyborg:send_agent_prompt arms the DM guard (routeDmTurn, not bare routeToAgent)", () => {
  let tmpDir: string;
  let storage: DualStorage;
  let auth: CyborgAuth;
  let messageRouter: MessageRouter;
  let dispatcher: CyborgDispatcher;
  let owner: CyborgAuthContext;
  let workspaceId: string;
  let channelId: string;

  // Spies recording how the handler routed the turn.
  let routeDmTurnCalls: Array<{
    agentId: string;
    recipient: { userId: string; email: string };
    rawPrompt?: string;
  }>;
  let routeToAgentCalls: string[];

  const agentId = "agent-sched";

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "send-prompt-dm-guard-"));
    storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "test.db")), null);
    auth = new CyborgAuth(storage);
    const workspaceManager = new WorkspaceManager(storage);
    const broadcast: BroadcastFn = { toWorkspace() {}, toUser() {} };
    messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
    dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);

    owner = auth.validateToken(auth.createToken("alice@test.com", "Alice"))!;
    workspaceId = workspaceManager.createWorkspace("Prompt WS", owner.user.id).id;
    channelId = storage.getChannels(workspaceId).find((c) => c.name === "general")!.id;

    // A channel-bound, NON-ephemeral cybo session owned by the prompter (the bug's
    // setup): bare routeToAgent would let its reply leak into `channelId`.
    storage.createAgentBinding({
      agentId,
      workspaceId,
      channelId,
      provider: "pi",
      initiatedBy: owner.user.id,
    });

    routeDmTurnCalls = [];
    routeToAgentCalls = [];
    (messageRouter as any).routeDmTurn = async (
      id: string,
      recipient: { userId: string; email: string },
      _prompt: unknown,
      opts?: { rawPrompt?: string },
    ) => {
      routeDmTurnCalls.push({ agentId: id, recipient, rawPrompt: opts?.rawPrompt });
    };
    (messageRouter as any).routeToAgent = async (id: string) => {
      routeToAgentCalls.push(id);
    };
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function dispatch(msg: Record<string, unknown>): Promise<Emitted[]> {
    const out: Emitted[] = [];
    await dispatcher.dispatch(msg as never, owner, (m) => out.push(m as Emitted));
    return out;
  }

  it("routes the DM-intent prompt through routeDmTurn with the prompter as recipient", async () => {
    const out = await dispatch({
      type: "cyborg:send_agent_prompt",
      requestId: "p1",
      workspaceId,
      agentId,
      prompt: "reply privately, do NOT post in any channel",
    });

    // Armed the per-turn DM guard via routeDmTurn — never bare routeToAgent.
    expect(routeDmTurnCalls).toHaveLength(1);
    expect(routeToAgentCalls).toHaveLength(0);
    expect(routeDmTurnCalls[0].agentId).toBe(agentId);
    expect(routeDmTurnCalls[0].recipient.userId).toBe(owner.user.id);
    expect(routeDmTurnCalls[0].recipient.email).toBe(owner.user.email);
    // The raw (unframed) prompt is threaded for the visible transcript.
    expect(routeDmTurnCalls[0].rawPrompt).toBe("reply privately, do NOT post in any channel");

    // The handler still acknowledges the routing.
    const ack = out.find((m) => m.type === "cyborg:send_agent_prompt_response");
    expect(ack).toBeDefined();
    expect(ack!.payload.status).toBe("routed");
  });
});
