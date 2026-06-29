// Cloud `/resume` → "Local import" tab regression lock.
//
// The relay forwards the Paseo-native local-import SCAN
// (`fetch_recent_provider_sessions_request`) into the daemon via relay_rpc.inner →
// CyborgDispatcher.dispatch. Before the fix, dispatch() dropped EVERY non-`cyborg:`
// message (early `return undefined`), so the daemon never answered and the relay's
// default branch replied `unsupported: fetch_recent_provider_sessions_request`.
// These tests lock that the dispatcher now ANSWERS the forwarded scan with a
// `fetch_recent_provider_sessions_response` (the exact wire shape the UI resolves by
// requestId) — and that an unauthenticated forward is rejected, never silently
// dropped.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Logger } from "pino";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { CyborgAuth } from "./auth.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MessageRouter } from "./message-router.js";
import { CyborgDispatcher } from "./dispatcher.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";

interface EmittedMessage {
  type: string;
  payload?: { requestId?: string; entries?: unknown[] };
}

describe("dispatcher answers the forwarded local-import scan (cloud /resume)", () => {
  let tmpDir: string;
  let storage: DualStorage;
  let dispatcher: CyborgDispatcher;
  let owner: NonNullable<ReturnType<CyborgAuth["validateToken"]>>;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "fetch-recent-scan-"));
    storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "t.db")), null);
    const auth = new CyborgAuth(storage);
    const workspaceManager = new WorkspaceManager(storage);
    const router = new MessageRouter(storage, workspaceManager, {
      toWorkspace() {},
      toUser() {},
    });
    dispatcher = new CyborgDispatcher(router, workspaceManager, storage);

    // The scan reads on-disk transcripts via the agent manager + storage. Empty
    // stubs are enough to prove the message is HANDLED (answered), not dropped.
    dispatcher.setAgentManager({
      listAgents: () => [],
      listImportablePersistedAgents: async () => [],
    } as unknown as AgentManager);
    dispatcher.setAgentStorage(
      { list: async () => [] } as unknown as AgentStorage,
      { error() {}, info() {}, warn() {}, debug() {} } as unknown as Logger,
    );

    owner = auth.validateToken(auth.createToken("o@test.com", "Owner"))!;
  });

  afterEach(() => {
    storage.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits fetch_recent_provider_sessions_response (not dropped, not unsupported)", async () => {
    const out: EmittedMessage[] = [];
    await dispatcher.dispatch(
      { type: "fetch_recent_provider_sessions_request", requestId: "scan-1" } as never,
      owner,
      (m) => out.push(m as EmittedMessage),
    );
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("fetch_recent_provider_sessions_response");
    expect(out[0].payload?.requestId).toBe("scan-1");
    expect(out[0].payload?.entries).toEqual([]);
  });

  it("rejects an unauthenticated forward instead of dropping it silently", () => {
    const out: EmittedMessage[] = [];
    dispatcher.dispatch(
      { type: "fetch_recent_provider_sessions_request", requestId: "scan-2" } as never,
      null,
      (m) => out.push(m as EmittedMessage),
    );
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("cyborg:error");
  });
});
