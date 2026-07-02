import { beforeEach, describe, expect, it } from "vitest";
import type {
  PgSync,
  StoredIntegrationInstallation,
  StoredProjectSync,
  StoredStatusMapping,
  StoredTaskItemSync,
} from "./db/pg-sync.js";
import type {
  TaskIntegrationAdapter,
  TaskItemWritePatch,
  TaskStatusWriteArgs,
} from "./integrations/task-integration-adapter.js";
import { _resetTaskEchoGuardForTest, markTaskInbound } from "./task-sync-engine.js";
import {
  emitTaskOutboundToProviders,
  type TaskOutboundDeps,
  type TaskProviderOutboundChange,
} from "./task-outbound.js";

// The generic OUTBOUND write-back: fan a Cyborg task change out to every writable provider
// binding, echo-guarded so an inbound-origin change never bounces back, with a durable
// content-hash no-op backstop and a reverse status map. All I/O (adapters + token decrypt)
// is injected, so these run offline.

beforeEach(() => _resetTaskEchoGuardForTest());

// ─── fakes ────────────────────────────────────────────────────────────────────

interface RecordingAdapter extends TaskIntegrationAdapter {
  writeItems: TaskItemWritePatch[];
  writeStatuses: TaskStatusWriteArgs[];
}

function makeAdapter(provider: string, opts: { throwOnWrite?: boolean } = {}): RecordingAdapter {
  const writeItems: TaskItemWritePatch[] = [];
  const writeStatuses: TaskStatusWriteArgs[] = [];
  return {
    provider,
    verifyWebhook: () => true,
    parseInbound: () => [],
    listStatuses: async () => [],
    importItems: async () => ({ items: [] }),
    async writeItem(_token: string, patch: TaskItemWritePatch) {
      if (opts.throwOnWrite) throw new Error(`${provider} writeItem boom`);
      writeItems.push(patch);
    },
    async writeStatus(_token: string, args: TaskStatusWriteArgs) {
      if (opts.throwOnWrite) throw new Error(`${provider} writeStatus boom`);
      writeStatuses.push(args);
    },
    writeItems,
    writeStatuses,
  };
}

interface FakeState {
  bindings: StoredProjectSync[];
  items: StoredTaskItemSync[];
  mappings: StoredStatusMapping[];
  states: Array<{ id: string; group: string }>;
  installs: StoredIntegrationInstallation[];
  hashWrites: Array<{ id: string; hash: string | null }>;
}

function makeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    bindings: [],
    items: [],
    mappings: [],
    states: [],
    installs: [],
    hashWrites: [],
    ...overrides,
  };
}

function makePg(state: FakeState): PgSync {
  return {
    async getTaskItemsForTask(taskId: string) {
      return state.items.filter((i) => i.taskId === taskId);
    },
    async getProjectSyncById(id: string) {
      return state.bindings.find((b) => b.id === id) ?? null;
    },
    async listStatusMappings(projectSyncId: string) {
      return state.mappings.filter((m) => m.projectSyncId === projectSyncId);
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
    async getIntegrationInstallationById(id: string) {
      return state.installs.find((i) => i.id === id) ?? null;
    },
    async setTaskItemLastSyncedHash(id: string, hash: string | null) {
      state.hashWrites.push({ id, hash });
    },
  } as unknown as PgSync;
}

function makeDeps(adapters: Record<string, TaskIntegrationAdapter>): TaskOutboundDeps {
  return { adapters, decrypt: (enc) => enc };
}

// ─── builders ─────────────────────────────────────────────────────────────────

let seq = 0;

function binding(o: Partial<StoredProjectSync> = {}): StoredProjectSync {
  seq += 1;
  return {
    id: `ps_${seq}`,
    workspaceId: "ws_1",
    provider: "jira",
    installationId: "inst_1",
    tasksProjectId: "tp_1",
    externalProjectId: "cloud_1/PROJ",
    externalProjectName: "PROJ",
    externalUrl: null,
    syncDirection: "bidirectional",
    createdBy: "u_1",
    createdAt: 0,
    ...o,
  };
}

function item(o: Partial<StoredTaskItemSync> = {}): StoredTaskItemSync {
  seq += 1;
  return {
    id: `tis_${seq}`,
    projectSyncId: "ps_1",
    taskId: "task_1",
    provider: "jira",
    itemType: "issue",
    itemNumber: "PROJ-1",
    providerItemId: "10001",
    itemUrl: null,
    lastSyncedHash: null,
    createdAt: 0,
    ...o,
  };
}

function mapping(o: Partial<StoredStatusMapping> = {}): StoredStatusMapping {
  seq += 1;
  return {
    id: `stmap_${seq}`,
    workspaceId: "ws_1",
    projectSyncId: "ps_1",
    provider: "jira",
    sourceStatusId: null,
    sourceStatusName: "Done",
    taskStateId: "state_done",
    skipBackward: false,
    createdBy: "u_1",
    createdAt: 0,
    ...o,
  };
}

function install(o: Partial<StoredIntegrationInstallation> = {}): StoredIntegrationInstallation {
  return {
    id: "inst_1",
    workspaceId: "ws_1",
    provider: "jira",
    externalId: "cloud_1",
    config: {},
    accessToken: "tok",
    botUserId: null,
    scopes: null,
    installedBy: "u_1",
    createdAt: 0,
    ...o,
  };
}

function change(o: Partial<TaskProviderOutboundChange> = {}): TaskProviderOutboundChange {
  return {
    taskId: "task_1",
    prevTitle: "Old",
    nextTitle: "Old",
    prevDescription: "d",
    nextDescription: "d",
    prevPriority: null,
    nextPriority: null,
    prevDueAt: null,
    nextDueAt: null,
    prevStartAt: null,
    nextStartAt: null,
    prevStateId: "state_todo",
    nextStateId: "state_todo",
    prevStatus: "unstarted",
    nextStatus: "unstarted",
    ...o,
  };
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("emitTaskOutboundToProviders — fan-out + gates", () => {
  it("fans a field change out to ALL writable bindings (jira + clickup)", async () => {
    const jira = makeAdapter("jira");
    const clickup = makeAdapter("clickup");
    const state = makeState({
      bindings: [
        binding({ id: "ps_j", provider: "jira", externalProjectId: "cloud_1/PROJ" }),
        binding({ id: "ps_c", provider: "clickup", externalProjectId: "space_9" }),
      ],
      items: [
        item({ id: "tis_j", projectSyncId: "ps_j", provider: "jira", itemNumber: "PROJ-1" }),
        item({
          id: "tis_c",
          projectSyncId: "ps_c",
          provider: "clickup",
          itemType: "task",
          itemNumber: "abc",
          providerItemId: "abc",
        }),
      ],
      installs: [install()],
    });
    await emitTaskOutboundToProviders(
      makePg(state),
      change({ prevTitle: "Old", nextTitle: "New" }),
      makeDeps({ jira, clickup }),
    );

    expect(jira.writeItems).toHaveLength(1);
    expect(jira.writeItems[0].title).toBe("New");
    expect(clickup.writeItems).toHaveLength(1);
    expect(clickup.writeItems[0].title).toBe("New");
    // Hash recorded for both links after the successful writes.
    expect(state.hashWrites.map((h) => h.id).sort()).toEqual(["tis_c", "tis_j"]);
  });

  it("SKIPS an inbound-only binding (only bidirectional/outbound write back)", async () => {
    const jira = makeAdapter("jira");
    const state = makeState({
      bindings: [binding({ id: "ps_1", syncDirection: "inbound" })],
      items: [item({ projectSyncId: "ps_1" })],
      installs: [install()],
    });
    await emitTaskOutboundToProviders(
      makePg(state),
      change({ prevTitle: "Old", nextTitle: "New" }),
      makeDeps({ jira }),
    );
    expect(jira.writeItems).toHaveLength(0);
    expect(state.hashWrites).toHaveLength(0);
  });

  it("an OUTBOUND-only binding DOES write back", async () => {
    const jira = makeAdapter("jira");
    const state = makeState({
      bindings: [binding({ id: "ps_1", syncDirection: "outbound" })],
      items: [item({ projectSyncId: "ps_1" })],
      installs: [install()],
    });
    await emitTaskOutboundToProviders(
      makePg(state),
      change({ prevTitle: "Old", nextTitle: "New" }),
      makeDeps({ jira }),
    );
    expect(jira.writeItems).toHaveLength(1);
  });

  it("writeItem carries exactly the changed fields (title/description/priority/due)", async () => {
    const jira = makeAdapter("jira");
    const state = makeState({
      bindings: [binding({ id: "ps_1" })],
      items: [item({ projectSyncId: "ps_1", itemNumber: "PROJ-7", providerItemId: "77" })],
      installs: [install()],
    });
    await emitTaskOutboundToProviders(
      makePg(state),
      change({
        prevTitle: "Old",
        nextTitle: "New",
        prevDescription: "a",
        nextDescription: "b",
        prevPriority: null,
        nextPriority: "high",
        prevDueAt: null,
        nextDueAt: 1000,
      }),
      makeDeps({ jira }),
    );
    expect(jira.writeItems).toHaveLength(1);
    const patch = jira.writeItems[0];
    expect(patch).toMatchObject({
      externalProjectId: "cloud_1/PROJ",
      itemType: "issue",
      itemNumber: "PROJ-7",
      providerItemId: "77",
      title: "New",
      description: "b",
      priority: "high",
      dueAt: 1000,
    });
    // startAt didn't change → not in the patch.
    expect(patch.startAt).toBeUndefined();
  });
});

describe("emitTaskOutboundToProviders — echo guard (loop-breaker)", () => {
  it("SKIPS a change that just arrived from that provider (no bounce-back)", async () => {
    const jira = makeAdapter("jira");
    const state = makeState({
      bindings: [binding({ id: "ps_1" })],
      items: [item({ projectSyncId: "ps_1" })],
      installs: [install()],
    });
    // Simulate the inbound apply marking the guard for this task's fields.
    markTaskInbound("jira", "task_1", "fields");

    await emitTaskOutboundToProviders(
      makePg(state),
      change({ prevTitle: "Old", nextTitle: "New" }),
      makeDeps({ jira }),
    );
    // The field write is suppressed — the change originated FROM Jira.
    expect(jira.writeItems).toHaveLength(0);
    expect(state.hashWrites).toHaveLength(0);
  });

  it("only suppresses the SAME provider — a co-linked provider still fans out", async () => {
    const jira = makeAdapter("jira");
    const clickup = makeAdapter("clickup");
    const state = makeState({
      bindings: [
        binding({ id: "ps_j", provider: "jira", externalProjectId: "cloud_1/PROJ" }),
        binding({ id: "ps_c", provider: "clickup", externalProjectId: "space_9" }),
      ],
      items: [
        item({ id: "tis_j", projectSyncId: "ps_j", provider: "jira" }),
        item({
          id: "tis_c",
          projectSyncId: "ps_c",
          provider: "clickup",
          itemType: "task",
          itemNumber: "abc",
          providerItemId: "abc",
        }),
      ],
      installs: [install()],
    });
    // The change came FROM Jira → mark only jira.
    markTaskInbound("jira", "task_1", "fields");

    await emitTaskOutboundToProviders(
      makePg(state),
      change({ prevTitle: "Old", nextTitle: "New" }),
      makeDeps({ jira, clickup }),
    );
    expect(jira.writeItems).toHaveLength(0); // suppressed
    expect(clickup.writeItems).toHaveLength(1); // still fans out
  });

  it("consumes the marker only ONCE — a later genuine edit DOES write", async () => {
    const jira = makeAdapter("jira");
    const state = makeState({
      bindings: [binding({ id: "ps_1" })],
      items: [item({ projectSyncId: "ps_1" })],
      installs: [install()],
    });
    markTaskInbound("jira", "task_1", "fields");
    const pg = makePg(state);
    // First emit is the echo → suppressed and consumes the marker.
    await emitTaskOutboundToProviders(
      pg,
      change({ prevTitle: "Old", nextTitle: "New" }),
      makeDeps({ jira }),
    );
    expect(jira.writeItems).toHaveLength(0);
    // A second, genuinely-new edit is no longer guarded → writes.
    await emitTaskOutboundToProviders(
      pg,
      change({ prevTitle: "New", nextTitle: "Newer" }),
      makeDeps({ jira }),
    );
    expect(jira.writeItems).toHaveLength(1);
    expect(jira.writeItems[0].title).toBe("Newer");
  });
});

describe("emitTaskOutboundToProviders — content-hash backstop", () => {
  it("skips a no-op (link already synced to identical content)", async () => {
    const jira = makeAdapter("jira");
    const state = makeState({
      bindings: [binding({ id: "ps_1" })],
      items: [item({ id: "tis_1", projectSyncId: "ps_1" })],
      installs: [install()],
    });
    const pg = makePg(state);
    // First emit writes + stores the outbound hash.
    await emitTaskOutboundToProviders(
      pg,
      change({ prevTitle: "Old", nextTitle: "New" }),
      makeDeps({ jira }),
    );
    expect(jira.writeItems).toHaveLength(1);
    const stored = state.hashWrites.at(-1);
    expect(stored?.hash).toBeTruthy();

    // Re-arm the item with that stored hash and re-emit the SAME resulting content — the
    // durable backstop skips it (survives a restart / our own echo).
    const jira2 = makeAdapter("jira");
    const state2 = makeState({
      bindings: [binding({ id: "ps_1" })],
      items: [item({ id: "tis_1", projectSyncId: "ps_1", lastSyncedHash: stored?.hash ?? null })],
      installs: [install()],
    });
    await emitTaskOutboundToProviders(
      makePg(state2),
      change({ prevTitle: "Whatever", nextTitle: "New" }),
      makeDeps({ jira: jira2 }),
    );
    expect(jira2.writeItems).toHaveLength(0);
  });
});

describe("emitTaskOutboundToProviders — reverse status map", () => {
  it("uses the mapping whose taskStateId == the task's current state (exact)", async () => {
    const jira = makeAdapter("jira");
    const state = makeState({
      bindings: [binding({ id: "ps_1" })],
      items: [item({ projectSyncId: "ps_1" })],
      mappings: [
        mapping({ projectSyncId: "ps_1", taskStateId: "state_done", sourceStatusName: "Done" }),
        mapping({ projectSyncId: "ps_1", taskStateId: "state_todo", sourceStatusName: "To Do" }),
      ],
      installs: [install()],
    });
    await emitTaskOutboundToProviders(
      makePg(state),
      change({ prevStateId: "state_todo", nextStateId: "state_done", nextStatus: "completed" }),
      makeDeps({ jira }),
    );
    expect(jira.writeStatuses).toHaveLength(1);
    expect(jira.writeStatuses[0].sourceStatusName).toBe("Done");
  });

  it("falls back to a deterministic in-group mapping when no exact state matches", async () => {
    const jira = makeAdapter("jira");
    const state = makeState({
      bindings: [binding({ id: "ps_1" })],
      items: [item({ projectSyncId: "ps_1" })],
      // Two "completed"-group mappings; the emit picks the sorted-first source name.
      mappings: [
        mapping({ projectSyncId: "ps_1", taskStateId: "state_done", sourceStatusName: "Zeta" }),
        mapping({ projectSyncId: "ps_1", taskStateId: "state_shipped", sourceStatusName: "Alpha" }),
      ],
      states: [
        { id: "state_done", group: "completed" },
        { id: "state_shipped", group: "completed" },
      ],
      installs: [install()],
    });
    await emitTaskOutboundToProviders(
      makePg(state),
      // The current state id has NO mapping row; the group is "completed".
      change({ prevStateId: "state_todo", nextStateId: "state_unmapped", nextStatus: "completed" }),
      makeDeps({ jira }),
    );
    expect(jira.writeStatuses).toHaveLength(1);
    expect(jira.writeStatuses[0].sourceStatusName).toBe("Alpha");
  });

  it("SKIPS the status write (no guess) when nothing maps", async () => {
    const jira = makeAdapter("jira");
    const state = makeState({
      bindings: [binding({ id: "ps_1" })],
      items: [item({ projectSyncId: "ps_1" })],
      mappings: [],
      states: [],
      installs: [install()],
    });
    await emitTaskOutboundToProviders(
      makePg(state),
      change({ prevStateId: "state_todo", nextStateId: "state_x", nextStatus: "started" }),
      makeDeps({ jira }),
    );
    expect(jira.writeStatuses).toHaveLength(0);
    // No field change + unresolved status = nothing written = no hash stamped.
    expect(state.hashWrites).toHaveLength(0);
  });
});

describe("emitTaskOutboundToProviders — best-effort isolation", () => {
  it("one binding throwing does not abort the others or throw to the caller", async () => {
    const jira = makeAdapter("jira", { throwOnWrite: true });
    const clickup = makeAdapter("clickup");
    const state = makeState({
      bindings: [
        binding({ id: "ps_j", provider: "jira", externalProjectId: "cloud_1/PROJ" }),
        binding({ id: "ps_c", provider: "clickup", externalProjectId: "space_9" }),
      ],
      items: [
        item({ id: "tis_j", projectSyncId: "ps_j", provider: "jira" }),
        item({
          id: "tis_c",
          projectSyncId: "ps_c",
          provider: "clickup",
          itemType: "task",
          itemNumber: "abc",
          providerItemId: "abc",
        }),
      ],
      installs: [install()],
    });
    await expect(
      emitTaskOutboundToProviders(
        makePg(state),
        change({ prevTitle: "Old", nextTitle: "New" }),
        makeDeps({ jira, clickup }),
      ),
    ).resolves.toBeUndefined();
    // Jira threw; ClickUp still got its write.
    expect(clickup.writeItems).toHaveLength(1);
  });

  it("no external link → no-op (no throw)", async () => {
    const jira = makeAdapter("jira");
    const state = makeState({ items: [] });
    await expect(
      emitTaskOutboundToProviders(
        makePg(state),
        change({ prevTitle: "Old", nextTitle: "New" }),
        makeDeps({ jira }),
      ),
    ).resolves.toBeUndefined();
    expect(jira.writeItems).toHaveLength(0);
  });
});
