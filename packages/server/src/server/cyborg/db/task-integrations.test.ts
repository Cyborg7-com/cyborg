import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb, closePool } from "./connection.js";
import * as schema from "./schema.js";
import { PgSync } from "./pg-sync.js";

const hasPg = !!process.env.DATABASE_URL;

// Data-layer contract for the provider-generic task integrations (Jira/ClickUp
// foundation). Exercises every new PgSync method end to end against real PG:
// - upsert idempotency (a re-bind returns the SAME id, doesn't duplicate);
// - the inbound webhook lookup getProjectSyncByExternal resolving WITHOUT a workspace
//   (a provider webhook carries only provider + external ids) and still returning the
//   binding's workspaceId;
// - the BOLA guard on deleteProjectSync (wrong-workspace id is a no-op) + its cascade
//   to task_item_syncs / status_mappings;
// - the duplicate-item guard (a DIFFERENT task can't claim an item already linked);
// - cross-tenant isolation of provider_user_connections.
// Skip-gated on DATABASE_URL like the other db/*.test.ts (no DB → clean skip).
describe.skipIf(!hasPg)("PgSync task-integration data layer (requires DATABASE_URL)", () => {
  let db: ReturnType<typeof getDb>;
  let pg: PgSync;

  const ownerId = randomUUID();
  const wsA = randomUUID();
  const wsB = randomUUID(); // a second tenant, for BOLA + isolation checks
  const projA = randomUUID(); // tasks_project in wsA
  const taskA = randomUUID();
  const taskA2 = randomUUID();
  const stateA = randomUUID(); // a task state to map onto

  const provider = "jira";
  const externalProjectId = "PROJ-CLOUD-123";

  beforeAll(async () => {
    db = getDb();
    pg = new PgSync();
    await db
      .insert(schema.users)
      .values({ id: ownerId, email: `tif-${ownerId}@e2e.dev`, name: "Owner" });
    await db.insert(schema.workspaces).values([
      { id: wsA, name: "TIF WS A", ownerId },
      { id: wsB, name: "TIF WS B", ownerId },
    ]);
    await db
      .insert(schema.tasksProjects)
      .values({ id: projA, workspaceId: wsA, identifier: "TIF" });
    await db.insert(schema.taskStates).values({
      id: stateA,
      projectId: projA,
      workspaceId: wsA,
      name: "In Progress",
      color: "#3b82f6",
      group: "started",
      sequence: 1,
    });
    await db.insert(schema.tasks).values([
      { id: taskA, workspaceId: wsA, title: "Synced task A", createdBy: ownerId, projectId: projA },
      {
        id: taskA2,
        workspaceId: wsA,
        title: "Synced task A2",
        createdBy: ownerId,
        projectId: projA,
      },
    ]);
  });

  afterAll(async () => {
    // workspace cascade drops project_syncs / task_item_syncs / status_mappings /
    // provider_user_connections / tasks_projects / tasks; then remove the user.
    await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, [wsA, wsB]));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
    await closePool();
  });

  it("upsertProjectSync is idempotent and getProjectSyncByExternal resolves without a workspace", async () => {
    const id = await pg.upsertProjectSync({
      workspaceId: wsA,
      provider,
      installationId: "inst-1",
      tasksProjectId: projA,
      externalProjectId,
      externalProjectName: "Cloud Project",
      externalUrl: "https://example.atlassian.net/browse/PROJ",
      createdBy: ownerId,
    });
    expect(id).toMatch(/^psync_/);

    // Re-bind (e.g. a rename) → SAME row id, refreshed fields, no duplicate.
    const id2 = await pg.upsertProjectSync({
      workspaceId: wsA,
      provider,
      installationId: "inst-2",
      tasksProjectId: projA,
      externalProjectId,
      externalProjectName: "Cloud Project (renamed)",
      createdBy: ownerId,
    });
    expect(id2).toBe(id);

    // The inbound webhook lookup: only provider + external id, yields the workspace.
    const byExternal = await pg.getProjectSyncByExternal(provider, externalProjectId);
    expect(byExternal).not.toBeNull();
    expect(byExternal?.id).toBe(id);
    expect(byExternal?.workspaceId).toBe(wsA);
    expect(byExternal?.installationId).toBe("inst-2");
    expect(byExternal?.externalProjectName).toBe("Cloud Project (renamed)");
    expect(byExternal?.syncDirection).toBe("inbound");

    // An unknown external project yields null.
    expect(await pg.getProjectSyncByExternal(provider, "NOPE-999")).toBeNull();

    const forProject = await pg.getProjectSyncsForTasksProject(projA);
    expect(forProject).toHaveLength(1);
    expect(forProject[0]?.id).toBe(id);
  });

  it("upsertTaskItemSync links an item to a task, is idempotent, and guards duplicate items", async () => {
    const psync = await pg.getProjectSyncByExternal(provider, externalProjectId);
    const projectSyncId = psync?.id;
    expect(projectSyncId).toBeDefined();
    if (!projectSyncId) return;

    const itemId = await pg.upsertTaskItemSync({
      projectSyncId,
      taskId: taskA,
      provider,
      itemType: "issue",
      itemNumber: "PROJ-123",
      providerItemId: "10001",
      itemUrl: "https://example.atlassian.net/browse/PROJ-123",
    });
    expect(itemId).toMatch(/^tisync_/);

    // Re-sync the same (binding, task) → SAME row, refreshed number/url.
    const itemId2 = await pg.upsertTaskItemSync({
      projectSyncId,
      taskId: taskA,
      provider,
      itemType: "issue",
      itemNumber: "PROJ-123",
      providerItemId: "10001",
      itemUrl: "https://example.atlassian.net/browse/PROJ-123?updated",
    });
    expect(itemId2).toBe(itemId);

    // The receiver's hot inbound lookup by (binding, type, number).
    const byExternal = await pg.getTaskItemByExternal(projectSyncId, "issue", "PROJ-123");
    expect(byExternal?.id).toBe(itemId);
    expect(byExternal?.taskId).toBe(taskA);
    expect(byExternal?.itemUrl).toContain("?updated");
    expect(byExternal?.lastSyncedHash).toBeNull();

    const forTask = await pg.getTaskItemsForTask(taskA);
    expect(forTask).toHaveLength(1);
    expect(forTask[0]?.id).toBe(itemId);

    // A DIFFERENT task claiming the SAME (binding, type, number) must be rejected by
    // UNIQUE(project_sync_id, item_type, item_number) — the duplicate-task guard.
    await expect(
      pg.upsertTaskItemSync({
        projectSyncId,
        taskId: taskA2,
        provider,
        itemType: "issue",
        itemNumber: "PROJ-123",
        providerItemId: "10001",
      }),
    ).rejects.toThrow();
  });

  it("setTaskItemLastSyncedHash sets and clears the echo backstop", async () => {
    const psync = await pg.getProjectSyncByExternal(provider, externalProjectId);
    const projectSyncId = psync?.id;
    if (!projectSyncId) throw new Error("missing project sync");
    const item = await pg.getTaskItemByExternal(projectSyncId, "issue", "PROJ-123");
    if (!item) throw new Error("missing item");

    await pg.setTaskItemLastSyncedHash(item.id, "hash-abc");
    let reloaded = await pg.getTaskItemByExternal(projectSyncId, "issue", "PROJ-123");
    expect(reloaded?.lastSyncedHash).toBe("hash-abc");

    await pg.setTaskItemLastSyncedHash(item.id, null);
    reloaded = await pg.getTaskItemByExternal(projectSyncId, "issue", "PROJ-123");
    expect(reloaded?.lastSyncedHash).toBeNull();
  });

  it("status mappings upsert/get/list are idempotent per (binding, source status)", async () => {
    const psync = await pg.getProjectSyncByExternal(provider, externalProjectId);
    const projectSyncId = psync?.id;
    if (!projectSyncId) throw new Error("missing project sync");

    const mapId = await pg.upsertStatusMapping({
      workspaceId: wsA,
      projectSyncId,
      provider,
      sourceStatusId: "3",
      sourceStatusName: "In Progress",
      taskStateId: stateA,
      skipBackward: true,
      createdBy: ownerId,
    });
    expect(mapId).toMatch(/^stmap_/);

    // Re-save the same source status → SAME row, refreshed target/flag.
    const mapId2 = await pg.upsertStatusMapping({
      workspaceId: wsA,
      projectSyncId,
      provider,
      sourceStatusName: "In Progress",
      taskStateId: null,
      skipBackward: false,
      createdBy: ownerId,
    });
    expect(mapId2).toBe(mapId);

    const got = await pg.getStatusMapping(projectSyncId, "In Progress");
    expect(got?.id).toBe(mapId);
    expect(got?.taskStateId).toBeNull();
    expect(got?.skipBackward).toBe(false);

    // A second distinct source status is its own row.
    await pg.upsertStatusMapping({
      workspaceId: wsA,
      projectSyncId,
      provider,
      sourceStatusName: "Done",
      taskStateId: stateA,
      createdBy: ownerId,
    });
    const all = await pg.listStatusMappings(projectSyncId);
    expect(all).toHaveLength(2);
    expect(await pg.getStatusMapping(projectSyncId, "Unmapped")).toBeNull();
  });

  it("provider user connections upsert/get are idempotent and workspace-isolated", async () => {
    const connId = await pg.upsertProviderUserConnection({
      workspaceId: wsA,
      provider,
      cyborgUserId: ownerId,
      externalUserId: "jira-user-1",
      externalEmail: "owner@example.com",
    });
    expect(connId).toMatch(/^puconn_/);

    const connId2 = await pg.upsertProviderUserConnection({
      workspaceId: wsA,
      provider,
      cyborgUserId: ownerId,
      externalUserId: "jira-user-1b",
    });
    expect(connId2).toBe(connId);

    const got = await pg.getProviderUserConnection(wsA, provider, ownerId);
    expect(got?.id).toBe(connId);
    expect(got?.externalUserId).toBe("jira-user-1b");
    expect(got?.externalEmail).toBeNull();

    // A different tenant has no mapping for the same cyborg user.
    expect(await pg.getProviderUserConnection(wsB, provider, ownerId)).toBeNull();
  });

  it("deleteProjectSync is BOLA-guarded and cascades to items + mappings", async () => {
    const psync = await pg.getProjectSyncByExternal(provider, externalProjectId);
    const id = psync?.id;
    if (!id) throw new Error("missing project sync");

    // Wrong workspace → no-op (the binding survives).
    await pg.deleteProjectSync(id, wsB);
    expect(await pg.getProjectSyncByExternal(provider, externalProjectId)).not.toBeNull();

    // Owning workspace → removed, cascading its item-sync + status-mapping rows.
    await pg.deleteProjectSync(id, wsA);
    expect(await pg.getProjectSyncByExternal(provider, externalProjectId)).toBeNull();
    expect(await pg.getProjectSyncsForTasksProject(projA)).toHaveLength(0);
    expect(await pg.getTaskItemsForTask(taskA)).toHaveLength(0);
    expect(await pg.listStatusMappings(id)).toHaveLength(0);
  });
});
