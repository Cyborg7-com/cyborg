import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { eq, and } from "drizzle-orm";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { PgSync } from "./db/pg-sync.js";
import { getDb, closePool } from "./db/connection.js";
import * as schema from "./db/schema.js";

const hasPg = !!process.env.DATABASE_URL;

function settle(ms = 500): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("DualStorage — solo mode", () => {
  let storage: DualStorage;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "dual-solo-"));
    const sqlite = new CyborgStorage(path.join(tmpDir, "test.db"));
    storage = new DualStorage(sqlite, null);
  });

  afterEach(async () => {
    await storage.close();
  });

  it("reports solo mode when pg is null", () => {
    expect(storage.mode).toBe("solo");
  });

  it("full CRUD works through SQLite only", () => {
    const user = storage.upsertUser("solo@test.dev", "Solo User");
    expect(user.email).toBe("solo@test.dev");

    const ws = storage.createWorkspace("Solo WS", user.id);
    expect(ws.name).toBe("Solo WS");

    const channels = storage.getChannels(ws.id);
    expect(channels.length).toBeGreaterThanOrEqual(1);
    const general = channels.find((c) => c.name === "general");
    expect(general).toBeDefined();

    const msg = storage.insertMessage({
      workspaceId: ws.id,
      channelId: general!.id,
      fromId: user.id,
      fromType: "human",
      text: "hello solo",
    });
    expect(msg.text).toBe("hello solo");

    const fetched = storage.getMessages({ channelId: general!.id });
    expect(fetched).toHaveLength(1);
    expect(fetched[0].text).toBe("hello solo");

    // Project-agnostic seed: a project-less channel routes the task to the
    // workspace Inbox, satisfying the require-project resolver.
    const task = storage.createTask({
      workspaceId: ws.id,
      title: "Solo task",
      createdBy: user.id,
      channelId: "no-project-channel",
    });
    expect(task.title).toBe("Solo task");

    const tasks = storage.getTasks(ws.id);
    expect(tasks).toHaveLength(1);
  });

  it("getAllWorkspaceIds returns all workspace IDs", () => {
    const user = storage.upsertUser("ids@test.dev", "IDs User");
    expect(storage.getAllWorkspaceIds()).toHaveLength(0);

    const ws1 = storage.createWorkspace("WS One", user.id);
    const ws2 = storage.createWorkspace("WS Two", user.id);
    const ws3 = storage.createWorkspace("WS Three", user.id);

    const ids = storage.getAllWorkspaceIds();
    expect(ids).toHaveLength(3);
    expect(ids).toContain(ws1.id);
    expect(ids).toContain(ws2.id);
    expect(ids).toContain(ws3.id);
  });

  it("insertMessageRaw inserts a message with pre-assigned ID and seq", () => {
    const user = storage.upsertUser("raw@test.dev", "Raw User");
    const ws = storage.createWorkspace("Raw WS", user.id);
    const channels = storage.getChannels(ws.id);
    const general = channels.find((c) => c.name === "general")!;

    const customId = "custom-msg-id-123";
    storage.sqlite.insertMessageRaw({
      id: customId,
      workspaceId: ws.id,
      channelId: general.id,
      fromId: user.id,
      fromType: "human",
      toId: null,
      text: "raw message",
      mentions: null,
      parentId: null,
      seq: 42,
      createdAt: Date.now(),
    });

    const messages = storage.getMessages({ channelId: general.id });
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(customId);
    expect(messages[0].text).toBe("raw message");
    expect(messages[0].seq).toBe(42);
  });

  it("insertMessageRaw with mentions and parentId", () => {
    const user = storage.upsertUser("raw2@test.dev", "Raw2");
    const ws = storage.createWorkspace("Raw2 WS", user.id);
    const channels = storage.getChannels(ws.id);
    const general = channels.find((c) => c.name === "general")!;

    storage.sqlite.insertMessageRaw({
      id: "parent-msg",
      workspaceId: ws.id,
      channelId: general.id,
      fromId: user.id,
      fromType: "human",
      toId: null,
      text: "parent",
      mentions: null,
      parentId: null,
      seq: 1,
      createdAt: Date.now(),
    });

    storage.sqlite.insertMessageRaw({
      id: "reply-msg",
      workspaceId: ws.id,
      channelId: general.id,
      fromId: user.id,
      fromType: "agent",
      toId: null,
      text: "reply with mentions",
      mentions: ["user-a", "user-b"],
      parentId: "parent-msg",
      seq: 2,
      createdAt: Date.now(),
    });

    const messages = storage.getMessages({ channelId: general.id });
    expect(messages).toHaveLength(2);

    const reply = messages.find((m) => m.id === "reply-msg")!;
    expect(reply.from_type).toBe("agent");
    expect(reply.parent_id).toBe("parent-msg");
    expect(JSON.parse(reply.mentions!)).toEqual(["user-a", "user-b"]);
    expect(reply.seq).toBe(2);
  });

  it("insertMessageRaw does not overwrite existing message with same ID", () => {
    const user = storage.upsertUser("dedup@test.dev", "Dedup");
    const ws = storage.createWorkspace("Dedup WS", user.id);
    const channels = storage.getChannels(ws.id);
    const general = channels.find((c) => c.name === "general")!;

    storage.sqlite.insertMessageRaw({
      id: "dedup-id",
      workspaceId: ws.id,
      channelId: general.id,
      fromId: user.id,
      fromType: "human",
      toId: null,
      text: "original",
      mentions: null,
      parentId: null,
      seq: 1,
      createdAt: Date.now(),
    });

    // Inserting same ID should throw (PRIMARY KEY constraint)
    expect(() => {
      storage.sqlite.insertMessageRaw({
        id: "dedup-id",
        workspaceId: ws.id,
        channelId: general.id,
        fromId: user.id,
        fromType: "human",
        toId: null,
        text: "duplicate",
        mentions: null,
        parentId: null,
        seq: 2,
        createdAt: Date.now(),
      });
    }).toThrow();

    const messages = storage.getMessages({ channelId: general.id });
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("original");
  });

  it("ensureMembership refreshes a stale cached role to the authoritative one", () => {
    const owner = storage.upsertUser("owner@test.dev", "Owner");
    const ws = storage.createWorkspace("Shared WS", owner.id);

    // A member synced from the cloud at join time.
    const user = storage.upsertUser("member@test.dev", "Member");
    storage.addMember(ws.id, user.id, "member");
    expect(storage.getMembership(ws.id, user.id)?.role).toBe("member");

    // A relay-forwarded RPC carries the AUTHORITATIVE role (e.g. the user was since
    // promoted to admin in the cloud). ensureMembership must REFRESH the stale row,
    // not bail on it — otherwise the daemon's local permission check (getMembership)
    // judges a real admin/owner as a stale "member" and falsely denies create_cybo.
    storage.ensureMembership(ws.id, user.id, "admin");
    expect(storage.getMembership(ws.id, user.id)?.role).toBe("admin");

    // Idempotent: the same authoritative role again is a no-op (still admin).
    storage.ensureMembership(ws.id, user.id, "admin");
    expect(storage.getMembership(ws.id, user.id)?.role).toBe("admin");
  });

  it("ensureMembership still materializes a membership when none exists (FK-safe)", () => {
    // A forwarded cloud user id with no local user/workspace row must be created
    // without an FK crash (the original reconnect-storm guard) — preserved here.
    storage.ensureMembership("ws_forwarded_only", "cloud-user-xyz", "owner");
    expect(storage.getMembership("ws_forwarded_only", "cloud-user-xyz")?.role).toBe("owner");
  });

  it("upsertUser derives a DETERMINISTIC id from the email (same across stores)", () => {
    // The root-cause fix: two independent SQLite files must mint the SAME id for
    // the same email, so a daemon's local cache never diverges from the cloud id.
    const a = storage.upsertUser("Deterministic@Test.dev", "A");

    const otherDir = mkdtempSync(path.join(tmpdir(), "dual-solo-2-"));
    const other = new DualStorage(new CyborgStorage(path.join(otherDir, "test.db")), null);
    const b = other.upsertUser("deterministic@test.dev", "B");

    expect(a.id).toBe(b.id);
    // Case/whitespace-insensitive: trivial casing maps to one identity.
    expect(storage.upsertUser("  DETERMINISTIC@test.dev ").id).toBe(a.id);
  });

  it("upsertUser is idempotent and does not strand workspaces on re-resolution", () => {
    const user = storage.upsertUser("stable@test.dev", "Stable");
    const ws = storage.createWorkspace("Stable WS", user.id);
    expect(storage.getWorkspacesForUser(user.id).map((w) => w.id)).toContain(ws.id);

    // Resolving the same email again returns the same id and still sees the ws —
    // the auth path used to re-mint a fresh id here and read an EMPTY list.
    const again = storage.upsertUser("stable@test.dev");
    expect(again.id).toBe(user.id);
    expect(storage.getWorkspacesForUser(again.id).map((w) => w.id)).toContain(ws.id);
  });

  it("adoptCanonicalUserId re-keys a legacy row, migrating its memberships", () => {
    // Simulate a row minted under a legacy random id (pre-fix), with data.
    const sqlite = storage.sqlite;
    sqlite["db"]
      .prepare("INSERT INTO users (id, email, name, created_at) VALUES (?,?,?,?)")
      .run("legacy-random-id", "legacy@test.dev", "Legacy", Date.now());
    const ws = storage.createWorkspace("Legacy WS", "legacy-random-id");
    expect(storage.getMembership(ws.id, "legacy-random-id")?.role).toBe("owner");

    // Adopt the authoritative cloud id; memberships + ownership must follow.
    const adopted = storage.adoptCanonicalUserId("legacy@test.dev", "cloud-real-id");
    expect(adopted.id).toBe("cloud-real-id");
    expect(storage.getUserById("legacy-random-id")).toBeUndefined();
    expect(storage.getMembership(ws.id, "cloud-real-id")?.role).toBe("owner");
    expect(storage.getWorkspacesForUser("cloud-real-id").map((w) => w.id)).toContain(ws.id);
    expect(storage.getWorkspace(ws.id)?.owner_id).toBe("cloud-real-id");
  });
});

describe.skipIf(!hasPg)("DualStorage — connected mode (requires DATABASE_URL)", () => {
  let storage: DualStorage;
  let tmpDir: string;
  let db: ReturnType<typeof getDb>;
  let userIds: string[];
  let workspaceId: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "dual-connected-"));
    const sqlite = new CyborgStorage(path.join(tmpDir, "test.db"));
    const pg = new PgSync();
    storage = new DualStorage(sqlite, pg);
    db = getDb();
    userIds = [];
  });

  afterEach(async () => {
    if (workspaceId) {
      await db.delete(schema.auditLog).where(eq(schema.auditLog.workspaceId, workspaceId));
      await db
        .delete(schema.agentBindings)
        .where(eq(schema.agentBindings.workspaceId, workspaceId));
      await db.delete(schema.tasks).where(eq(schema.tasks.workspaceId, workspaceId));
      await db.delete(schema.messages).where(eq(schema.messages.workspaceId, workspaceId));
      await db.delete(schema.channels).where(eq(schema.channels.workspaceId, workspaceId));
      await db.delete(schema.memberships).where(eq(schema.memberships.workspaceId, workspaceId));
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    }
    for (const uid of userIds) {
      await db.delete(schema.users).where(eq(schema.users.id, uid));
    }
    workspaceId = "";
    userIds = [];
    await storage.close();
  });

  afterAll(async () => {
    if (hasPg) await closePool();
  });

  // Reach the PG layer directly for arranging cloud-side state in a test.
  function pgFor(s: DualStorage): PgSync {
    return s.pg!;
  }

  // A SEPARATE daemon (own empty SQLite) sharing the SAME cloud PG — to exercise
  // the "this store has never seen the workspace" hydration/reconcile paths.
  function freshDaemon(): DualStorage {
    const dir = mkdtempSync(path.join(tmpdir(), "dual-fresh-"));
    return new DualStorage(new CyborgStorage(path.join(dir, "test.db")), new PgSync());
  }

  async function createUserAndSettle(email: string, name: string) {
    const user = storage.upsertUser(email, name);
    userIds.push(user.id);
    await settle(800);
    return user;
  }

  async function createWorkspaceAndSettle(name: string, ownerId: string) {
    const ws = storage.createWorkspace(name, ownerId);
    workspaceId = ws.id;
    // createWorkspace chains 3 async PG writes: workspace → member → channel
    await settle(1500);
    return ws;
  }

  it("reports connected mode when pg is present", () => {
    expect(storage.mode).toBe("connected");
  });

  it("upsertUser syncs to PostgreSQL", async () => {
    const user = await createUserAndSettle("dual@test.dev", "Dual User");

    const [pgUser] = await db.select().from(schema.users).where(eq(schema.users.id, user.id));
    expect(pgUser).toBeDefined();
    expect(pgUser.email).toBe("dual@test.dev");
    expect(pgUser.name).toBe("Dual User");
  });

  it("createWorkspace syncs workspace, membership, and general channel to PG", async () => {
    const user = await createUserAndSettle("ws-owner@test.dev", "WS Owner");
    const ws = await createWorkspaceAndSettle("Dual WS", user.id);

    const [pgWs] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws.id));
    expect(pgWs).toBeDefined();
    expect(pgWs.name).toBe("Dual WS");

    const [pgMembership] = await db
      .select()
      .from(schema.memberships)
      .where(
        and(eq(schema.memberships.workspaceId, ws.id), eq(schema.memberships.userId, user.id)),
      );
    expect(pgMembership).toBeDefined();
    expect(pgMembership.role).toBe("owner");

    const pgChannels = await db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.workspaceId, ws.id));
    expect(pgChannels.length).toBeGreaterThanOrEqual(1);
    expect(pgChannels.some((c) => c.name === "general")).toBe(true);
  });

  it("createWorkspace ATOMICALLY lands the owner membership (no orphan)", async () => {
    // Bug 3: the owner membership must ALWAYS accompany the workspace row. Even
    // if a later step were to fail, the transaction guarantees the workspace is
    // never left membership-less (the orphan class found in prod).
    const user = await createUserAndSettle("atomic-owner@test.dev", "Atomic Owner");
    const ws = await createWorkspaceAndSettle("Atomic WS", user.id);

    const memberships = await db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.workspaceId, ws.id));
    expect(memberships).toHaveLength(1);
    expect(memberships[0].userId).toBe(user.id);
    expect(memberships[0].role).toBe("owner");
    // getWorkspacesForUser (the visibility path) sees it — the orphan symptom.
    const visible = await pgFor(storage).getWorkspacesForUser(user.id);
    expect(visible.map((w) => w.id)).toContain(ws.id);
  });

  it("ensureMembership hydrates the REAL workspace name + owner from PG (not 'Remote')", async () => {
    // A real cloud workspace owned by someone else.
    const owner = await createUserAndSettle("real-owner@test.dev", "Real Owner");
    const ws = await createWorkspaceAndSettle("Real Cloud WS", owner.id);

    // A second daemon's SQLite has never seen this workspace; a forwarded RPC
    // arrives for a DIFFERENT member. The placeholder is materialized first, then
    // hydrated from PG — it must end up named "Real Cloud WS" owned by `owner`,
    // never the old "Remote"/caller-as-owner stub.
    const member = await createUserAndSettle("real-member@test.dev", "Real Member");
    await pgFor(storage).addMember(ws.id, member.id, "member", "active");

    const fresh = freshDaemon();
    fresh.ensureMembership(ws.id, member.id, "member");
    await settle(800); // let the async PG hydrate land

    expect(fresh.getWorkspace(ws.id)?.name).toBe("Real Cloud WS");
    expect(fresh.getWorkspace(ws.id)?.owner_id).toBe(owner.id);
    expect(fresh.getMembership(ws.id, member.id)?.role).toBe("member");
    fresh.sqlite.close();
  });

  it("reconcileUserFromPg adopts the PG account id and pulls the owner's workspaces", async () => {
    const user = await createUserAndSettle("recon@test.dev", "Recon");
    const ws = await createWorkspaceAndSettle("Recon WS", user.id);

    // A brand-new daemon: its SQLite has no rows yet. Reconciling on connect must
    // land the user (on PG's id) AND the workspace, named correctly.
    const fresh = freshDaemon();
    await fresh.reconcileUserFromPg("recon@test.dev", "Recon");

    expect(fresh.getUserByEmail("recon@test.dev")?.id).toBe(user.id);
    const visible = fresh.getWorkspacesForUser(user.id);
    expect(visible.map((w) => w.id)).toContain(ws.id);
    expect(fresh.getWorkspace(ws.id)?.name).toBe("Recon WS");
    fresh.sqlite.close();
  });

  it("insertMessage syncs to PG with correct fields", async () => {
    const user = await createUserAndSettle("msg-user@test.dev", "Msg User");
    const ws = await createWorkspaceAndSettle("Msg WS", user.id);

    const channels = storage.getChannels(ws.id);
    const general = channels.find((c) => c.name === "general")!;

    const msg = storage.insertMessage({
      workspaceId: ws.id,
      channelId: general.id,
      fromId: user.id,
      fromType: "human",
      text: "synced message",
      mentions: ["user_abc"],
    });

    await settle();

    const [pgMsg] = await db.select().from(schema.messages).where(eq(schema.messages.id, msg.id));
    expect(pgMsg).toBeDefined();
    expect(pgMsg.text).toBe("synced message");
    expect(pgMsg.fromId).toBe(user.id);
    expect(pgMsg.fromType).toBe("human");
    expect(pgMsg.channelId).toBe(general.id);
    expect(pgMsg.seq).toBe(msg.seq);
    expect(pgMsg.mentions).toEqual(["user_abc"]);
  });

  it("createTask syncs to PG", async () => {
    const user = await createUserAndSettle("task-user@test.dev", "Task User");
    const ws = await createWorkspaceAndSettle("Task WS", user.id);

    const task = storage.createTask({
      workspaceId: ws.id,
      title: "Synced task",
      createdBy: user.id,
      description: "test description",
      channelId: "no-project-channel",
    });

    await settle();

    const [pgTask] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
    expect(pgTask).toBeDefined();
    expect(pgTask.title).toBe("Synced task");
    expect(pgTask.description).toBe("test description");
    expect(pgTask.createdBy).toBe(user.id);
  });

  it("updateTask syncs to PG", async () => {
    const user = await createUserAndSettle("task-upd@test.dev", "Task Upd");
    const ws = await createWorkspaceAndSettle("Task Upd WS", user.id);

    const task = storage.createTask({
      workspaceId: ws.id,
      title: "Updatable task",
      createdBy: user.id,
      channelId: "no-project-channel",
    });
    await settle();

    storage.updateTask(task.id, { status: "done", priority: "high" });
    await settle();

    const [pgTask] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
    expect(pgTask).toBeDefined();
    // The bug this guards: updateTask used to write SQLite only, so PG kept the
    // stale status (a task shown "done" locally stayed "pending" in PG / cloud).
    expect(pgTask.status).toBe("done");
    expect(pgTask.priority).toBe("high");
  });

  it("updateTask persists dueAt and priority to PG (set then clear)", async () => {
    const user = await createUserAndSettle("task-due@test.dev", "Task Due");
    const ws = await createWorkspaceAndSettle("Task Due WS", user.id);

    const task = storage.createTask({
      workspaceId: ws.id,
      title: "Due-date task",
      createdBy: user.id,
      channelId: "no-project-channel",
    });
    await settle();

    // The bug this guards: a due-date / priority edit from the detail card was
    // dropped server-side (dueAt was stripped by the update schema and neither
    // field was forwarded into pg.updateTask) — only status ever saved.
    const dueAt = Date.UTC(2026, 0, 15, 9, 30); // epoch ms
    storage.updateTask(task.id, { dueAt, priority: "urgent" });
    await settle();

    const [set] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
    expect(set).toBeDefined();
    // due_at is a timestamp column; round-trips back to the same epoch ms.
    expect(set.dueAt?.getTime()).toBe(dueAt);
    expect(set.priority).toBe("urgent");

    // null clears the due date without touching priority.
    storage.updateTask(task.id, { dueAt: null });
    await settle();

    const [cleared] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
    expect(cleared.dueAt).toBeNull();
    expect(cleared.priority).toBe("urgent");
  });

  it("createChannel syncs to PG", async () => {
    const user = await createUserAndSettle("ch-user@test.dev", "Ch User");
    const ws = await createWorkspaceAndSettle("Ch WS", user.id);

    const ch = storage.createChannel(ws.id, "dev-chat", user.id, {
      description: "Dev discussion",
      isPrivate: true,
    });

    await settle();

    const [pgCh] = await db.select().from(schema.channels).where(eq(schema.channels.id, ch.id));
    expect(pgCh).toBeDefined();
    expect(pgCh.name).toBe("dev-chat");
    expect(pgCh.description).toBe("Dev discussion");
    expect(pgCh.isPrivate).toBe(true);
  });

  it("addMember syncs to PG", async () => {
    const owner = await createUserAndSettle("owner@test.dev", "Owner");
    const member = await createUserAndSettle("member@test.dev", "Member");
    const ws = await createWorkspaceAndSettle("Member WS", owner.id);

    storage.addMember(ws.id, member.id, "admin");

    await settle();

    const [pgMem] = await db
      .select()
      .from(schema.memberships)
      .where(
        and(eq(schema.memberships.workspaceId, ws.id), eq(schema.memberships.userId, member.id)),
      );
    expect(pgMem).toBeDefined();
    expect(pgMem.role).toBe("admin");
  });

  it("audit syncs to PG", async () => {
    const user = await createUserAndSettle("audit-user@test.dev", "Audit User");
    const ws = await createWorkspaceAndSettle("Audit WS", user.id);

    storage.audit({
      workspaceId: ws.id,
      actorId: user.id,
      actorType: "human",
      action: "test_action",
      targetType: "workspace",
      targetId: ws.id,
      details: { reason: "testing" },
    });

    await settle();

    const pgAudit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.workspaceId, ws.id));
    expect(pgAudit.length).toBeGreaterThanOrEqual(1);
    const entry = pgAudit.find((a) => a.action === "test_action");
    expect(entry).toBeDefined();
    expect(entry!.actorId).toBe(user.id);
    expect(entry!.details).toEqual({ reason: "testing" });
  });

  it("SQLite and PG stay consistent for a full workspace flow", async () => {
    const user = await createUserAndSettle("full@test.dev", "Full Flow");
    const ws = await createWorkspaceAndSettle("Full WS", user.id);

    const ch = storage.createChannel(ws.id, "random", user.id, {
      description: "Random channel",
    });

    await settle();

    storage.insertMessage({
      workspaceId: ws.id,
      channelId: ch.id,
      fromId: user.id,
      fromType: "human",
      text: "first message",
    });

    storage.insertMessage({
      workspaceId: ws.id,
      channelId: ch.id,
      fromId: user.id,
      fromType: "human",
      text: "second message",
    });

    storage.createTask({
      workspaceId: ws.id,
      title: "Full flow task",
      createdBy: user.id,
      channelId: "no-project-channel",
    });

    await settle();

    // Verify SQLite state
    const sqliteMessages = storage.getMessages({ channelId: ch.id });
    expect(sqliteMessages).toHaveLength(2);

    const sqliteTasks = storage.getTasks(ws.id);
    expect(sqliteTasks).toHaveLength(1);

    // Verify PG state matches
    const pgMessages = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.channelId, ch.id));
    expect(pgMessages).toHaveLength(2);
    expect(pgMessages.map((m) => m.text).sort()).toEqual(["first message", "second message"]);

    const pgTasks = await db.select().from(schema.tasks).where(eq(schema.tasks.workspaceId, ws.id));
    expect(pgTasks).toHaveLength(1);
    expect(pgTasks[0].title).toBe("Full flow task");

    // Verify seq numbers are consistent
    const pgSeqs = pgMessages.map((m) => m.seq).sort((a, b) => a - b);
    const sqliteSeqs = sqliteMessages.map((m) => m.seq).sort((a, b) => a - b);
    expect(pgSeqs).toEqual(sqliteSeqs);
  });

  // ─── Agent bindings: durable session list (PG mirror) ─────────────
  // A non-ephemeral agent session must survive the owning daemon closing/restarting
  // so the cloud relay can still list it. These prove the SQLite→PG mirror that the
  // relay's list_agents offline fallback reads.

  it("createAgentBinding mirrors a NON-ephemeral session to PG (with the initiator email)", async () => {
    const user = await createUserAndSettle("binding-owner@test.dev", "Binding Owner");
    const ws = await createWorkspaceAndSettle("Binding WS", user.id);

    storage.createAgentBinding({
      agentId: "agent-durable-1",
      workspaceId: ws.id,
      provider: "claude",
      model: "claude-sonnet-4",
      daemonId: "daemon-X",
      initiatedBy: user.id,
      cwd: "/work/proj",
    });
    await settle();

    const rows = await pgFor(storage).getAgentBindingsByWorkspace(ws.id);
    const row = rows.find((r) => r.agentId === "agent-durable-1");
    expect(row).toBeDefined();
    expect(row!.provider).toBe("claude");
    expect(row!.model).toBe("claude-sonnet-4");
    expect(row!.daemonId).toBe("daemon-X");
    expect(row!.cwd).toBe("/work/proj");
    expect(row!.initiatedBy).toBe(user.id);
    // Resolved from SQLite at mirror time — the relay filters/bridges private
    // sessions on this stable identity (the local initiated_by id is daemon-scoped).
    expect(row!.initiatedByEmail).toBe("binding-owner@test.dev");
  });

  it("createAgentBinding prefers the caller's REAL email and NULLs a @remote.local resolution (#810)", async () => {
    const real = await createUserAndSettle("canonical@cyborg7.com", "Canonical");
    // A cloud-guest-shaped local row whose only email is the synthetic placeholder
    // (ensureUser stamps "<id>@remote.local"); created here as a real PG user so the
    // binding's initiated_by FK resolves.
    const ghost = await createUserAndSettle("ghost-guest@remote.local", "Ghost Guest");
    const ws = await createWorkspaceAndSettle("Email WS", real.id);

    // (a) the caller-supplied REAL email wins over the local-id lookup.
    storage.createAgentBinding({
      agentId: "agent-prefers-caller",
      workspaceId: ws.id,
      provider: "claude",
      daemonId: "daemon-X",
      initiatedBy: ghost.id, // local lookup would yield the @remote.local placeholder…
      initiatedByEmail: "canonical@cyborg7.com", // …but the caller's real email is preferred.
    });
    // (b) with NO caller email, a resolved @remote.local placeholder is stored NULL
    //     (never persist a known-fake email the offline filter could never match).
    storage.createAgentBinding({
      agentId: "agent-nulls-fake",
      workspaceId: ws.id,
      provider: "claude",
      daemonId: "daemon-X",
      initiatedBy: ghost.id,
    });
    await settle();

    const rows = await pgFor(storage).getAgentBindingsByWorkspace(ws.id);
    expect(rows.find((r) => r.agentId === "agent-prefers-caller")!.initiatedByEmail).toBe(
      "canonical@cyborg7.com",
    );
    expect(rows.find((r) => r.agentId === "agent-nulls-fake")!.initiatedByEmail).toBeNull();
  });

  it("deleteStaleAgentBindingsForOwner: prunes the owner's stale bindings, KEEPS live + peers, NO-OP on empty (#810)", async () => {
    const gcOwner = await createUserAndSettle("gc-owner@cyborg7.com", "GC Owner");
    const peer = await createUserAndSettle("gc-peer@cyborg7.com", "GC Peer");
    const ws = await createWorkspaceAndSettle("GC WS", gcOwner.id);
    const daemonId = "daemon-GC";

    // Owner: one LIVE + one STALE binding. Peer: one binding (must NEVER be touched).
    storage.createAgentBinding({
      agentId: "owner-live",
      workspaceId: ws.id,
      provider: "claude",
      daemonId,
      initiatedBy: gcOwner.id,
      initiatedByEmail: "gc-owner@cyborg7.com",
    });
    storage.createAgentBinding({
      agentId: "owner-stale",
      workspaceId: ws.id,
      provider: "claude",
      daemonId,
      initiatedBy: gcOwner.id,
      initiatedByEmail: "gc-owner@cyborg7.com",
    });
    storage.createAgentBinding({
      agentId: "peer-live",
      workspaceId: ws.id,
      provider: "claude",
      daemonId,
      initiatedBy: peer.id,
      initiatedByEmail: "gc-peer@cyborg7.com",
    });
    await settle();

    const pg = pgFor(storage);

    // EMPTY live set → NO-OP (never delete-all): returns 0, nothing removed.
    const noop = await pg.deleteStaleAgentBindingsForOwner({
      daemonId,
      workspaceId: ws.id,
      liveAgentIds: [],
      ownerGlobalId: gcOwner.id,
      ownerEmail: "gc-owner@cyborg7.com",
    });
    expect(noop).toBe(0);
    expect((await pg.getAgentBindingsByWorkspace(ws.id)).length).toBe(3);

    // Live set = [owner-live] → prunes ONLY owner-stale; keeps owner-live + peer-live.
    const deleted = await pg.deleteStaleAgentBindingsForOwner({
      daemonId,
      workspaceId: ws.id,
      liveAgentIds: ["owner-live"],
      ownerGlobalId: gcOwner.id,
      ownerEmail: "gc-owner@cyborg7.com",
    });
    expect(deleted).toBe(1);
    const remaining = (await pg.getAgentBindingsByWorkspace(ws.id)).map((r) => r.agentId).sort();
    expect(remaining).toEqual(["owner-live", "peer-live"]);
  });

  it("createAgentBinding does NOT mirror an EPHEMERAL summon to PG", async () => {
    const user = await createUserAndSettle("eph-owner@test.dev", "Eph Owner");
    const ws = await createWorkspaceAndSettle("Eph WS", user.id);

    storage.createAgentBinding({
      agentId: "agent-ephemeral-1",
      workspaceId: ws.id,
      provider: "claude",
      initiatedBy: user.id,
      ephemeral: true,
    });
    await settle();

    const rows = await pgFor(storage).getAgentBindingsByWorkspace(ws.id);
    expect(rows.find((r) => r.agentId === "agent-ephemeral-1")).toBeUndefined();
  });

  it("deleteAgentBinding removes the PG mirror row (archive path)", async () => {
    const user = await createUserAndSettle("del-owner@test.dev", "Del Owner");
    const ws = await createWorkspaceAndSettle("Del WS", user.id);

    storage.createAgentBinding({
      agentId: "agent-del-1",
      workspaceId: ws.id,
      provider: "codex",
      initiatedBy: user.id,
    });
    await settle();
    const before = await pgFor(storage).getAgentBindingsByWorkspace(ws.id);
    expect(before.some((r) => r.agentId === "agent-del-1")).toBe(true);

    storage.deleteAgentBinding("agent-del-1");
    await settle();
    const after = await pgFor(storage).getAgentBindingsByWorkspace(ws.id);
    expect(after.some((r) => r.agentId === "agent-del-1")).toBe(false);
  });

  it("updateAgentBindingModel + updateAgentBindingSession mirror to PG", async () => {
    const user = await createUserAndSettle("upd-owner@test.dev", "Upd Owner");
    const ws = await createWorkspaceAndSettle("Upd WS", user.id);

    storage.createAgentBinding({
      agentId: "agent-upd-1",
      workspaceId: ws.id,
      provider: "claude",
      model: "old-model",
      initiatedBy: user.id,
    });
    await settle();

    storage.updateAgentBindingModel("agent-upd-1", "new-model");
    storage.updateAgentBindingSession("agent-upd-1", "resume-xyz");
    await settle();

    const rows = await pgFor(storage).getAgentBindingsByWorkspace(ws.id);
    const row = rows.find((r) => r.agentId === "agent-upd-1");
    expect(row).toBeDefined();
    expect(row!.model).toBe("new-model");
    expect(row!.providerSessionId).toBe("resume-xyz");
  });
});
