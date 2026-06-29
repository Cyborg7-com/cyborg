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

describe("Cyborg7 Phase 0 — end-to-end workspace flow", () => {
  let storage: DualStorage;
  let auth: CyborgAuth;
  let workspaceManager: WorkspaceManager;
  let messageRouter: MessageRouter;
  let dispatcher: CyborgDispatcher;
  let broadcasted: unknown[];
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-test-"));
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
    messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
    dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);
  });

  afterEach(() => {
    storage.close();
    const dbPath = path.join(tmpDir, "test.db");
    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(`${dbPath}-wal`)) unlinkSync(`${dbPath}-wal`);
    if (existsSync(`${dbPath}-shm`)) unlinkSync(`${dbPath}-shm`);
  });

  it("creates a JWT, authenticates, and returns user context", () => {
    const token = auth.createToken("alice@test.com", "Alice");
    const ctx = auth.validateToken(token);

    expect(ctx).not.toBeNull();
    expect(ctx!.user.email).toBe("alice@test.com");
    expect(ctx!.user.name).toBe("Alice");
  });

  it("creates a workspace with default #general channel", async () => {
    const token = auth.createToken("alice@test.com", "Alice");
    const ctx = auth.validateToken(token)!;
    const emitted: unknown[] = [];
    const emit = (msg: unknown) => emitted.push(msg);

    await dispatcher.dispatch(
      { type: "cyborg:create_workspace", name: "Test Workspace", requestId: "r1" },
      ctx,
      emit,
    );

    expect(emitted).toHaveLength(1);
    const resp = emitted[0] as {
      type: string;
      payload: { workspace: { id: string; name: string } };
    };
    expect(resp.type).toBe("cyborg:create_workspace_response");
    expect(resp.payload.workspace.name).toBe("Test Workspace");

    // Verify #general channel was auto-created
    await dispatcher.dispatch(
      { type: "cyborg:fetch_channels", workspaceId: resp.payload.workspace.id, requestId: "r2" },
      ctx,
      emit,
    );

    const channelsResp = emitted[1] as {
      type: string;
      payload: { channels: Array<{ name: string }> };
    };
    expect(channelsResp.payload.channels).toHaveLength(1);
    expect(channelsResp.payload.channels[0].name).toBe("general");
  });

  it("sends a channel message and fetches it back", async () => {
    const token = auth.createToken("alice@test.com", "Alice");
    const ctx = auth.validateToken(token)!;
    const emitted: unknown[] = [];
    const emit = (msg: unknown) => emitted.push(msg);

    // Create workspace
    await dispatcher.dispatch(
      { type: "cyborg:create_workspace", name: "Chat Test", requestId: "r1" },
      ctx,
      emit,
    );
    const wsResp = emitted[0] as { payload: { workspace: { id: string } } };
    const workspaceId = wsResp.payload.workspace.id;

    // Get channels
    await dispatcher.dispatch(
      { type: "cyborg:fetch_channels", workspaceId, requestId: "r2" },
      ctx,
      emit,
    );
    const chResp = emitted[1] as { payload: { channels: Array<{ id: string }> } };
    const channelId = chResp.payload.channels[0].id;

    // Send a message
    await dispatcher.dispatch(
      {
        type: "cyborg:channel_message",
        workspaceId,
        channelId,
        text: "Hello from Phase 0!",
      },
      ctx,
      emit,
    );

    // Verify message was persisted directly
    const directMessages = storage.getMessages({ channelId });
    expect(directMessages).toHaveLength(1);

    // Fetch messages via dispatcher
    await dispatcher.dispatch(
      {
        type: "cyborg:fetch_messages",
        workspaceId,
        channelId,
        requestId: "r3",
      },
      ctx,
      emit,
    );

    const msgResp = emitted[emitted.length - 1] as {
      type: string;
      payload: { messages: Array<{ text: string; fromId: string }> };
    };
    expect(msgResp.type).toBe("cyborg:fetch_messages_response");
    expect(msgResp.payload.messages).toHaveLength(1);
    expect(msgResp.payload.messages[0].text).toBe("Hello from Phase 0!");
  });

  it("two users in the same workspace see the same messages", async () => {
    const tokenA = auth.createToken("alice@test.com", "Alice");
    const tokenB = auth.createToken("bob@test.com", "Bob");
    const ctxA = auth.validateToken(tokenA)!;
    const ctxB = auth.validateToken(tokenB)!;
    const emittedA: unknown[] = [];
    const emittedB: unknown[] = [];

    // Alice creates workspace
    await dispatcher.dispatch(
      { type: "cyborg:create_workspace", name: "Shared", requestId: "r1" },
      ctxA,
      (msg) => emittedA.push(msg),
    );
    const wsResp = emittedA[0] as { payload: { workspace: { id: string } } };
    const workspaceId = wsResp.payload.workspace.id;

    // Alice invites Bob
    await dispatcher.dispatch(
      {
        type: "cyborg:invite_member",
        workspaceId,
        email: "bob@test.com",
        role: "member",
        requestId: "r2",
      },
      ctxA,
      (msg) => emittedA.push(msg),
    );

    // Get channel
    await dispatcher.dispatch(
      { type: "cyborg:fetch_channels", workspaceId, requestId: "r3" },
      ctxA,
      (msg) => emittedA.push(msg),
    );
    const chResp = emittedA[emittedA.length - 1] as {
      payload: { channels: Array<{ id: string }> };
    };
    const channelId = chResp.payload.channels[0].id;

    // Alice sends a message
    await dispatcher.dispatch(
      {
        type: "cyborg:channel_message",
        workspaceId,
        channelId,
        text: "Hey Bob!",
      },
      ctxA,
      (msg) => emittedA.push(msg),
    );

    // Bob sends a message
    await dispatcher.dispatch(
      {
        type: "cyborg:channel_message",
        workspaceId,
        channelId,
        text: "Hey Alice!",
      },
      ctxB,
      (msg) => emittedB.push(msg),
    );

    // Bob fetches messages — should see both
    await dispatcher.dispatch(
      { type: "cyborg:fetch_messages", workspaceId, channelId, requestId: "r4" },
      ctxB,
      (msg) => emittedB.push(msg),
    );

    const msgResp = emittedB[emittedB.length - 1] as {
      type: string;
      payload: { messages: Array<{ text: string }> };
    };
    expect(msgResp.payload.messages).toHaveLength(2);
    const texts = msgResp.payload.messages.map((m) => m.text).sort();
    expect(texts).toEqual(["Hey Alice!", "Hey Bob!"]);
  });

  it("creates and fetches tasks", async () => {
    const token = auth.createToken("alice@test.com", "Alice");
    const ctx = auth.validateToken(token)!;
    const emitted: unknown[] = [];
    const emit = (msg: unknown) => emitted.push(msg);

    // Create workspace
    await dispatcher.dispatch(
      { type: "cyborg:create_workspace", name: "Tasks Test", requestId: "r1" },
      ctx,
      emit,
    );
    const wsResp = emitted[0] as { payload: { workspace: { id: string } } };
    const workspaceId = wsResp.payload.workspace.id;

    // Create a task
    await dispatcher.dispatch(
      {
        type: "cyborg:create_task",
        workspaceId,
        title: "Implement Phase 1",
        description: "Add PI agent",
        requestId: "r2",
      },
      ctx,
      emit,
    );

    const taskResp = emitted[1] as {
      type: string;
      payload: { task: { id: string; title: string; status: string } };
    };
    expect(taskResp.type).toBe("cyborg:create_task_response");
    expect(taskResp.payload.task.title).toBe("Implement Phase 1");
    expect(taskResp.payload.task.status).toBe("pending");

    // Update task status
    await dispatcher.dispatch(
      {
        type: "cyborg:update_task",
        workspaceId,
        taskId: taskResp.payload.task.id,
        status: "in_progress",
        requestId: "r3",
      },
      ctx,
      emit,
    );

    // Fetch tasks
    await dispatcher.dispatch(
      { type: "cyborg:fetch_tasks", workspaceId, requestId: "r4" },
      ctx,
      emit,
    );

    const tasksResp = emitted[emitted.length - 1] as {
      type: string;
      payload: { tasks: Array<{ status: string }> };
    };
    expect(tasksResp.payload.tasks).toHaveLength(1);
    expect(tasksResp.payload.tasks[0].status).toBe("in_progress");
  });

  it("rejects unauthenticated requests", () => {
    const emitted: unknown[] = [];
    const result = dispatcher.dispatch(
      { type: "cyborg:create_workspace", name: "Nope", requestId: "r1" },
      null,
      (msg) => emitted.push(msg),
    );

    expect(result).toBeUndefined();
    expect(emitted).toHaveLength(1);
    const err = emitted[0] as { type: string; payload: { code: string } };
    expect(err.type).toBe("cyborg:error");
    expect(err.payload.code).toBe("unauthenticated");
  });

  it("ignores non-cyborg messages", () => {
    const result = dispatcher.dispatch({ type: "agent_start" }, null, () => {});
    expect(result).toBeUndefined();
  });
});
