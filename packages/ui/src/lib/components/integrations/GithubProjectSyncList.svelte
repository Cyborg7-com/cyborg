<script lang="ts">
  // "Project Issue Sync" list (Image #5) — every repo↔project binding across the
  // workspace, each row showing the GitHub repo, the Plane (Tasks) project it syncs
  // into, and its direction, with pencil (edit) + trash (delete) actions. Edit hands
  // the binding back to the parent (which reopens the Link modal in edit mode);
  // delete confirms then calls unbindGithubRepoSync and reloads. Empty state uses
  // the verbatim Plane copy.
  //
  // Token-only styling; the parent owns the Link modal + the projects list. A
  // `refreshSignal` bump from the parent re-fetches after an external add/edit.
  import { client } from "$lib/state/app.svelte.js";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import { projectNameForTasksId } from "./github-states.js";
  import type { GithubRepoSync, Project } from "$lib/ws-client.js";

  let {
    workspaceId,
    projects,
    refreshSignal = 0,
    onEdit,
  }: {
    workspaceId: string;
    projects: Project[];
    // Bumped by the parent after an external add/edit to trigger a re-fetch.
    refreshSignal?: number;
    onEdit: (sync: GithubRepoSync) => void;
  } = $props();

  let syncs = $state<GithubRepoSync[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let busy = $state(false);

  // Delete confirmation target (null = dialog closed).
  let pendingDelete = $state<GithubRepoSync | null>(null);

  function projectName(id: string): string {
    // `id` is the repo sync's `tasksProjectId` (a `tp_<chatProjectId>` tasks_projects.id),
    // but `projects` is keyed by the bare CHAT project id. The shared helper strips the
    // prefix to match — else every row reads "Unknown project" (incl. the destructive
    // delete-confirm copy).
    return projectNameForTasksId(projects, id, "Unknown project");
  }

  function directionLabel(d: string): string {
    return d === "bidirectional" ? "Bidirectional" : "Unidirectional";
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      syncs = await client.fetchGithubRepoSyncsForWorkspace(workspaceId);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load synced repositories";
    } finally {
      loading = false;
    }
  }

  // Re-fetch on workspace change and whenever the parent bumps refreshSignal.
  $effect(() => {
    // Touch both so the effect re-runs when either changes.
    void workspaceId;
    void refreshSignal;
    void load();
  });

  async function confirmDelete(): Promise<void> {
    const target = pendingDelete;
    if (!target) return;
    busy = true;
    error = null;
    try {
      await client.unbindGithubRepoSync(target.id);
      pendingDelete = null;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to remove the repository link";
    } finally {
      busy = false;
    }
  }
</script>

{#if error}
  <p class="rounded-md border border-edge bg-surface-alt px-3 py-2 text-[12px] text-error" role="alert">
    {error}
  </p>
{/if}

{#if loading}
  <p class="text-[13px] text-content-muted">Loading…</p>
{:else if syncs.length === 0}
  <p
    class="rounded-md border border-dashed border-edge px-3 py-6 text-center text-[13px] text-content-muted"
  >
    Mapped project issue sync will appear here
  </p>
{:else}
  <ul class="divide-y divide-edge overflow-hidden rounded-md border border-edge">
    {#each syncs as s (s.id)}
      <li class="flex items-center justify-between gap-3 bg-surface-alt px-3 py-2.5">
        <div class="flex min-w-0 items-center gap-2 text-[13px]">
          <a
            href={s.repoUrl}
            target="_blank"
            rel="noopener"
            class="truncate font-medium text-content hover:text-accent hover:underline"
          >
            {s.owner}/{s.name}
          </a>
          <svg
            class="h-3.5 w-3.5 shrink-0 text-content-muted"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
          <span class="truncate text-content-dim">{projectName(s.tasksProjectId)}</span>
        </div>

        <div class="flex shrink-0 items-center gap-2">
          <span
            class="rounded-full border border-edge bg-surface px-2 py-0.5 text-[11px] text-content-muted"
          >
            {directionLabel(s.syncDirection)}
          </span>
          <button
            type="button"
            class="grid size-7 place-items-center rounded-[4px] text-content-dim transition-colors hover:bg-hover-gray hover:text-content"
            onclick={() => onEdit(s)}
            aria-label={`Edit sync for ${s.owner}/${s.name}`}
            title="Edit"
          >
            <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
          <button
            type="button"
            class="grid size-7 place-items-center rounded-[4px] text-content-dim transition-colors hover:bg-hover-gray hover:text-error"
            onclick={() => (pendingDelete = s)}
            disabled={busy}
            aria-label={`Remove sync for ${s.owner}/${s.name}`}
            title="Remove"
          >
            <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </li>
    {/each}
  </ul>
{/if}

<ConfirmDialog
  open={pendingDelete !== null}
  title="Remove repository link"
  message={pendingDelete
    ? `Stop syncing ${pendingDelete.owner}/${pendingDelete.name} with ${projectName(pendingDelete.tasksProjectId)}?`
    : ""}
  confirmLabel="Remove"
  cancelLabel="Cancel"
  destructive
  onconfirm={confirmDelete}
  oncancel={() => (pendingDelete = null)}
/>
