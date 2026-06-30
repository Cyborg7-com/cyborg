import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { CyborgAuth } from "./auth.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MessageRouter, type BroadcastFn } from "./message-router.js";
import { CyborgDispatcher } from "./dispatcher.js";
import type { CyborgAuthContext } from "./auth.js";

// D1: `cyborg:fetch_cybo` (the editor's lazy soul-load) used a STRICT id lookup
// (storage.getCybo(id) ?? resolveLocalCybo(id)) and returned `cybo: null`
// whenever the client's roster id didn't byte-match the answering daemon's local
// id — e.g. a `local:<slug>` id or a bare slug from a pre-merge roster. That
// surfaced in the UI as "The daemon answered but didn't return this cybo" and
// locked saving. The fix makes the handler resolve tolerantly (exact id → slug →
// disk), mirroring resolveCybo (the resolver the mutation handlers already use).

interface Emitted {
  type: string;
  payload: Record<string, unknown>;
}

describe("cyborg:fetch_cybo (tolerant resolution)", () => {
  let storage: DualStorage;
  let sqlite: CyborgStorage;
  let auth: CyborgAuth;
  let dispatcher: CyborgDispatcher;
  let tmpDir: string;
  let owner: CyborgAuthContext;
  let workspaceId: string;

  async function dispatch(msg: Record<string, unknown>): Promise<Emitted[]> {
    const out: Emitted[] = [];
    await dispatcher.dispatch(msg as never, owner, (m) => out.push(m as Emitted));
    return out;
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-fetch-cybo-"));
    sqlite = new CyborgStorage(path.join(tmpDir, "test.db"));
    storage = new DualStorage(sqlite);
    auth = new CyborgAuth(storage);
    const workspaceManager = new WorkspaceManager(storage);
    const broadcast: BroadcastFn = { toWorkspace() {}, toUser() {} };
    const messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
    dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);
    dispatcher.setServerId("daemon-T");

    owner = auth.validateToken(auth.createToken("owner@test.com", "Owner"))!;
    const ws = await dispatch({
      type: "cyborg:create_workspace",
      name: "Fetch WS",
      requestId: "w1",
    });
    workspaceId = (ws[0].payload.workspace as { id: string }).id;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the cybo (with soul) when fetched by its exact id", async () => {
    const cybo = sqlite.createCybo({
      workspaceId,
      slug: "apex",
      name: "Apex",
      soul: "You are Apex, decisive and concise.",
      provider: "claude",
      createdBy: owner.user.id,
    });

    const out = await dispatch({
      type: "cyborg:fetch_cybo",
      requestId: "f1",
      workspaceId,
      cyboId: cybo.id,
    });
    const resp = out.find((m) => m.type === "cyborg:fetch_cybo_response");
    expect(resp).toBeDefined();
    const got = resp!.payload.cybo as Record<string, unknown> | null;
    expect(got).not.toBeNull();
    expect(got!.id).toBe(cybo.id);
    expect(got!.soul).toBe("You are Apex, decisive and concise.");
  });

  it("resolves by slug when the client holds a non-matching id (the bug)", async () => {
    const cybo = sqlite.createCybo({
      workspaceId,
      slug: "apex",
      name: "Apex",
      soul: "You are Apex.",
      provider: "claude",
      createdBy: owner.user.id,
    });

    // The client navigated with a `local:<slug>` id (pre-merge roster), but the
    // workspace cybo lives under a `cybo_…` id. A strict lookup returned null.
    const out = await dispatch({
      type: "cyborg:fetch_cybo",
      requestId: "f2",
      workspaceId,
      cyboId: "local:apex",
    });
    const got = out.find((m) => m.type === "cyborg:fetch_cybo_response")!.payload.cybo as Record<
      string,
      unknown
    > | null;
    expect(got).not.toBeNull();
    expect(got!.id).toBe(cybo.id);
    expect(got!.slug).toBe("apex");
    expect(got!.soul).toBe("You are Apex.");
    // A workspace-DB cybo is not disk-local.
    expect(got!.isLocal).toBe(false);
  });

  it("resolves by a bare slug too", async () => {
    const cybo = sqlite.createCybo({
      workspaceId,
      slug: "nova",
      name: "Nova",
      soul: "You are Nova.",
      provider: "claude",
      createdBy: owner.user.id,
    });

    const out = await dispatch({
      type: "cyborg:fetch_cybo",
      requestId: "f3",
      workspaceId,
      cyboId: "nova",
    });
    const got = out.find((m) => m.type === "cyborg:fetch_cybo_response")!.payload.cybo as Record<
      string,
      unknown
    > | null;
    expect(got).not.toBeNull();
    expect(got!.id).toBe(cybo.id);
  });

  it("returns null when no cybo matches by id or slug", async () => {
    const out = await dispatch({
      type: "cyborg:fetch_cybo",
      requestId: "f4",
      workspaceId,
      cyboId: "does-not-exist",
    });
    const got = out.find((m) => m.type === "cyborg:fetch_cybo_response")!.payload.cybo;
    expect(got).toBeNull();
  });
});
