import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CyborgStorage } from "./storage.js";

// Tasks Redesign — the create-path "require a project context" rule. createTask's
// effective-project resolver (storage.resolveCreateProject, mirrored in
// pg-sync.resolveCreateProjectTx) must pick a Tasks-project by this precedence:
//   1. explicit projectId (chat id or tp_ id) → that project; unknown → throws
//      "project not found".
//   2. else channelId → the channel's tasks_project, falling back to the workspace
//      Inbox when the channel has no project (Inbox fallback KEPT).
//   3. else parentId → inherit the parent task's project (sub-tasks).
//   4. else (none) → the require-project opt-in decides: requireProjectContext true
//      → throws "provide projectId or channelId" (the user/cybo-facing handlers);
//      false/absent (default) → falls back to the workspace Inbox (the 2nd-workspace
//      MCP server, GitHub sync, internal callers).
// Exercised through the public synchronous createTask on an in-memory CyborgStorage
// (solo, real SQLite, no mocks). Note: the returned StoredTask.project_id is the
// CHAT project id (storage translates the stored tasks_projects.id back to the chat
// id on read); an Inbox task — whose tasks_project has no chat project — reads back
// project_id null.

describe("CyborgStorage createTask — resolveCreateProject precedence", () => {
  let storage: CyborgStorage;
  let workspaceId: string;
  let userId: string;
  let chatProjectId: string;
  let tasksProjectId: string;
  let linkedChannelId: string;
  let bareChannelId: string;

  beforeEach(() => {
    storage = new CyborgStorage(":memory:");
    const user = storage.upsertUser("resolver@test.dev", "Resolver User");
    userId = user.id;
    const ws = storage.createWorkspace("Resolver WS", user.id);
    workspaceId = ws.id;

    // A chat project + its 1:1 Tasks-project.
    const chatProject = storage.createProject(workspaceId, "Engineering", "#4f46e5");
    chatProjectId = chatProject.id;
    const tp = storage.provisionTasksProject({
      workspaceId,
      chatProjectId,
      name: "Engineering",
    });
    tasksProjectId = tp.id;

    // A channel TAGGED to that chat project, and a bare channel with no project.
    const linked = storage.createChannel(workspaceId, "eng", userId);
    linkedChannelId = linked.id;
    storage.setChannelProject(linkedChannelId, chatProjectId);

    const bare = storage.createChannel(workspaceId, "random", userId);
    bareChannelId = bare.id;
  });

  afterEach(() => {
    storage.close();
  });

  // ─── Rule 1 — explicit projectId ──────────────────────────────────────────

  it("rule 1: an explicit CHAT projectId files the task into that project", () => {
    const task = storage.createTask({
      workspaceId,
      title: "explicit chat id",
      createdBy: userId,
      projectId: chatProjectId,
    });
    expect(task.project_id).toBe(chatProjectId);
  });

  it("rule 1: an explicit tasks_projects (tp_) id resolves to the same project", () => {
    const task = storage.createTask({
      workspaceId,
      title: "explicit tp id",
      createdBy: userId,
      projectId: tasksProjectId,
    });
    // Stored as the tp id, translated back to the chat id on read.
    expect(task.project_id).toBe(chatProjectId);
  });

  it("rule 1: an unknown explicit projectId throws 'project not found' (fail closed)", () => {
    expect(() =>
      storage.createTask({
        workspaceId,
        title: "unknown project",
        createdBy: userId,
        projectId: "proj_does_not_exist",
      }),
    ).toThrow("project not found");
  });

  // ─── Rule 2 — channelId (with Inbox fallback) ─────────────────────────────

  it("rule 2: a channel tagged to a project files the task into that project", () => {
    const task = storage.createTask({
      workspaceId,
      title: "via tagged channel",
      createdBy: userId,
      channelId: linkedChannelId,
    });
    expect(task.project_id).toBe(chatProjectId);
  });

  it("rule 2: a channel with NO project falls back to the workspace Inbox", () => {
    const task = storage.createTask({
      workspaceId,
      title: "via bare channel",
      createdBy: userId,
      channelId: bareChannelId,
    });
    // The Inbox tasks_project has no chat project → reads back project_id null.
    expect(task.project_id).toBeNull();
    // And the synthetic Inbox project now exists (the fallback created it, no throw).
    const inbox = storage.getTasksProjects(workspaceId).find((p) => p.chat_project_id === null);
    expect(inbox).toBeDefined();
  });

  // ─── Rule 3 — parentId inherit ────────────────────────────────────────────

  it("rule 3: a sub-task (parentId only) inherits the parent's project", () => {
    const parent = storage.createTask({
      workspaceId,
      title: "parent",
      createdBy: userId,
      projectId: chatProjectId,
    });
    const child = storage.createTask({
      workspaceId,
      title: "child",
      createdBy: userId,
      parentId: parent.id,
    });
    expect(child.project_id).toBe(chatProjectId);
    expect(child.project_id).toBe(parent.project_id);
  });

  // ─── Rule 4 — none provided (require-project opt-in) ──────────────────────

  it("rule 4: a contextless create with requireProjectContext:true throws", () => {
    expect(() =>
      storage.createTask({
        workspaceId,
        title: "orphan",
        createdBy: userId,
        requireProjectContext: true,
      }),
    ).toThrow("provide projectId or channelId");
  });

  it("rule 4: a contextless create with the flag absent falls back to the Inbox", () => {
    const task = storage.createTask({
      workspaceId,
      title: "orphan → inbox",
      createdBy: userId,
    });
    // Default (no flag) = Inbox fallback, no throw. The Inbox tasks_project has no
    // chat project → reads back project_id null.
    expect(task.project_id).toBeNull();
    const inbox = storage.getTasksProjects(workspaceId).find((p) => p.chat_project_id === null);
    expect(inbox, "expected the synthetic Inbox project after the fallback").toBeDefined();
  });

  it("rule 4: a contextless create with requireProjectContext:false falls back to the Inbox", () => {
    const task = storage.createTask({
      workspaceId,
      title: "orphan → inbox (explicit false)",
      createdBy: userId,
      requireProjectContext: false,
    });
    expect(task.project_id).toBeNull();
  });

  // ─── Precedence ordering ──────────────────────────────────────────────────

  it("precedence: explicit projectId wins over a (project-less) channelId", () => {
    const task = storage.createTask({
      workspaceId,
      title: "explicit beats channel",
      createdBy: userId,
      projectId: chatProjectId,
      channelId: bareChannelId,
    });
    // projectId (rule 1) wins; it does NOT fall to the bare channel's Inbox.
    expect(task.project_id).toBe(chatProjectId);
  });

  it("precedence: channelId wins over parentId", () => {
    // A parent that lives in the Inbox (created via the bare channel).
    const parent = storage.createTask({
      workspaceId,
      title: "inbox parent",
      createdBy: userId,
      channelId: bareChannelId,
    });
    expect(parent.project_id).toBeNull(); // Inbox

    // Give both a channel (tagged) AND a parent (in Inbox): the channel wins.
    const task = storage.createTask({
      workspaceId,
      title: "channel beats parent",
      createdBy: userId,
      channelId: linkedChannelId,
      parentId: parent.id,
    });
    expect(task.project_id).toBe(chatProjectId);
  });
});
