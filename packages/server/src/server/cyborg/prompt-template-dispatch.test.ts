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

// #602 — prompt-template CRUD through the LOCAL dispatcher path (SQLite). Pins
// the workspace-member gating, the per-workspace unique name, body validation,
// and workspace isolation. The relay PG-direct path mirrors this exact shape;
// its PG-backed integration is covered separately (CTO runs against dev RDS).
describe("Cyborg7 prompt templates (#602) — dispatcher CRUD", () => {
  let storage: DualStorage;
  let auth: CyborgAuth;
  let workspaceManager: WorkspaceManager;
  let dispatcher: CyborgDispatcher;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-ptmpl-"));
    const dbPath = path.join(tmpDir, "test.db");
    storage = new DualStorage(new CyborgStorage(dbPath), null);
    auth = new CyborgAuth(storage);
    workspaceManager = new WorkspaceManager(storage);
    const broadcast: BroadcastFn = {
      toWorkspace() {},
      toUser() {},
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

  async function makeWorkspace(owner: ReturnType<typeof ctx>) {
    const wsResp = await dispatch(
      { type: "cyborg:create_workspace", name: "PT WS", requestId: "ws" },
      owner,
    );
    return (wsResp[0] as any).payload.workspace.id as string;
  }

  async function invite(
    owner: ReturnType<typeof ctx>,
    workspaceId: string,
    email: string,
    role: string,
    rid: string,
  ) {
    await dispatch(
      { type: "cyborg:invite_member", workspaceId, email, role, requestId: rid },
      owner,
    );
  }

  it("creates a template and lists it", async () => {
    const owner = ctx("owner@test.com", "Owner");
    const workspaceId = await makeWorkspace(owner);

    const createResp = await dispatch(
      {
        type: "cyborg:create_prompt_template",
        workspaceId,
        name: "Standup",
        body: "Standup for {channel} on {date}",
        requestId: "c1",
      },
      owner,
    );
    const created = (createResp[0] as any).payload;
    expect(created.ok).toBe(true);
    expect(created.op).toBe("create");
    expect(created.template.name).toBe("Standup");
    expect(created.template.body).toBe("Standup for {channel} on {date}");
    expect(created.template.createdBy).toBe(owner.user.id);

    const listResp = await dispatch(
      { type: "cyborg:list_prompt_templates", workspaceId, requestId: "l1" },
      owner,
    );
    const templates = (listResp[0] as any).payload.templates;
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe("Standup");
  });

  it("rejects a duplicate name in the same workspace", async () => {
    const owner = ctx("owner@test.com", "Owner");
    const workspaceId = await makeWorkspace(owner);

    await dispatch(
      {
        type: "cyborg:create_prompt_template",
        workspaceId,
        name: "Dup",
        body: "first",
        requestId: "c1",
      },
      owner,
    );
    const second = await dispatch(
      {
        type: "cyborg:create_prompt_template",
        workspaceId,
        name: "Dup",
        body: "second",
        requestId: "c2",
      },
      owner,
    );
    const payload = (second[0] as any).payload;
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("already exists");

    // Still only one row.
    const listResp = await dispatch(
      { type: "cyborg:list_prompt_templates", workspaceId, requestId: "l1" },
      owner,
    );
    expect((listResp[0] as any).payload.templates).toHaveLength(1);
  });

  it("updates a template body and renames it", async () => {
    const owner = ctx("owner@test.com", "Owner");
    const workspaceId = await makeWorkspace(owner);

    const createResp = await dispatch(
      {
        type: "cyborg:create_prompt_template",
        workspaceId,
        name: "Greeting",
        body: "hi {user}",
        requestId: "c1",
      },
      owner,
    );
    const id = (createResp[0] as any).payload.template.id;

    const updateResp = await dispatch(
      {
        type: "cyborg:update_prompt_template",
        workspaceId,
        id,
        name: "Welcome",
        body: "welcome {user} to {channel}",
        requestId: "u1",
      },
      owner,
    );
    const updated = (updateResp[0] as any).payload;
    expect(updated.ok).toBe(true);
    expect(updated.template.name).toBe("Welcome");
    expect(updated.template.body).toBe("welcome {user} to {channel}");
  });

  it("rejects renaming onto another template's name", async () => {
    const owner = ctx("owner@test.com", "Owner");
    const workspaceId = await makeWorkspace(owner);

    await dispatch(
      { type: "cyborg:create_prompt_template", workspaceId, name: "A", body: "a", requestId: "c1" },
      owner,
    );
    const bResp = await dispatch(
      { type: "cyborg:create_prompt_template", workspaceId, name: "B", body: "b", requestId: "c2" },
      owner,
    );
    const bId = (bResp[0] as any).payload.template.id;

    const renameResp = await dispatch(
      { type: "cyborg:update_prompt_template", workspaceId, id: bId, name: "A", requestId: "u1" },
      owner,
    );
    expect((renameResp[0] as any).payload.ok).toBe(false);
    expect((renameResp[0] as any).payload.error).toContain("already exists");
  });

  it("deletes a template", async () => {
    const owner = ctx("owner@test.com", "Owner");
    const workspaceId = await makeWorkspace(owner);

    const createResp = await dispatch(
      {
        type: "cyborg:create_prompt_template",
        workspaceId,
        name: "Temp",
        body: "x",
        requestId: "c1",
      },
      owner,
    );
    const id = (createResp[0] as any).payload.template.id;

    const deleteResp = await dispatch(
      { type: "cyborg:delete_prompt_template", workspaceId, id, requestId: "d1" },
      owner,
    );
    expect((deleteResp[0] as any).payload.ok).toBe(true);

    const listResp = await dispatch(
      { type: "cyborg:list_prompt_templates", workspaceId, requestId: "l1" },
      owner,
    );
    expect((listResp[0] as any).payload.templates).toHaveLength(0);
  });

  it("rejects an empty body on create (validation)", async () => {
    const owner = ctx("owner@test.com", "Owner");
    const workspaceId = await makeWorkspace(owner);

    const resp = await dispatch(
      {
        type: "cyborg:create_prompt_template",
        workspaceId,
        name: "Blank",
        // Zod min(1) actually rejects "" at parse time → the dispatcher throws and
        // emits cyborg:error; use a whitespace-only body (passes zod min, fails the
        // validator) to exercise the handler's own validation branch.
        body: "   ",
        requestId: "c1",
      },
      owner,
    );
    const out = resp[0] as any;
    // Either the zod layer (cyborg:error) or the handler (ok:false) rejects it;
    // both are acceptable "not created" outcomes — assert nothing was created.
    if (out.type === "cyborg:create_prompt_template_response") {
      expect(out.payload.ok).toBe(false);
    } else {
      expect(out.type).toBe("cyborg:error");
    }
    const listResp = await dispatch(
      { type: "cyborg:list_prompt_templates", workspaceId, requestId: "l1" },
      owner,
    );
    expect((listResp[0] as any).payload.templates).toHaveLength(0);
  });

  it("forbids a viewer from creating, but allows a member", async () => {
    const owner = ctx("owner@test.com", "Owner");
    const workspaceId = await makeWorkspace(owner);
    await invite(owner, workspaceId, "member@test.com", "member", "inv-m");
    await invite(owner, workspaceId, "viewer@test.com", "viewer", "inv-v");
    const member = ctx("member@test.com", "Member");
    const viewer = ctx("viewer@test.com", "Viewer");

    const viewerResp = await dispatch(
      {
        type: "cyborg:create_prompt_template",
        workspaceId,
        name: "ByViewer",
        body: "no",
        requestId: "cv",
      },
      viewer,
    );
    expect((viewerResp[0] as any).payload.ok).toBe(false);

    const memberResp = await dispatch(
      {
        type: "cyborg:create_prompt_template",
        workspaceId,
        name: "ByMember",
        body: "yes {user}",
        requestId: "cm",
      },
      member,
    );
    expect((memberResp[0] as any).payload.ok).toBe(true);
  });

  it("isolates templates per workspace (same name allowed in different workspaces)", async () => {
    const owner = ctx("owner@test.com", "Owner");
    const wsA = await makeWorkspace(owner);
    const wsBResp = await dispatch(
      { type: "cyborg:create_workspace", name: "PT WS B", requestId: "wsB" },
      owner,
    );
    const wsB = (wsBResp[0] as any).payload.workspace.id;

    await dispatch(
      {
        type: "cyborg:create_prompt_template",
        workspaceId: wsA,
        name: "Same",
        body: "a",
        requestId: "c1",
      },
      owner,
    );
    const bResp = await dispatch(
      {
        type: "cyborg:create_prompt_template",
        workspaceId: wsB,
        name: "Same",
        body: "b",
        requestId: "c2",
      },
      owner,
    );
    // Same name in a DIFFERENT workspace is fine.
    expect((bResp[0] as any).payload.ok).toBe(true);

    const listA = await dispatch(
      { type: "cyborg:list_prompt_templates", workspaceId: wsA, requestId: "lA" },
      owner,
    );
    expect((listA[0] as any).payload.templates).toHaveLength(1);
    expect((listA[0] as any).payload.templates[0].body).toBe("a");
  });
});
