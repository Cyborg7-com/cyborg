// ─── Prompt templates (#602 — reusable composer snippets) ───────────
// Client state for the per-workspace list of reusable composer prompt templates
// (the slash menu's secondary "Templates" group). Loaded on demand via
// cyborg:list_prompt_templates and kept in sync with create/update/delete
// actions so the composer's autocomplete reflects edits without a full reload.
//
// Rows are sorted A→Z by name (case-insensitive), matching the server's list
// order, so the composer's secondary group is stable + browseable.

import { client } from "./client.js";
import type { PromptTemplate } from "../core/types.js";

function byName(a: PromptTemplate, b: PromptTemplate): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

export class PromptTemplatesState {
  // The loaded templates for `loadedWorkspaceId`, A→Z by name. Reassigned on
  // every mutation so the runes observe the change.
  templates: PromptTemplate[] = $state([]);
  loading = $state(false);
  // Human-readable load error (null = none) — "the LIST couldn't load".
  error: string | null = $state(null);
  // Which workspace `templates` belong to — guards a late list response from
  // landing in a workspace the user has since switched away from, and lets the
  // composer cheaply skip a reload when it already holds the right workspace.
  private loadedWorkspaceId: string | null = null;
  // The workspace whose load() is CURRENTLY in flight (null = none). Guards
  // against the duplicate concurrent fetches that load()'s call-on-every-"/"
  // keystroke would otherwise fire before the first response lands.
  private loadingWorkspaceId: string | null = null;

  // True when the current rows already belong to `workspaceId` (so the composer
  // can avoid a redundant fetch on every focus).
  isLoadedFor(workspaceId: string): boolean {
    return this.loadedWorkspaceId === workspaceId;
  }

  // Load (or reload) a workspace's templates. Safe to call repeatedly. When
  // `force` is false and the rows already belong to this workspace, it's a no-op
  // (the composer opens often; we don't refetch on every "/" keystroke).
  async load(workspaceId: string, opts?: { force?: boolean }): Promise<void> {
    if (!opts?.force && this.loadedWorkspaceId === workspaceId) return;
    // Already fetching this workspace → don't fire a duplicate concurrent request.
    if (this.loadingWorkspaceId === workspaceId) return;
    this.loadingWorkspaceId = workspaceId;
    this.loading = true;
    this.error = null;
    try {
      const { templates } = await client.listPromptTemplates(workspaceId);
      this.loadedWorkspaceId = workspaceId;
      this.templates = [...templates].sort(byName);
    } catch (e) {
      this.error = e instanceof Error ? e.message : "Couldn't load prompt templates";
      this.templates = [];
    } finally {
      // Only clear the in-flight state if it's still OURS — a later load() for a
      // different workspace may have overwritten loadingWorkspaceId by now.
      if (this.loadingWorkspaceId === workspaceId) {
        this.loading = false;
        this.loadingWorkspaceId = null;
      }
    }
  }

  // Insert/replace a row from a create/update response without a full reload.
  // Idempotent if a later load() also lands. Scoped to the loaded workspace.
  upsert(template: PromptTemplate): void {
    // Scope to the loaded workspace. A null loadedWorkspaceId (never loaded) also
    // mismatches here, so an upsert can't pollute uninitialized state.
    if (template.workspaceId !== this.loadedWorkspaceId) return;
    const next = this.templates.filter((t) => t.id !== template.id);
    next.push(template);
    this.templates = next.sort(byName);
  }

  // Drop a row by id (after a successful delete).
  remove(id: string): void {
    this.templates = this.templates.filter((t) => t.id !== id);
  }

  // Drop all state on logout / workspace teardown.
  clear(): void {
    this.templates = [];
    this.loading = false;
    this.error = null;
    this.loadedWorkspaceId = null;
    this.loadingWorkspaceId = null;
  }
}

export const promptTemplatesState = new PromptTemplatesState();
