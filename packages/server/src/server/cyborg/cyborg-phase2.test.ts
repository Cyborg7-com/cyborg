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

function filterBroadcasts(msgs: unknown[], type: string, text: string): unknown[] {
  return msgs.filter((b: any) => b.type === type && b.payload?.text === text);
}

describe("Cyborg7 Phase 2 — permissions, roles, and rate limiting", () => {
  let storage: DualStorage;
  let auth: CyborgAuth;
  let workspaceManager: WorkspaceManager;
  let dispatcher: CyborgDispatcher;
  let broadcasted: unknown[];
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-phase2-"));
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
    const messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
    dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);
  });

  afterEach(() => {
    storage.close();
    const dbPath = path.join(tmpDir, "test.db");
    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(`${dbPath}-wal`)) unlinkSync(`${dbPath}-wal`);
    if (existsSync(`${dbPath}-shm`)) unlinkSync(`${dbPath}-shm`);
  });

  function ctx(email: string, name: string) {
    return auth.validateToken(auth.createToken(email, name))!;
  }

  async function dispatch(msg: Record<string, unknown>, authCtx: ReturnType<typeof ctx>) {
    const emitted: unknown[] = [];
    await dispatcher.dispatch(msg as any, authCtx, (m) => emitted.push(m));
    return emitted;
  }

  async function setupWorkspaceWithRoles(settings?: Record<string, unknown>) {
    const owner = ctx("owner@test.com", "Owner");

    const wsResp = await dispatch(
      { type: "cyborg:create_workspace", name: "Perm Test", requestId: "ws", settings },
      owner,
    );
    const workspaceId = (wsResp[0] as any).payload.workspace.id;

    // Invite admin, member, viewer
    const admin = ctx("admin@test.com", "Admin");
    const member = ctx("member@test.com", "Member");
    const viewer = ctx("viewer@test.com", "Viewer");

    await dispatch(
      {
        type: "cyborg:invite_member",
        workspaceId,
        email: "admin@test.com",
        role: "admin",
        requestId: "inv1",
      },
      owner,
    );
    await dispatch(
      {
        type: "cyborg:invite_member",
        workspaceId,
        email: "member@test.com",
        role: "member",
        requestId: "inv2",
      },
      owner,
    );
    await dispatch(
      {
        type: "cyborg:invite_member",
        workspaceId,
        email: "viewer@test.com",
        role: "viewer",
        requestId: "inv3",
      },
      owner,
    );

    // Get #general channel
    const chResp = await dispatch(
      { type: "cyborg:fetch_channels", workspaceId, requestId: "ch" },
      owner,
    );
    const channelId = (chResp[0] as any).payload.channels[0].id;

    return { workspaceId, channelId, owner, admin, member, viewer };
  }

  // ─── Permission matrix tests ────────────────────────────────────

  describe("send messages", () => {
    it("owner, admin, member can send; viewer cannot", async () => {
      const { workspaceId, channelId, owner, admin, member, viewer } =
        await setupWorkspaceWithRoles();

      for (const user of [owner, admin, member]) {
        broadcasted = [];
        await dispatch(
          { type: "cyborg:channel_message", workspaceId, channelId, text: "hi" },
          user,
        );
        expect(broadcasted.length).toBeGreaterThan(0);
      }

      broadcasted = [];
      await dispatch(
        { type: "cyborg:channel_message", workspaceId, channelId, text: "blocked" },
        viewer,
      );
      // Viewer message should not be broadcast (silently dropped by message router)
      const viewerMsgs = filterBroadcasts(
        broadcasted,
        "cyborg:channel_message_broadcast",
        "blocked",
      );
      expect(viewerMsgs).toHaveLength(0);
    });
  });

  describe("create tasks", () => {
    it("owner, admin, member can create; viewer cannot", async () => {
      const { workspaceId, owner, admin, member, viewer } = await setupWorkspaceWithRoles();

      for (const user of [owner, admin, member]) {
        const resp = await dispatch(
          {
            type: "cyborg:create_task",
            workspaceId,
            title: "Task",
            requestId: `t-${user.user.email}`,
          },
          user,
        );
        expect((resp[0] as any).type).toBe("cyborg:create_task_response");
      }

      const resp = await dispatch(
        { type: "cyborg:create_task", workspaceId, title: "Blocked", requestId: "t-viewer" },
        viewer,
      );
      expect((resp[0] as any).type).toBe("cyborg:error");
      expect((resp[0] as any).payload.code).toBe("forbidden");
    });

    // Tasks Phase 2 (watcher): a task created via the daemon (UI or a cybo's
    // cyborg7_create_task) must persist the channel binding + board priority the
    // request carries. Before the fix handleCreateTask dropped both, so a watcher
    // cybo's channel/priority were silently lost.
    it("create_task persists channelId + priority end to end", async () => {
      const { workspaceId, channelId, owner } = await setupWorkspaceWithRoles();

      const resp = await dispatch(
        {
          type: "cyborg:create_task",
          workspaceId,
          title: "Watched task",
          channelId,
          priority: "high",
          requestId: "t-cp",
        },
        owner,
      );
      expect((resp[0] as any).type).toBe("cyborg:create_task_response");

      // Read the persisted row back through storage — the create response is one
      // thing, what landed in the store is the truth this asserts.
      const stored = storage.getTasks(workspaceId);
      expect(stored).toHaveLength(1);
      expect(stored[0].title).toBe("Watched task");
      expect(stored[0].channel_id).toBe(channelId);
      expect(stored[0].priority).toBe("high");
    });
  });

  describe("create channels", () => {
    it("owner, admin, member can create; viewer cannot", async () => {
      const { workspaceId, owner, admin, member, viewer } = await setupWorkspaceWithRoles();

      for (const [user, name] of [
        [owner, "ch-owner"],
        [admin, "ch-admin"],
        [member, "ch-member"],
      ] as const) {
        const resp = await dispatch(
          { type: "cyborg:create_channel", workspaceId, name, requestId: `cc-${name}` },
          user as any,
        );
        expect((resp[0] as any).type).toBe("cyborg:create_channel_response");
      }

      const resp = await dispatch(
        { type: "cyborg:create_channel", workspaceId, name: "blocked", requestId: "cc-viewer" },
        viewer,
      );
      expect((resp[0] as any).type).toBe("cyborg:error");
    });
  });

  describe("invite members", () => {
    it("owner, admin can invite; member, viewer cannot", async () => {
      const { workspaceId, owner, admin, member, viewer } = await setupWorkspaceWithRoles();

      const resp1 = await dispatch(
        { type: "cyborg:invite_member", workspaceId, email: "new1@test.com", requestId: "i1" },
        owner,
      );
      expect((resp1[0] as any).type).toBe("cyborg:invite_member_response");

      const resp2 = await dispatch(
        { type: "cyborg:invite_member", workspaceId, email: "new2@test.com", requestId: "i2" },
        admin,
      );
      expect((resp2[0] as any).type).toBe("cyborg:invite_member_response");

      const resp3 = await dispatch(
        { type: "cyborg:invite_member", workspaceId, email: "new3@test.com", requestId: "i3" },
        member,
      );
      expect((resp3[0] as any).type).toBe("cyborg:error");

      const resp4 = await dispatch(
        { type: "cyborg:invite_member", workspaceId, email: "new4@test.com", requestId: "i4" },
        viewer,
      );
      expect((resp4[0] as any).type).toBe("cyborg:error");
    });
  });

  describe("create agents", () => {
    it("owner, admin can create agents by default; member cannot", async () => {
      const { workspaceId, owner, admin, member } = await setupWorkspaceWithRoles();

      // Owner can create (but no agent manager, so it returns "unavailable")
      const resp1 = await dispatch(
        {
          type: "cyborg:create_agent",
          workspaceId,
          provider: "claude",
          cwd: "/tmp",
          requestId: "a1",
        },
        owner,
      );
      expect((resp1[0] as any).payload.code).toBe("unavailable"); // no agent manager wired

      // Admin can create
      const resp2 = await dispatch(
        {
          type: "cyborg:create_agent",
          workspaceId,
          provider: "claude",
          cwd: "/tmp",
          requestId: "a2",
        },
        admin,
      );
      expect((resp2[0] as any).payload.code).toBe("unavailable");

      // Member cannot by default
      const resp3 = await dispatch(
        {
          type: "cyborg:create_agent",
          workspaceId,
          provider: "claude",
          cwd: "/tmp",
          requestId: "a3",
        },
        member,
      );
      expect((resp3[0] as any).type).toBe("cyborg:error");
      expect((resp3[0] as any).payload.code).toBe("forbidden");
    });

    it("member can create agents when allowMemberAgentCreation is true", async () => {
      const { workspaceId, member } = await setupWorkspaceWithRoles({
        allowMemberAgentCreation: true,
      });

      const resp = await dispatch(
        {
          type: "cyborg:create_agent",
          workspaceId,
          provider: "claude",
          cwd: "/tmp",
          requestId: "a1",
        },
        member,
      );
      // Gets past permission check, fails at agent manager (not wired)
      expect((resp[0] as any).payload.code).toBe("unavailable");
    });
  });

  describe("view operations", () => {
    it("all roles including viewer can view channels and tasks", async () => {
      const { workspaceId, viewer } = await setupWorkspaceWithRoles();

      const chResp = await dispatch(
        { type: "cyborg:fetch_channels", workspaceId, requestId: "v1" },
        viewer,
      );
      expect((chResp[0] as any).type).toBe("cyborg:fetch_channels_response");

      const taskResp = await dispatch(
        { type: "cyborg:fetch_tasks", workspaceId, requestId: "v2" },
        viewer,
      );
      expect((taskResp[0] as any).type).toBe("cyborg:fetch_tasks_response");
    });

    it("fetch_tasks returns the camelCase wire shape (assigneeId/channelId/priority populated)", async () => {
      const { workspaceId, owner, member } = await setupWorkspaceWithRoles();

      // Seed an assigned task carrying a channel + priority directly through
      // storage so the read row has every Phase 2/3 column populated. The path
      // under test is the dispatcher's fetch_tasks mapping, not create_task.
      storage.createTask({
        workspaceId,
        title: "Assigned task",
        createdBy: owner.user.id,
        assigneeId: member.user.id,
        channelId: "chan_abc",
        priority: "high",
      });

      const taskResp = await dispatch(
        { type: "cyborg:fetch_tasks", workspaceId, requestId: "v3" },
        owner,
      );
      expect((taskResp[0] as any).type).toBe("cyborg:fetch_tasks_response");
      const tasks = (taskResp[0] as any).payload.tasks as Record<string, unknown>[];
      expect(tasks).toHaveLength(1);
      const task = tasks[0];
      expect(task.title).toBe("Assigned task");
      // The bug: raw StoredTask rows leaked snake_case (assignee_id), leaving the
      // client's Task.assigneeId undefined → every card showed "Unassigned".
      expect(task.assigneeId).toBe(member.user.id);
      expect(task).not.toHaveProperty("assignee_id");
      expect(task.channelId).toBe("chan_abc");
      expect(task.priority).toBe("high");
    });
  });

  // ─── Remove member ────────────────────────────────────────────

  describe("remove member", () => {
    it("admin can remove member but not owner", async () => {
      const { workspaceId, owner, admin, member } = await setupWorkspaceWithRoles();

      // Admin removes member — success
      const resp1 = await dispatch(
        { type: "cyborg:remove_member", workspaceId, userId: member.user.id, requestId: "rm1" },
        admin,
      );
      expect((resp1[0] as any).type).toBe("cyborg:remove_member_response");
      expect((resp1[0] as any).payload.removed).toBe(true);

      // Admin tries to remove owner — fails
      const resp2 = await dispatch(
        { type: "cyborg:remove_member", workspaceId, userId: owner.user.id, requestId: "rm2" },
        admin,
      );
      expect((resp2[0] as any).type).toBe("cyborg:error");
    });

    it("member cannot remove anyone", async () => {
      const { workspaceId, viewer } = await setupWorkspaceWithRoles();
      const member2 = ctx("member@test.com", "Member");

      const resp = await dispatch(
        { type: "cyborg:remove_member", workspaceId, userId: viewer.user.id, requestId: "rm3" },
        member2,
      );
      expect((resp[0] as any).type).toBe("cyborg:error");
    });
  });

  // ─── Update role ──────────────────────────────────────────────

  describe("update role", () => {
    it("only owner can change roles", async () => {
      const { workspaceId, owner, admin, member } = await setupWorkspaceWithRoles();

      // Owner promotes member to admin
      const resp1 = await dispatch(
        {
          type: "cyborg:update_role",
          workspaceId,
          userId: member.user.id,
          role: "admin",
          requestId: "ur1",
        },
        owner,
      );
      expect((resp1[0] as any).type).toBe("cyborg:update_role_response");
      expect((resp1[0] as any).payload.updated).toBe(true);

      // Admin cannot change roles
      const resp2 = await dispatch(
        {
          type: "cyborg:update_role",
          workspaceId,
          userId: member.user.id,
          role: "viewer",
          requestId: "ur2",
        },
        admin,
      );
      expect((resp2[0] as any).type).toBe("cyborg:error");
    });

    it("cannot assign owner role", async () => {
      const { workspaceId, owner, member } = await setupWorkspaceWithRoles();

      const resp = await dispatch(
        {
          type: "cyborg:update_role",
          workspaceId,
          userId: member.user.id,
          role: "owner",
          requestId: "ur3",
        },
        owner,
      );
      expect((resp[0] as any).type).toBe("cyborg:error");
    });
  });

  // ─── Rate limiting ────────────────────────────────────────────

  describe("rate limiting", () => {
    it("blocks messages after 60 per minute", async () => {
      const { workspaceId, channelId, member } = await setupWorkspaceWithRoles();

      for (let i = 0; i < 60; i++) {
        await dispatch(
          { type: "cyborg:channel_message", workspaceId, channelId, text: `msg ${i}` },
          member,
        );
      }

      // 61st should be silently dropped (rate limited)
      broadcasted = [];
      await dispatch(
        { type: "cyborg:channel_message", workspaceId, channelId, text: "overflow" },
        member,
      );
      const overflowMsgs = filterBroadcasts(
        broadcasted,
        "cyborg:channel_message_broadcast",
        "overflow",
      );
      expect(overflowMsgs).toHaveLength(0);
    });

    it("blocks task creation after 100 per hour", async () => {
      const { workspaceId, member } = await setupWorkspaceWithRoles();

      for (let i = 0; i < 100; i++) {
        await dispatch(
          { type: "cyborg:create_task", workspaceId, title: `Task ${i}`, requestId: `t${i}` },
          member,
        );
      }

      const resp = await dispatch(
        { type: "cyborg:create_task", workspaceId, title: "overflow", requestId: "t-overflow" },
        member,
      );
      expect((resp[0] as any).type).toBe("cyborg:error");
      expect((resp[0] as any).payload.code).toBe("rate_limited");
    });
  });

  // ─── Non-member access ────────────────────────────────────────

  describe("workspace isolation", () => {
    it("non-member cannot access workspace resources", async () => {
      const { workspaceId } = await setupWorkspaceWithRoles();
      const outsider = ctx("outsider@test.com", "Outsider");

      const chResp = await dispatch(
        { type: "cyborg:fetch_channels", workspaceId, requestId: "o1" },
        outsider,
      );
      expect((chResp[0] as any).type).toBe("cyborg:error");
      expect((chResp[0] as any).payload.code).toBe("forbidden");

      const taskResp = await dispatch(
        { type: "cyborg:fetch_tasks", workspaceId, requestId: "o2" },
        outsider,
      );
      expect((taskResp[0] as any).type).toBe("cyborg:error");
    });
  });
});
