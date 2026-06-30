// ─── Built-in integrations (recipes) ─────────────────────────────────────────
// Client state for the per-workspace list of installed recipes (the integrations
// "Built-in" section). A recipe = a built-in automation backed by a provisioned
// cybo + schedules; the provisioning lives on the daemon. This state only lists +
// mutates, and stays live via the `cyborg:recipes_changed` broadcast (wired in
// app.svelte.ts, the single place client.on(...) handlers live).
//
// Mirrors schedules.svelte.ts. The list holds enabled + disabled rows; the UI
// keys "installed" off `enabled` (the active install per recipe).

import { client } from "./client.js";
import type { RecipeView } from "../ws-client.js";

export class RecipesState {
  // The loaded installs for `workspaceId`. Reassigned on every mutation so the
  // runes observe the change.
  list: RecipeView[] = $state([]);
  loading = $state(false);
  // Human-readable load error (null = none).
  error: string | null = $state(null);

  // Which workspace `list` belongs to — guards a late response from landing in a
  // workspace the user has since switched away from.
  private loadedWorkspaceId: string | null = null;

  // The ENABLED install for a recipe (the active one), or null if not installed.
  // The active-install unique index means at most one enabled row per recipeId.
  installed(recipeId: string): RecipeView | null {
    return this.list.find((r) => r.recipeId === recipeId && r.enabled) ?? null;
  }

  isInstalled(recipeId: string): boolean {
    return this.installed(recipeId) !== null;
  }

  // Load (or reload) the workspace's installs. Safe to call repeatedly.
  async load(workspaceId: string): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const { recipes } = await client.listRecipes(workspaceId);
      this.loadedWorkspaceId = workspaceId;
      this.list = recipes;
    } catch (e) {
      this.error = e instanceof Error ? e.message : "Couldn't load built-in integrations";
      this.list = [];
    } finally {
      this.loading = false;
    }
  }

  // Insert/replace a row from an enable ack. Scoped to the loaded workspace.
  private upsert(recipe: RecipeView): void {
    if (this.loadedWorkspaceId !== null && recipe.workspaceId !== this.loadedWorkspaceId) return;
    // Drop any prior row for the same recipeId (the active-install index keeps one
    // enabled row per recipe) and append the fresh one.
    const next = this.list.filter((r) => r.recipeId !== recipe.recipeId);
    next.push(recipe);
    this.list = next;
  }

  // Mark a recipe disabled locally (from a disable ack), without a full reload.
  private markDisabled(recipeId: string): void {
    this.list = this.list.map((r) =>
      r.recipeId === recipeId && r.enabled
        ? { ...r, enabled: false, cyboId: null, scheduleIds: [] }
        : r,
    );
  }

  // ── Mutations ──────────────────────────────────────────────────────────
  // Each resolves with the server's ack; on success it patches `list` locally so
  // the UI updates without waiting for the broadcast round-trip.

  async enable(
    workspaceId: string,
    recipeId: string,
    config: Record<string, unknown>,
  ): Promise<RecipeView> {
    const { recipe } = await client.enableRecipe(workspaceId, recipeId, config);
    this.upsert(recipe);
    return recipe;
  }

  async disable(workspaceId: string, recipeId: string): Promise<void> {
    await client.disableRecipe(workspaceId, recipeId);
    this.markDisabled(recipeId);
  }

  // Drop all state on logout / workspace teardown.
  clear(): void {
    this.list = [];
    this.loading = false;
    this.error = null;
    this.loadedWorkspaceId = null;
  }
}

export const recipesState = new RecipesState();
