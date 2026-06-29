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
import {
  registerActionKind,
  signAction,
  unregisterActionKind,
  type ActionHandler,
  type SignedActionPayload,
} from "./signed-actions.js";

// The dual-routed cyborg:message_action handler (dispatcher half). The relay
// half mirrors it; this exercises the shared verify → registry → broadcast flow.
describe("handleMessageAction (#600, dispatcher)", () => {
  let storage: DualStorage;
  let auth: CyborgAuth;
  let dispatcher: CyborgDispatcher;
  let broadcasted: any[];
  let tmpDir: string;
  let calls: Array<{ payload: SignedActionPayload; actorId: string }>;

  const KIND = "test_kind";

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-msgaction-"));
    storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "test.db")), null);
    auth = new CyborgAuth(storage);
    const workspaceManager = new WorkspaceManager(storage);
    broadcasted = [];
    const broadcast: BroadcastFn = {
      toWorkspace: (_w, m) => broadcasted.push(m),
      toUser: (_u, m) => broadcasted.push(m),
    };
    const messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
    dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);

    calls = [];
    const handler: ActionHandler = async (payload, actionCtx) => {
      calls.push({ payload, actorId: actionCtx.actorId });
      return {
        ok: true,
        card: {
          kind: "approval",
          title: "resolved",
          toolName: "bash",
          detail: null,
          agentName: "Apex",
          resolution: { state: "approved", byUserId: actionCtx.actorId, at: 1 },
        },
      };
    };
    registerActionKind(KIND, handler);
  });

  afterEach(() => {
    unregisterActionKind(KIND);
    storage.close();
    for (const s of ["", "-wal", "-shm"]) {
      const p = path.join(tmpDir, `test.db${s}`);
      if (existsSync(p)) unlinkSync(p);
    }
  });

  function ctx(email: string, name: string) {
    return auth.validateToken(auth.createToken(email, name))!;
  }

  async function dispatch(msg: Record<string, unknown>, authCtx: ReturnType<typeof ctx>) {
    const emitted: any[] = [];
    await dispatcher.dispatch(msg as any, authCtx, (m) => emitted.push(m));
    return emitted;
  }

  function token(actor: string, over: Partial<SignedActionPayload> = {}): string {
    // No secret arg → the dispatcher verifies with the same resolved dev secret.
    return signAction({
      v: 1,
      k: KIND,
      mid: "m1",
      aid: "approve",
      act: actor,
      exp: Math.floor(Date.now() / 1000) + 3600,
      p: {},
      ...over,
    });
  }

  it("a valid token routes to the registry and broadcasts the resolved card", async () => {
    const alice = ctx("alice@test.com", "Alice");
    const emitted = await dispatch(
      {
        type: "cyborg:message_action",
        requestId: "r1",
        workspaceId: "ws1",
        messageId: "m1",
        actionId: "approve",
        token: token(alice.user.id),
      },
      alice,
    );
    expect(calls).toHaveLength(1);
    const resp = emitted.find((e) => e.type === "cyborg:message_action_response");
    expect(resp.payload).toMatchObject({ requestId: "r1", ok: true });
    const updated = broadcasted.find((b) => b.type === "cyborg:message_card_updated");
    expect(updated.payload.messageId).toBe("m1");
    expect(updated.payload.card.kind).toBe("approval");
    expect(updated.payload.card.resolution.state).toBe("approved");
  });

  it("a token bound to a DIFFERENT actor is rejected (registry NOT called)", async () => {
    const alice = ctx("alice@test.com", "Alice");
    const emitted = await dispatch(
      {
        type: "cyborg:message_action",
        requestId: "r2",
        workspaceId: "ws1",
        messageId: "m1",
        actionId: "approve",
        token: token("someone_else"),
      },
      alice,
    );
    expect(calls).toHaveLength(0);
    const resp = emitted.find((e) => e.type === "cyborg:message_action_response");
    expect(resp.payload).toMatchObject({ ok: false, error: "invalid_or_expired" });
    expect(broadcasted.find((b) => b.type === "cyborg:message_card_updated")).toBeUndefined();
  });

  it("a token whose aid doesn't match the clicked button is rejected", async () => {
    const alice = ctx("alice@test.com", "Alice");
    const emitted = await dispatch(
      {
        type: "cyborg:message_action",
        requestId: "r3",
        workspaceId: "ws1",
        messageId: "m1",
        actionId: "deny", // token was signed for aid "approve"
        token: token(alice.user.id),
      },
      alice,
    );
    expect(calls).toHaveLength(0);
    const resp = emitted.find((e) => e.type === "cyborg:message_action_response");
    expect(resp.payload).toMatchObject({ ok: false, error: "invalid_or_expired" });
  });

  it("an unknown action kind is rejected without crashing", async () => {
    const alice = ctx("alice@test.com", "Alice");
    const emitted = await dispatch(
      {
        type: "cyborg:message_action",
        requestId: "r4",
        workspaceId: "ws1",
        messageId: "m1",
        actionId: "approve",
        token: token(alice.user.id, { k: "no_such_kind" }),
      },
      alice,
    );
    expect(calls).toHaveLength(0);
    const resp = emitted.find((e) => e.type === "cyborg:message_action_response");
    expect(resp.payload).toMatchObject({ ok: false, error: "unknown_action_kind" });
  });
});
