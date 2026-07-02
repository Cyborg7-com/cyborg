import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PgSync,
  StoredProjectSync,
  StoredStatusMapping,
  StoredTaskItemSync,
} from "./db/pg-sync.js";
import type {
  NormalizedTaskEvent,
  TaskIntegrationAdapter,
} from "./integrations/task-integration-adapter.js";
import {
  _resetTaskEchoGuardForTest,
  applyInboundTaskEvent,
  consumeTaskInbound,
  contentHash,
  dispatchInboundTaskEvents,
  markTaskInbound,
} from "./task-sync-engine.js";

beforeEach(() => {
  _resetTaskEchoGuardForTest();
  bindingSeq = 0;
});

// ─── echo guard ──────────────────────────────────────────────────────────────

describe("echo guard — provider-aware (provider, taskId, action) keying", () => {
  it("consumes a fresh marker exactly once", () => {
    markTaskInbound("jira", "task_1", "status");
    expect(consumeTaskInbound("jira", "task_1", "status")).toBe(true);
    expect(consumeTaskInbound("jira", "task_1", "status")).toBe(false);
  });

  it("an inbound Jira change does NOT suppress a ClickUp emit for the SAME task+action", () => {
    // The cross-provider fan-out guarantee: a task linked to both providers must still
    // mirror a Jira-origin change out to ClickUp.
    markTaskInbound("jira", "task_1", "status");
    expect(consumeTaskInbound("clickup", "task_1", "status")).toBe(false);
    // The Jira marker itself is still consumable (untouched by the ClickUp probe).
    expect(consumeTaskInbound("jira", "task_1", "status")).toBe(true);
  });

  it("is keyed by action too — a fields marker does not suppress a status emit", () => {
    markTaskInbound("jira", "task_1", "fields");
    expect(consumeTaskInbound("jira", "task_1", "status")).toBe(false);
  });

  it("treats an expired marker as not-recent (TTL)", () => {
    const t0 = 1_000_000;
    markTaskInbound("jira", "task_1", "status", t0);
    expect(consumeTaskInbound("jira", "task_1", "status", t0 + 31_000)).toBe(false);
  });
});

// ─── content hash ─────────────────────────────────────────────────────────────

describe("contentHash — durable echo backstop", () => {
  it("is stable for the same field set regardless of label order", () => {
    const a = contentHash(makeEvent({ labels: ["b", "a"] }));
    const b = contentHash(makeEvent({ labels: ["a", "b"] }));
    expect(a).toBe(b);
  });

  it("changes when a synced field changes", () => {
    const a = contentHash(makeEvent({ title: "One" }));
    const b = contentHash(makeEvent({ title: "Two" }));
    expect(a).not.toBe(b);
  });
});

// ─── fakes ────────────────────────────────────────────────────────────────────

interface CreateCall {
  id: string;
  workspaceId: string;
  title: string;
  projectId?: string | null;
  createdBy: string;
  stateId?: string | null;
  assigneeId?: string;
  priority?: string | null;
  labelNames?: string[];
}
interface UpdateCall {
  taskId: string;
  updates: Parameters<PgSync["updateTask"]>[1];
}
interface ActivityCall {
  taskId: string;
  commentHtml?: string | null;
  verb: string;
}

interface FakeState {
  bindings: StoredProjectSync[];
  items: StoredTaskItemSync[];
  mappings: StoredStatusMapping[];
  states: Array<{ id: string; group: string }>;
  users: Map<string, { id: string }>;
  members: Set<string>;
  labelIds: string[];
  throwCreateTitle?: string;
  created: CreateCall[];
  updated: UpdateCall[];
  activities: ActivityCall[];
  upserts: Array<{ taskId: string; itemNumber: string; lastSyncedHash?: string | null }>;
}

function makeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    bindings: [],
    items: [],
    mappings: [],
    states: [],
    users: new Map(),
    members: new Set(),
    labelIds: [],
    created: [],
    updated: [],
    activities: [],
    upserts: [],
    ...overrides,
  };
}

function makePg(state: FakeState): PgSync {
  return {
    async getProjectSyncsByExternal(provider: string, externalProjectId: string) {
      return state.bindings.filter(
        (b) => b.provider === provider && b.externalProjectId === externalProjectId,
      );
    },
    async getTaskItemByExternal(projectSyncId: string, itemType: string, itemNumber: string) {
      return (
        state.items.find(
          (i) =>
            i.projectSyncId === projectSyncId &&
            i.itemType === itemType &&
            i.itemNumber === itemNumber,
        ) ?? null
      );
    },
    async getStatusMapping(projectSyncId: string, sourceStatusName: string) {
      return (
        state.mappings.find(
          (m) => m.projectSyncId === projectSyncId && m.sourceStatusName === sourceStatusName,
        ) ?? null
      );
    },
    async getProjectStates(_projectId: string) {
      return state.states.map((s) => ({
        id: s.id,
        projectId: "tp_1",
        workspaceId: "ws_1",
        name: s.id,
        color: "#000",
        group: s.group,
        sequence: 0,
        isDefault: false,
      }));
    },
    async getUserByEmail(email: string) {
      const u = state.users.get(email);
      return u ? { id: u.id, email, name: null, imageUrl: null, passwordHash: null } : null;
    },
    async isMember(workspaceId: string, userId: string) {
      return state.members.has(`${workspaceId}:${userId}`);
    },
    async resolveLabels(_projectId: string, _names: readonly string[]) {
      return state.labelIds;
    },
    async createTask(opts: CreateCall) {
      if (state.throwCreateTitle && opts.title === state.throwCreateTitle) {
        throw new Error("boom");
      }
      state.created.push(opts);
    },
    async updateTask(taskId: string, updates: Parameters<PgSync["updateTask"]>[1]) {
      state.updated.push({ taskId, updates });
    },
    async recordTaskActivity(opts: ActivityCall) {
      state.activities.push(opts);
    },
    async upsertTaskItemSync(opts: {
      taskId: string;
      itemNumber: string;
      lastSyncedHash?: string | null;
    }) {
      state.upserts.push(opts);
      return "tisync_x";
    },
    async setTaskItemLastSyncedHash() {},
  } as unknown as PgSync;
}

function makeAdapter(provider = "jira"): TaskIntegrationAdapter {
  return {
    provider,
    verifyWebhook: () => true,
    parseInbound: () => [],
    listStatuses: async () => [],
    importItems: async () => ({ items: [] }),
    writeItem: async () => {},
    writeStatus: async () => {},
  };
}

let bindingSeq = 0;
function makeBinding(overrides: Partial<StoredProjectSync> = {}): StoredProjectSync {
  return {
    id: `psync_${++bindingSeq}`,
    workspaceId: "ws_1",
    provider: "jira",
    installationId: null,
    tasksProjectId: "tp_1",
    externalProjectId: "EXT-1",
    externalProjectName: null,
    externalUrl: null,
    syncDirection: "inbound",
    createdBy: "user_creator",
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeItem(overrides: Partial<StoredTaskItemSync> = {}): StoredTaskItemSync {
  return {
    id: "tisync_1",
    projectSyncId: "psync_1",
    taskId: "task_existing",
    provider: "jira",
    itemType: "issue",
    itemNumber: "1",
    providerItemId: "10001",
    itemUrl: null,
    lastSyncedHash: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeMapping(overrides: Partial<StoredStatusMapping> = {}): StoredStatusMapping {
  return {
    id: "stmap_1",
    workspaceId: "ws_1",
    projectSyncId: "psync_1",
    provider: "jira",
    sourceStatusId: null,
    sourceStatusName: "In Review",
    taskStateId: null,
    skipBackward: false,
    createdBy: "user_creator",
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<NormalizedTaskEvent> = {}): NormalizedTaskEvent {
  return {
    itemType: "issue",
    externalProjectId: "EXT-1",
    itemNumber: "1",
    providerItemId: "10001",
    title: "An issue",
    ...overrides,
  };
}

// ─── engine inbound flow ───────────────────────────────────────────────────────

describe("applyInboundTaskEvent — inbound flow", () => {
  it("creates a task on the FIRST event for an unseen item", async () => {
    const state = makeState({ bindings: [makeBinding()] });
    await applyInboundTaskEvent(makePg(state), makeAdapter(), makeEvent({ title: "New issue" }));

    expect(state.created).toHaveLength(1);
    expect(state.created[0]).toMatchObject({
      workspaceId: "ws_1",
      projectId: "tp_1", // from the binding, never the payload
      createdBy: "user_creator",
      title: "New issue",
    });
    expect(state.upserts[0]).toMatchObject({ itemNumber: "1" });
    expect(state.upserts[0]?.lastSyncedHash).toBe(contentHash(makeEvent({ title: "New issue" })));
    expect(state.activities.some((a) => a.verb === "created")).toBe(true);
  });

  it("REFRESHES the linked task on a subsequent event", async () => {
    const state = makeState({
      bindings: [makeBinding()],
      items: [makeItem({ projectSyncId: "psync_1", lastSyncedHash: "stale" })],
    });
    await applyInboundTaskEvent(makePg(state), makeAdapter(), makeEvent({ title: "Renamed" }));

    expect(state.created).toHaveLength(0);
    expect(state.updated).toHaveLength(1);
    expect(state.updated[0]).toMatchObject({ taskId: "task_existing" });
    expect(state.updated[0]?.updates.title).toBe("Renamed");
  });

  it("SKIPS a refresh when the content hash is unchanged (durable echo backstop)", async () => {
    const event = makeEvent({ title: "Same" });
    const state = makeState({
      bindings: [makeBinding()],
      items: [makeItem({ projectSyncId: "psync_1", lastSyncedHash: contentHash(event) })],
    });
    await applyInboundTaskEvent(makePg(state), makeAdapter(), event);

    expect(state.updated).toHaveLength(0);
    expect(state.activities).toHaveLength(0);
  });

  it("resolves status via an EXPLICIT status_mappings row", async () => {
    const state = makeState({
      bindings: [makeBinding()],
      mappings: [makeMapping({ sourceStatusName: "In Review", taskStateId: "state_review" })],
    });
    await applyInboundTaskEvent(
      makePg(state),
      makeAdapter(),
      makeEvent({ sourceStatusName: "In Review", statusCategory: "started" }),
    );
    expect(state.created[0]?.stateId).toBe("state_review"); // explicit row wins over affinity
  });

  it("falls back to CATEGORY affinity when no explicit mapping exists", async () => {
    const state = makeState({
      bindings: [makeBinding()],
      states: [
        { id: "ts_backlog", group: "backlog" },
        { id: "ts_started", group: "started" },
        { id: "ts_done", group: "completed" },
      ],
    });
    await applyInboundTaskEvent(
      makePg(state),
      makeAdapter(),
      makeEvent({ sourceStatusName: "Doing", statusCategory: "started" }),
    );
    expect(state.created[0]?.stateId).toBe("ts_started");
  });

  it("skips a binding whose syncDirection is 'outbound'", async () => {
    const state = makeState({ bindings: [makeBinding({ syncDirection: "outbound" })] });
    await applyInboundTaskEvent(makePg(state), makeAdapter(), makeEvent());
    expect(state.created).toHaveLength(0);
    expect(state.updated).toHaveLength(0);
  });

  it("is a no-op when the external project is bound to nothing", async () => {
    const state = makeState({ bindings: [] });
    await applyInboundTaskEvent(makePg(state), makeAdapter(), makeEvent());
    expect(state.created).toHaveLength(0);
  });

  it("fans out to EVERY binding for the same external project", async () => {
    const state = makeState({
      bindings: [
        makeBinding({ id: "psync_1", tasksProjectId: "tp_1" }),
        makeBinding({ id: "psync_2", tasksProjectId: "tp_2", workspaceId: "ws_2" }),
      ],
    });
    await applyInboundTaskEvent(makePg(state), makeAdapter(), makeEvent());
    expect(state.created).toHaveLength(2);
    expect(state.created.map((c) => c.projectId).sort()).toEqual(["tp_1", "tp_2"]);
  });

  it("applies an assignee ONLY when the email resolves to a workspace member", async () => {
    const state = makeState({
      bindings: [makeBinding()],
      users: new Map([["dev@acme.com", { id: "user_dev" }]]),
      members: new Set(["ws_1:user_dev"]),
    });
    await applyInboundTaskEvent(
      makePg(state),
      makeAdapter(),
      makeEvent({ assigneeEmail: "dev@acme.com" }),
    );
    expect(state.created[0]?.assigneeId).toBe("user_dev");
  });

  it("does NOT assign to a resolved user who is not a workspace member", async () => {
    const state = makeState({
      bindings: [makeBinding()],
      users: new Map([["outsider@evil.com", { id: "user_outsider" }]]),
      members: new Set(), // not a member
    });
    await applyInboundTaskEvent(
      makePg(state),
      makeAdapter(),
      makeEvent({ assigneeEmail: "outsider@evil.com" }),
    );
    expect(state.created[0]?.assigneeId).toBeUndefined();
  });

  it("appends an inbound COMMENT as escaped task activity", async () => {
    const state = makeState({
      bindings: [makeBinding()],
      items: [makeItem({ projectSyncId: "psync_1", itemType: "task", itemNumber: "1" })],
    });
    await applyInboundTaskEvent(
      makePg(state),
      makeAdapter(),
      makeEvent({ itemType: "comment", commentBody: "<script>x</script>", actor: "bob" }),
    );
    const comment = state.activities.find((a) => a.commentHtml?.includes("commented"));
    expect(comment).toBeDefined();
    expect(comment?.commentHtml).toContain("&lt;script&gt;");
    expect(comment?.commentHtml).not.toContain("<script>");
  });

  it("marks the echo guard under the event's provider (not other providers)", async () => {
    const state = makeState({ bindings: [makeBinding()] });
    await applyInboundTaskEvent(makePg(state), makeAdapter("jira"), makeEvent({ title: "T" }));
    const taskId = state.created[0]?.id ?? "";
    expect(consumeTaskInbound("clickup", taskId, "fields")).toBe(false); // cross-provider preserved
    expect(consumeTaskInbound("jira", taskId, "fields")).toBe(true);
  });
});

describe("dispatchInboundTaskEvents — best-effort batch", () => {
  it("one bad event does not abort the rest of the batch", async () => {
    const state = makeState({ bindings: [makeBinding()], throwCreateTitle: "BOOM" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await dispatchInboundTaskEvents(makePg(state), makeAdapter(), [
      makeEvent({ itemNumber: "1", title: "BOOM" }), // createTask throws
      makeEvent({ itemNumber: "2", title: "OK" }),
    ]);
    errSpy.mockRestore();
    expect(state.created.map((c) => c.title)).toEqual(["OK"]); // second still created
  });
});
