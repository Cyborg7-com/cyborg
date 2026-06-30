import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "../storage.js";
import { DualStorage } from "../dual-storage.js";
import { CyborgAuth } from "../auth.js";
import { WorkspaceManager } from "../workspace-manager.js";
import { MessageRouter, type BroadcastFn } from "../message-router.js";
import { CyborgDispatcher } from "../dispatcher.js";
import type { CyborgAuthContext } from "../auth.js";

// Built-in integrations (recipes) provisioning, dispatcher layer. Proves the full
// enable → provision → disable → teardown lifecycle on the (SQLite-authoritative)
// daemon: enabling a recipe creates a cybo + its schedules + the install row and
// stamps the provisioned ids; disabling deletes the cybo, removes its schedules
// (SQLite has no cybo→schedule FK cascade — the handler deletes them explicitly),
// and flips the install row disabled while keeping it as history. Channel
// memberships live in PG only (no SQLite table), so they're exercised indirectly
// via the no-op PG stub — the SQLite-backed data path is what we assert here.

interface Emitted {
  type: string;
  payload: Record<string, unknown>;
}

describe("recipe provisioning (dispatcher)", () => {
  let storage: DualStorage;
  let sqlite: CyborgStorage;
  let auth: CyborgAuth;
  let dispatcher: CyborgDispatcher;
  let tmpDir: string;
  let owner: CyborgAuthContext;
  let workspaceId: string;
  const broadcasts: Array<{ workspaceId: string; message: { type: string } }> = [];

  async function dispatch(msg: Record<string, unknown>, who = owner): Promise<Emitted[]> {
    const out: Emitted[] = [];
    await dispatcher.dispatch(msg as never, who, (m) => out.push(m as Emitted));
    return out;
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-recipes-"));
    sqlite = new CyborgStorage(path.join(tmpDir, "test.db"));
    // No PG: a solo daemon. addCyboToChannel/removeCyboFromChannel are PG-only, so
    // they're no-ops here (storage.pg is null) — the recipe still provisions its
    // cybo + schedules + install in SQLite, which is what we assert.
    storage = new DualStorage(sqlite, null);
    auth = new CyborgAuth(storage);
    const workspaceManager = new WorkspaceManager(storage);
    broadcasts.length = 0;
    const broadcast: BroadcastFn = {
      toWorkspace(wsId, message) {
        broadcasts.push({ workspaceId: wsId, message: message as { type: string } });
      },
      toUser() {},
    };
    const messageRouter = new MessageRouter(storage, workspaceManager, broadcast);
    dispatcher = new CyborgDispatcher(messageRouter, workspaceManager, storage);
    dispatcher.setServerId("daemon-R");

    owner = auth.validateToken(auth.createToken("owner@test.com", "Owner"))!;

    const ws = await dispatch({
      type: "cyborg:create_workspace",
      name: "Recipes WS",
      requestId: "w1",
    });
    workspaceId = (ws[0].payload.workspace as { id: string }).id;
  });

  afterEach(() => {
    try {
      sqlite.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("enable_recipe provisions a cybo + schedules + a stamped install row, and broadcasts", async () => {
    const out = await dispatch({
      type: "cyborg:enable_recipe",
      requestId: "e1",
      workspaceId,
      recipeId: "standup",
      config: { standupChannelId: "chan-standup", timezone: "UTC" },
    });

    const resp = out.find((m) => m.type === "cyborg:enable_recipe_response");
    expect(resp).toBeDefined();
    const recipe = resp!.payload.recipe as Record<string, unknown>;
    expect(recipe.recipeId).toBe("standup");
    expect(recipe.enabled).toBe(true);
    expect(recipe.config).toEqual({ standupChannelId: "chan-standup", timezone: "UTC" });
    expect(typeof recipe.cyboId).toBe("string");
    expect((recipe.scheduleIds as string[]).length).toBe(2);

    // A real cybo exists, named Standup, with the right grants.
    const cybo = sqlite.getCybo(recipe.cyboId as string);
    expect(cybo).toBeDefined();
    expect(cybo!.name).toBe("Standup");
    expect(cybo!.provider).toBe("claude");

    // Two schedules exist, bound to the provisioned cybo + the standup channel.
    const schedules = sqlite.listSchedules(workspaceId);
    expect(schedules).toHaveLength(2);
    for (const s of schedules) {
      expect(s.cybo_id).toBe(recipe.cyboId);
      expect(s.channel_id).toBe("chan-standup");
    }

    // The install row is recorded + stamped with the provisioned ids.
    const install = sqlite.getInstalledRecipe(workspaceId, "standup");
    expect(install).toBeDefined();
    expect(install!.enabled).toBe(1);
    expect(install!.cybo_id).toBe(recipe.cyboId);
    expect(JSON.parse(install!.schedule_ids)).toEqual(recipe.scheduleIds);

    // A recipes_changed broadcast fired for the workspace.
    expect(
      broadcasts.some(
        (b) => b.workspaceId === workspaceId && b.message.type === "cyborg:recipes_changed",
      ),
    ).toBe(true);
  });

  it("unknown recipe id → not_found error, no side effects", async () => {
    const out = await dispatch({
      type: "cyborg:enable_recipe",
      requestId: "e2",
      workspaceId,
      recipeId: "does_not_exist",
      config: {},
    });
    const err = out.find((m) => m.type === "cyborg:error");
    expect(err?.payload.code).toBe("not_found");
    expect(sqlite.listRecipesForWorkspace(workspaceId)).toHaveLength(0);
    expect(sqlite.listSchedules(workspaceId)).toHaveLength(0);
  });

  it("disable_recipe deletes the cybo + its schedules and flips the install disabled", async () => {
    const enabled = await dispatch({
      type: "cyborg:enable_recipe",
      requestId: "e3",
      workspaceId,
      recipeId: "retro",
      config: { retroChannelId: "chan-retro" },
    });
    const recipe = enabled.find((m) => m.type === "cyborg:enable_recipe_response")!.payload
      .recipe as Record<string, unknown>;
    const cyboId = recipe.cyboId as string;
    expect(sqlite.getCybo(cyboId)).toBeDefined();
    expect(sqlite.listSchedules(workspaceId)).toHaveLength(2);

    const out = await dispatch({
      type: "cyborg:disable_recipe",
      requestId: "d1",
      workspaceId,
      recipeId: "retro",
    });
    const resp = out.find((m) => m.type === "cyborg:disable_recipe_response");
    expect(resp).toBeDefined();
    expect(resp!.payload.disabled).toBe(true);
    expect(resp!.payload.recipeId).toBe("retro");

    // Cybo gone, schedules gone (teardown), install kept as DISABLED history.
    expect(sqlite.getCybo(cyboId)).toBeUndefined();
    expect(sqlite.listSchedules(workspaceId)).toHaveLength(0);
    expect(sqlite.getInstalledRecipe(workspaceId, "retro")).toBeNull();
    const history = sqlite.listRecipesForWorkspace(workspaceId);
    expect(history).toHaveLength(1);
    expect(history[0].enabled).toBe(0);
    expect(history[0].cybo_id).toBeNull();
  });

  it("list_recipes returns the workspace's installs in the wire view", async () => {
    await dispatch({
      type: "cyborg:enable_recipe",
      requestId: "e4",
      workspaceId,
      recipeId: "standup",
      config: { standupChannelId: "c1" },
    });

    const out = await dispatch({
      type: "cyborg:list_recipes",
      requestId: "l1",
      workspaceId,
    });
    const resp = out.find((m) => m.type === "cyborg:list_recipes_response");
    expect(resp).toBeDefined();
    const recipes = resp!.payload.recipes as Array<Record<string, unknown>>;
    expect(recipes).toHaveLength(1);
    expect(recipes[0].recipeId).toBe("standup");
    expect(recipes[0].enabled).toBe(true);
    expect(recipes[0].config).toEqual({ standupChannelId: "c1" });
  });

  it("re-enabling an active recipe reuses the install row (refreshes config)", async () => {
    await dispatch({
      type: "cyborg:enable_recipe",
      requestId: "e5",
      workspaceId,
      recipeId: "standup",
      config: { standupChannelId: "c1" },
    });
    await dispatch({
      type: "cyborg:enable_recipe",
      requestId: "e6",
      workspaceId,
      recipeId: "standup",
      config: { standupChannelId: "c2" },
    });
    // One ACTIVE install (the partial unique index keeps a single enabled row).
    const active = sqlite.listRecipesForWorkspace(workspaceId).filter((r) => r.enabled === 1);
    expect(active).toHaveLength(1);
    expect(JSON.parse(active[0].config)).toEqual({ standupChannelId: "c2" });
  });
});
