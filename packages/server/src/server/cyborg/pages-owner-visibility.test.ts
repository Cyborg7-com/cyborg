/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { CyborgAuth, type CyborgAuthContext } from "./auth.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MessageRouter, type BroadcastFn } from "./message-router.js";
import { CyborgDispatcher } from "./dispatcher.js";
import { isPageRestrictedFromUser, pageBroadcastPayload } from "./page-access.js";

// Security regression net for the page owner-visibility gate (private pages are
// OWNER-ONLY): the list filter, the single-fetch access check, and the
// update/archive/delete write gates. Driven through the REAL dispatcher + real
// SQLite (DualStorage solo, pg = null) — no mocks. Two members of one workspace,
// A (owner) and B (member): both pass the membership gate, so the only thing
// restricting B is the owner gate. Product rule: a page is visible/writable iff
// `visibility = 'public' OR ownedBy IS NULL OR ownedBy = userId` (legacy null-owner
// pages stay public to everyone). Single flat describe (no nesting) to stay inside
// oxlint's max-nested-callbacks limit, matching task-mutations.test.ts.

describe("Pages — owner-only private visibility (solo, real dispatcher + SQLite)", () => {
  let sqlite: CyborgStorage;
  let storage: DualStorage;
  let auth: CyborgAuth;
  let dispatcher: CyborgDispatcher;
  let broadcasted: unknown[];
  let tmpDir: string;
  let dbPath: string;
  let workspaceId: string;
  let projectId: string;
  let userA: CyborgAuthContext;
  let userB: CyborgAuthContext;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "pages-owner-"));
    dbPath = path.join(tmpDir, "test.db");
    sqlite = new CyborgStorage(dbPath);
    storage = new DualStorage(sqlite, null);
    auth = new CyborgAuth(storage);
    const workspaceManager = new WorkspaceManager(storage);
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

    userA = auth.validateToken(auth.createToken("a@test.com", "Alice"))!;
    userB = auth.validateToken(auth.createToken("b@test.com", "Bob"))!;

    // A owns the workspace; B joins as a member (so B passes the view gate).
    const wsResp = await dispatch(
      { type: "cyborg:create_workspace", name: "Pages WS", requestId: "ws" },
      userA,
    );
    workspaceId = (wsResp[0] as any).payload.workspace.id;
    await dispatch(
      {
        type: "cyborg:invite_member",
        workspaceId,
        email: "b@test.com",
        role: "member",
        requestId: "inv",
      },
      userA,
    );

    // The per-workspace Inbox Tasks-project is a stable, member-visible project id
    // to hang pages off (the dispatcher resolves a tasks_projects id directly).
    projectId = sqlite.getOrCreateInboxProject(workspaceId).id;
  });

  afterEach(() => {
    // Close the SQLite handle BEFORE removing the temp dir — on Windows a still-open
    // handle blocks deletion. The finally guarantees the dir is wiped even if a test
    // (or storage.close()) throws.
    try {
      storage.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  async function dispatch(msg: Record<string, unknown>, authCtx: CyborgAuthContext) {
    const emitted: unknown[] = [];
    await dispatcher.dispatch(msg as any, authCtx, (m) => emitted.push(m));
    return emitted;
  }

  function emittedOfType(emitted: unknown[], type: string): any {
    return emitted.find((m: any) => m.type === type);
  }

  // Create a page through the dispatcher as `authCtx` (ownedBy = that user,
  // visibility defaults to "private"). Returns the new page id.
  async function createPageAs(authCtx: CyborgAuthContext, title: string): Promise<string> {
    const resp = await dispatch(
      { type: "cyborg:create_page", projectId, title, requestId: "cp" },
      authCtx,
    );
    return emittedOfType(resp, "cyborg:create_page_response").payload.page.id;
  }

  // pages_changed broadcasts go to the whole workspace (broadcast.toWorkspace), so
  // the payload captured in `broadcasted` is byte-for-byte what EVERY member —
  // including non-owner B — receives. Asserting a private page's payload is
  // stripped at the SOURCE therefore proves B never receives its title/content.
  function pagesChangedFor(pageId: string): any[] {
    return broadcasted.filter(
      (m: any) => m?.type === "cyborg:pages_changed" && m?.payload?.page?.id === pageId,
    );
  }

  it("getProjectPages: A's private page is visible to A, hidden from B; null-owner + public visible to both", () => {
    const aPrivate = storage.createPage({ projectId, title: "A private", ownedBy: userA.user.id });
    const legacyNullOwner = storage.createPage({ projectId, title: "Legacy", ownedBy: null });
    const aPublic = storage.createPage({ projectId, title: "A public", ownedBy: userA.user.id });
    storage.updatePage(aPublic.id, { visibility: "public" });

    const forA = storage.getProjectPages(projectId, userA.user.id).map((p) => p.id);
    const forB = storage.getProjectPages(projectId, userB.user.id).map((p) => p.id);

    // A (the owner) sees everything.
    expect(forA).toContain(aPrivate.id);
    expect(forA).toContain(legacyNullOwner.id);
    expect(forA).toContain(aPublic.id);

    // B sees the public + legacy null-owner pages, but NOT A's private page.
    expect(forB).not.toContain(aPrivate.id);
    expect(forB).toContain(legacyNullOwner.id);
    expect(forB).toContain(aPublic.id);
  });

  it("fetch_pages: B's list excludes A's private page but A's list includes it", async () => {
    const pageId = await createPageAs(userA, "Secret");

    const aList = await dispatch({ type: "cyborg:fetch_pages", projectId, requestId: "fa" }, userA);
    const bList = await dispatch({ type: "cyborg:fetch_pages", projectId, requestId: "fb" }, userB);

    const aIds = emittedOfType(aList, "cyborg:fetch_pages_response").payload.pages.map(
      (p: any) => p.id,
    );
    const bIds = emittedOfType(bList, "cyborg:fetch_pages_response").payload.pages.map(
      (p: any) => p.id,
    );
    expect(aIds).toContain(pageId);
    expect(bIds).not.toContain(pageId);
  });

  it("fetch_page: B gets null for A's private page; A gets the page", async () => {
    const pageId = await createPageAs(userA, "Secret");

    const bResp = await dispatch({ type: "cyborg:fetch_page", pageId, requestId: "fpb" }, userB);
    expect(emittedOfType(bResp, "cyborg:fetch_page_response").payload.page).toBeNull();

    const aResp = await dispatch({ type: "cyborg:fetch_page", pageId, requestId: "fpa" }, userA);
    expect(emittedOfType(aResp, "cyborg:fetch_page_response").payload.page.id).toBe(pageId);
  });

  it("fetch_page: a legacy null-owner private page is visible to BOTH A and B", async () => {
    const legacy = storage.createPage({ projectId, title: "Legacy", ownedBy: null });

    const aResp = await dispatch(
      { type: "cyborg:fetch_page", pageId: legacy.id, requestId: "la" },
      userA,
    );
    const bResp = await dispatch(
      { type: "cyborg:fetch_page", pageId: legacy.id, requestId: "lb" },
      userB,
    );
    expect(emittedOfType(aResp, "cyborg:fetch_page_response").payload.page.id).toBe(legacy.id);
    expect(emittedOfType(bResp, "cyborg:fetch_page_response").payload.page.id).toBe(legacy.id);
  });

  it("update_page: B cannot edit A's private page (forbidden), but A can toggle it public and then B sees it", async () => {
    const pageId = await createPageAs(userA, "Secret");

    // B's edit attempt is rejected with a forbidden error and no update response.
    const bEdit = await dispatch(
      { type: "cyborg:update_page", pageId, title: "hacked", requestId: "ub" },
      userB,
    );
    const bErr = emittedOfType(bEdit, "cyborg:error");
    expect(bErr).toBeDefined();
    expect(bErr.payload.code).toBe("forbidden");
    expect(emittedOfType(bEdit, "cyborg:update_page_response")).toBeUndefined();
    // The title did not change.
    expect(storage.getPage(pageId)?.title).toBe("Secret");

    // The OWNER toggling their own private page to public still works…
    const aToggle = await dispatch(
      { type: "cyborg:update_page", pageId, visibility: "public", requestId: "ua" },
      userA,
    );
    expect(emittedOfType(aToggle, "cyborg:update_page_response").payload.page.visibility).toBe(
      "public",
    );

    // …and now B can both list and fetch it.
    const bList = await dispatch(
      { type: "cyborg:fetch_pages", projectId, requestId: "fb2" },
      userB,
    );
    const bIds = emittedOfType(bList, "cyborg:fetch_pages_response").payload.pages.map(
      (p: any) => p.id,
    );
    expect(bIds).toContain(pageId);
    const bFetch = await dispatch({ type: "cyborg:fetch_page", pageId, requestId: "fpb2" }, userB);
    expect(emittedOfType(bFetch, "cyborg:fetch_page_response").payload.page.id).toBe(pageId);
  });

  it("delete_page: B cannot delete A's private page (forbidden); the page survives", async () => {
    const pageId = await createPageAs(userA, "Secret");

    const bDelete = await dispatch({ type: "cyborg:delete_page", pageId, requestId: "db" }, userB);
    const bErr = emittedOfType(bDelete, "cyborg:error");
    expect(bErr).toBeDefined();
    expect(bErr.payload.code).toBe("forbidden");
    expect(emittedOfType(bDelete, "cyborg:delete_page_response")).toBeUndefined();
    // The row is still there.
    expect(storage.getPage(pageId)?.id).toBe(pageId);
  });

  it("isPageRestrictedFromUser: only a non-null-owner non-public page hides from a non-owner", () => {
    const owner = "user_a";
    const other = "user_b";
    // Private + owned by someone else → restricted.
    expect(isPageRestrictedFromUser({ visibility: "private", ownedBy: owner }, other)).toBe(true);
    // Private + owned by the caller → not restricted.
    expect(isPageRestrictedFromUser({ visibility: "private", ownedBy: owner }, owner)).toBe(false);
    // Private + legacy null owner → not restricted (treated as public).
    expect(isPageRestrictedFromUser({ visibility: "private", ownedBy: null }, other)).toBe(false);
    // Public → never restricted, regardless of owner.
    expect(isPageRestrictedFromUser({ visibility: "public", ownedBy: owner }, other)).toBe(false);
    // Hardening: an out-of-enum visibility on an owned page is restricted (the gate
    // is the complement of `= public`, so a future value can't open a gap).
    expect(isPageRestrictedFromUser({ visibility: "secret", ownedBy: owner }, other)).toBe(true);
  });

  // ─── pages_changed BROADCAST confidentiality (the leak this fix closes) ───
  // A non-owner must never receive a private page's title/content over the wire,
  // even though the UI also refetches and hides it. The broadcast payload is
  // stripped at the source for private pages on BOTH transports (daemon dispatcher
  // here; the relay shares the same pageBroadcastPayload helper).

  it("pages_changed broadcast: a PRIVATE page's created/updated event carries no title/content", async () => {
    const pageId = await createPageAs(userA, "Top secret title");

    // The create broadcast for A's private page must not carry its title/content.
    const created = pagesChangedFor(pageId).find((m: any) => m.payload.op === "created");
    expect(created).toBeDefined();
    expect(created.payload.page.visibility).toBe("private");
    expect(created.payload.page.title).toBeUndefined();
    expect(created.payload.page.content).toBeUndefined();

    // The owner editing title + content still broadcasts only id + visibility.
    await dispatch(
      {
        type: "cyborg:update_page",
        pageId,
        title: "Secret v2",
        content: "classified body",
        requestId: "upx",
      },
      userA,
    );
    const updated = pagesChangedFor(pageId).find((m: any) => m.payload.op === "updated");
    expect(updated).toBeDefined();
    expect(updated.payload.page.title).toBeUndefined();
    expect(updated.payload.page.content).toBeUndefined();
  });

  it("pages_changed broadcast: a PUBLIC page's event carries the full row (reaches every member)", async () => {
    const pageId = await createPageAs(userA, "Open title");

    // The owner flips it public — the broadcast now carries the real row.
    await dispatch(
      { type: "cyborg:update_page", pageId, visibility: "public", requestId: "pubx" },
      userA,
    );
    const pub = pagesChangedFor(pageId).find(
      (m: any) => m.payload.op === "updated" && m.payload.page.visibility === "public",
    );
    expect(pub).toBeDefined();
    expect(pub.payload.page.title).toBe("Open title");
  });

  it("pageBroadcastPayload: strips a private owned page to id+visibility; keeps public + null-owner full", () => {
    const priv = {
      id: "p1",
      visibility: "private",
      ownedBy: "user_a",
      title: "secret",
      content: "body",
    };
    // A non-public owned page → only id + visibility cross the wire.
    expect(pageBroadcastPayload(priv)).toEqual({ id: "p1", visibility: "private" });
    // Public → returned unchanged (full row keeps fanning out for the live refresh).
    const pub = { id: "p2", visibility: "public", ownedBy: "user_a", title: "open" };
    expect(pageBroadcastPayload(pub)).toBe(pub);
    // Legacy null-owner → treated as public, returned unchanged.
    const legacy = { id: "p3", visibility: "private", ownedBy: null, title: "legacy" };
    expect(pageBroadcastPayload(legacy)).toBe(legacy);
  });
});
