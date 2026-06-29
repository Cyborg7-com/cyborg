/* eslint-disable @typescript-eslint/no-explicit-any */
// Bug T2 (cross-workspace isolation) + Bug T3 (deleted cybo resurrects), proven at
// the daemon dispatcher / SQLite layer.
//
// T2: a cybo created in workspace A must NOT appear in workspace B's roster. The
//     entity list (fetch_cybos) is scoped to the requested workspace, so a cybo
//     never leaks across the boundary.
// T3: deleting a cybo must STICK. The prune resolves the cybo tolerantly (by exact
//     id OR slug within the workspace), so the relay's delete fan-out — which targets
//     the canonical PG id while a daemon may hold a slug-derived local id — still
//     removes the SQLite row. A re-fetch after delete must not bring it back. A
//     delete for a cybo this daemon doesn't hold is an idempotent no-op, never a
//     "Cybo not found" error (the relay fans the delete out to every workspace daemon,
//     so most receive a delete for a cybo they never had).
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

describe("cybo workspace isolation + durable delete", () => {
  let storage: DualStorage;
  let auth: CyborgAuth;
  let workspaceManager: WorkspaceManager;
  let dispatcher: CyborgDispatcher;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cybo-iso-del-"));
    storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "test.db")), null);
    auth = new CyborgAuth(storage);
    workspaceManager = new WorkspaceManager(storage);
    const broadcast: BroadcastFn = { toWorkspace() {}, toUser() {} };
    const messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
    dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);
  });

  afterEach(() => {
    storage.close();
    const dbPath = path.join(tmpDir, "test.db");
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
    }
  });

  function ctx(email: string, name: string) {
    return auth.validateToken(auth.createToken(email, name))!;
  }

  async function dispatch(msg: Record<string, unknown>, authCtx: ReturnType<typeof ctx>) {
    const emitted: unknown[] = [];
    await dispatcher.dispatch(msg as any, authCtx, (m) => emitted.push(m));
    return emitted;
  }

  async function createWorkspace(owner: ReturnType<typeof ctx>, name: string): Promise<string> {
    const resp = await dispatch(
      { type: "cyborg:create_workspace", name, requestId: `ws-${name}` },
      owner,
    );
    return (resp[0] as any).payload.workspace.id;
  }

  async function createCybo(
    owner: ReturnType<typeof ctx>,
    workspaceId: string,
    slug: string,
  ): Promise<string> {
    const resp = await dispatch(
      {
        type: "cyborg:create_cybo",
        requestId: `cc-${slug}`,
        workspaceId,
        slug,
        name: slug,
        soul: "you are a test cybo",
        provider: "pi",
      },
      owner,
    );
    const created = resp.find((m: any) => m.type === "cyborg:create_cybo_response") as any;
    return created.payload.cybo.id;
  }

  async function fetchCyboIds(
    owner: ReturnType<typeof ctx>,
    workspaceId: string,
  ): Promise<string[]> {
    const resp = await dispatch(
      { type: "cyborg:fetch_cybos", workspaceId, requestId: `fc-${workspaceId}` },
      owner,
    );
    const list = resp.find((m: any) => m.type === "cyborg:fetch_cybos_response") as any;
    return (list.payload.cybos as any[]).map((c) => c.id);
  }

  it("T2: a cybo created in workspace A does not appear in workspace B's roster", async () => {
    const owner = ctx("owner@test.com", "Owner");
    const wsA = await createWorkspace(owner, "Alpha");
    const wsB = await createWorkspace(owner, "Bravo");

    const apexId = await createCybo(owner, wsA, "apex");

    expect(await fetchCyboIds(owner, wsA)).toContain(apexId);
    // The isolation contract: not visible in another workspace's list.
    expect(await fetchCyboIds(owner, wsB)).not.toContain(apexId);
  });

  it("T3: a deleted cybo stays deleted across a re-fetch (no resurrection)", async () => {
    const owner = ctx("owner@test.com", "Owner");
    const wsA = await createWorkspace(owner, "Alpha");
    const cyboId = await createCybo(owner, wsA, "apex");
    expect(await fetchCyboIds(owner, wsA)).toContain(cyboId);

    const delResp = await dispatch(
      { type: "cyborg:delete_cybo", workspaceId: wsA, cyboId, requestId: "del-1" },
      owner,
    );
    const ok = delResp.find((m: any) => m.type === "cyborg:delete_cybo_response") as any;
    expect(ok.payload.deleted).toBe(true);
    expect(delResp.find((m: any) => m.type === "cyborg:error")).toBeUndefined();

    // Re-fetch (the path that used to re-surface the surviving SQLite row).
    expect(await fetchCyboIds(owner, wsA)).not.toContain(cyboId);
  });

  it("T3: a delete that targets the cybo's SLUG still prunes it (fan-out id tolerance)", async () => {
    // The relay's delete fan-out targets the canonical PG id; a daemon may hold the
    // row under a slug-derived id. Deleting by slug must resolve + prune the row.
    const owner = ctx("owner@test.com", "Owner");
    const wsA = await createWorkspace(owner, "Alpha");
    const cyboId = await createCybo(owner, wsA, "apex");

    const delResp = await dispatch(
      { type: "cyborg:delete_cybo", workspaceId: wsA, cyboId: "apex", requestId: "del-slug" },
      owner,
    );
    const ok = delResp.find((m: any) => m.type === "cyborg:delete_cybo_response") as any;
    expect(ok.payload.deleted).toBe(true);
    expect(await fetchCyboIds(owner, wsA)).not.toContain(cyboId);
  });

  it("T3: deleting a cybo this daemon doesn't hold is an idempotent no-op, not an error", async () => {
    // The relay fans the delete out to EVERY online workspace daemon — most receive a
    // delete for a cybo they never had. That must be a clean success, not a "Cybo not
    // found" error broadcast to all guests as a spurious toast.
    const owner = ctx("owner@test.com", "Owner");
    const wsA = await createWorkspace(owner, "Alpha");

    const resp = await dispatch(
      {
        type: "cyborg:delete_cybo",
        workspaceId: wsA,
        cyboId: "does-not-exist-here",
        requestId: "del-missing",
      },
      owner,
    );
    expect(resp.find((m: any) => m.type === "cyborg:error")).toBeUndefined();
    const ok = resp.find((m: any) => m.type === "cyborg:delete_cybo_response") as any;
    expect(ok.payload.deleted).toBe(true);
  });
});
