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
import { WSInboundMessageSchema } from "../messages.js";

// Regression for the "headless daemon over local session" auth gap: a `cyborg`
// CLI talking directly to a daemon (NOT via the cloud relay) sends
// `{type:"session", message:{type:"cyborg:auth", requestId, token}}` over the
// Paseo WebSocket. Two layers must cooperate or the request silently times out:
//   1. The WS-boundary schema (websocket-server.ts) must ADMIT the cyborg frame
//      so it reaches handleMessage → cyborgDispatcher. The protocol package's
//      WSInboundMessageSchema only knew Paseo session types, so a cyborg:auth
//      frame failed validation and was dropped before reaching the dispatcher.
//   2. The dispatcher must ANSWER cyborg:auth on the local session path with a
//      correlated cyborg:auth_response (valid token) or cyborg:error (bad token).
describe("headless daemon answers cyborg:auth over a local session", () => {
  let storage: DualStorage;
  let auth: CyborgAuth;
  let workspaceManager: WorkspaceManager;
  let messageRouter: MessageRouter;
  let dispatcher: CyborgDispatcher;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-headless-auth-"));
    const dbPath = path.join(tmpDir, "test.db");
    storage = new DualStorage(new CyborgStorage(dbPath), null);
    auth = new CyborgAuth(storage);
    workspaceManager = new WorkspaceManager(storage);
    const broadcast: BroadcastFn = {
      toWorkspace() {},
      toUser() {},
    };
    messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
    dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);
    dispatcher.setCyborgAuth(auth);
  });

  afterEach(() => {
    storage.close();
    const dbPath = path.join(tmpDir, "test.db");
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(`${dbPath}${suffix}`)) unlinkSync(`${dbPath}${suffix}`);
    }
  });

  // Layer 1: the WS envelope schema the daemon validates inbound frames against
  // must let a cyborg:auth frame through instead of rejecting it (which dropped
  // the request and made the CLI hang for 15s).
  it("admits a session-wrapped cyborg:auth frame at the WS boundary", () => {
    const frame = {
      type: "session",
      message: { type: "cyborg:auth", requestId: "creq_1", token: "any" },
    };
    const parsed = WSInboundMessageSchema.safeParse(frame);
    expect(parsed.success).toBe(true);
  });

  // Layer 2a: a valid dev JWT yields a correlated cyborg:auth_response.
  it("answers a valid dev token with cyborg:auth_response (correlated by requestId)", async () => {
    const token = auth.createToken("alice@test.com", "Alice");
    const emitted: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    let captured: unknown = "unset";

    await dispatcher.dispatch(
      { type: "cyborg:auth", token, requestId: "creq_42" },
      null,
      (msg) => emitted.push(msg as { type: string; payload?: Record<string, unknown> }),
      (ctx) => {
        captured = ctx;
      },
    );

    expect(emitted).toHaveLength(1);
    const response = emitted[0]!;
    expect(response.type).toBe("cyborg:auth_response");
    expect(response.payload?.requestId).toBe("creq_42");
    const user = response.payload?.user as { email?: string } | undefined;
    expect(user?.email).toBe("alice@test.com");
    expect(Array.isArray(response.payload?.workspaces)).toBe(true);
    // The session auth context is set so subsequent RPCs are authorized.
    expect(captured).not.toBe("unset");
    expect(captured).not.toBeNull();
  });

  // Layer 2b: a bad token returns a cyborg:error (prompt rejection), NOT a hang.
  it("answers a bad token with cyborg:error instead of hanging", async () => {
    const emitted: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    let setAuthCalled = false;

    await dispatcher.dispatch(
      { type: "cyborg:auth", token: "not-a-valid-jwt", requestId: "creq_bad" },
      null,
      (msg) => emitted.push(msg as { type: string; payload?: Record<string, unknown> }),
      () => {
        setAuthCalled = true;
      },
    );

    expect(emitted).toHaveLength(1);
    const response = emitted[0]!;
    expect(response.type).toBe("cyborg:error");
    expect(response.payload?.code).toBe("unauthenticated");
    // The error must carry the requestId so the CLI can reject (not hang on) it.
    expect(response.payload?.requestId).toBe("creq_bad");
    expect(setAuthCalled).toBe(false);
  });
});
