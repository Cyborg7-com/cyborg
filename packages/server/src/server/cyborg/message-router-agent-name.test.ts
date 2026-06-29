// Regression: an agent's channel/DM message used to broadcast WITHOUT a fromName,
// so the client fell back to `message.fromId.slice(0, 8)` and rendered the raw
// 8-hex agent id (e.g. "85f727c0") with an "Agent" badge instead of the cybo's
// real name (e.g. "Apex"). Humans were unaffected because handleChannelMessage
// always put fromName in the broadcast. The fix carries the resolved cybo name
// in the live broadcast payload, matching what the human path and the persisted
// row already do.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MessageRouter, type BroadcastFn } from "./message-router.js";

interface CapturedBroadcast {
  type: string;
  payload: { fromId: string; fromType: string; fromName?: string; channelId?: string };
}

describe("MessageRouter — agent message displays the cybo's real name", () => {
  let storage: DualStorage;
  let workspaceManager: WorkspaceManager;
  let router: MessageRouter;
  let broadcasted: CapturedBroadcast[];
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-agent-name-"));
    storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "test.db")), null);
    workspaceManager = new WorkspaceManager(storage);
    broadcasted = [];
    const broadcast: BroadcastFn = {
      toWorkspace(_workspaceId: string, msg: unknown) {
        broadcasted.push(msg as CapturedBroadcast);
      },
      toUser(_userId: string, msg: unknown) {
        broadcasted.push(msg as CapturedBroadcast);
      },
    };
    router = new MessageRouter(storage, workspaceManager, broadcast);
  });

  afterEach(() => {
    storage.close();
    const dbPath = path.join(tmpDir, "test.db");
    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(`${dbPath}-wal`)) unlinkSync(`${dbPath}-wal`);
    if (existsSync(`${dbPath}-shm`)) unlinkSync(`${dbPath}-shm`);
  });

  function setupCyboAgent(): { agentId: string; workspaceId: string; channelId: string } {
    const agentId = "85f727c0";
    const owner = storage.upsertUser("owner@test.dev", "Owner");
    const workspace = storage.createWorkspace("Name Test", owner.id);
    const channel = storage.createChannel(workspace.id, "general", owner.id);
    const cybo = storage.createCybo({
      workspaceId: workspace.id,
      slug: "apex",
      name: "Apex",
      soul: "You are Apex.",
      provider: "pi",
      createdBy: owner.id,
    });
    storage.createAgentBinding({
      agentId,
      workspaceId: workspace.id,
      provider: "pi",
      cyboId: cybo.id,
      initiatedBy: null,
    });
    return { agentId, workspaceId: workspace.id, channelId: channel.id };
  }

  it("broadcasts the cybo's real name as fromName for a channel message", () => {
    const { agentId, workspaceId, channelId } = setupCyboAgent();

    router.handleAgentMessage(agentId, workspaceId, channelId, null, "hello from apex");

    const channelMsg = broadcasted.find((b) => b.type === "cyborg:channel_message_broadcast");
    expect(channelMsg).toBeDefined();
    expect(channelMsg?.payload.fromType).toBe("agent");
    expect(channelMsg?.payload.fromId).toBe(agentId);
    // The bug rendered the raw id; the broadcast must carry the resolved name so
    // the client never falls back to fromId.slice(0, 8).
    expect(channelMsg?.payload.fromName).toBe("Apex");
    expect(channelMsg?.payload.fromName).not.toBe(agentId);
  });

  it("broadcasts the cybo's real name as fromName for a DM", () => {
    const { agentId, workspaceId } = setupCyboAgent();
    const recipient = storage.upsertUser("seb@test.dev", "Seb");

    router.handleAgentMessage(agentId, workspaceId, null, recipient.id, "dm from apex");

    const dm = broadcasted.find((b) => b.type === "cyborg:dm_broadcast");
    expect(dm).toBeDefined();
    expect(dm?.payload.fromType).toBe("agent");
    expect(dm?.payload.fromName).toBe("Apex");
  });

  it("persists the resolved name so history matches the live broadcast", () => {
    const { agentId, workspaceId, channelId } = setupCyboAgent();

    router.handleAgentMessage(agentId, workspaceId, channelId, null, "persisted hello");

    const messages = storage.getMessages({ channelId, limit: 10 });
    const stored = messages.find((m) => m.from_id === agentId);
    expect(stored?.from_name).toBe("Apex");
  });
});
