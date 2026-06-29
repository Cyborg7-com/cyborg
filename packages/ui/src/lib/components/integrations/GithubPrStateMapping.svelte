<script lang="ts">
  // "Pull Request State Mapping" section (Image #3) — maps each of the six GitHub
  // pull-request states (Draft Open / Open / Ready for Merge / Review Requested /
  // Merged / Closed) onto a task state of a chosen Tasks (Plane) project, with the
  // "Prevent issues from moving to an earlier state due to PR updates" skip-backward
  // flag. Mappings + states are per-project, so a project picker scopes the editor;
  // selecting a state upserts one mapping row (one per (project, prState)).
  //
  // Token-only styling; reuses StateDropdown for the per-state picker. Verbatim
  // Plane integration copy (en/integration.json).
  import { client } from "$lib/state/app.svelte.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import StateDropdown from "$lib/components/tasks/StateDropdown.svelte";
  import { GITHUB_PR_STATES } from "./github-states.js";
  import type { GithubPrStateMapping, Project } from "$lib/ws-client.js";
  import type { TaskState } from "$lib/core/types.js";

  let {
    workspaceId,
    projects,
  }: {
    workspaceId: string;
    projects: Project[];
  } = $props();

  let projectId = $state("");
  let projectStates = $state<TaskState[]>([]);
  let mappings = $state<GithubPrStateMapping[]>([]);
  let skipBackward = $state(false);
  let loading = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  const selectedProjectName = $derived(projects.find((p) => p.id === projectId)?.name ?? "");

  function mappingFor(prState: string): GithubPrStateMapping | undefined {
    return mappings.find((m) => m.prState === prState);
  }

  function mappedStateId(prState: string): string | null {
    return mappingFor(prState)?.taskStateId ?? null;
  }

  async function loadProject(): Promise<void> {
    const proj = projectId;
    if (!proj) {
      projectStates = [];
      mappings = [];
      skipBackward = false;
      return;
    }
    loading = true;
    error = null;
    try {
      const [states, maps] = await Promise.all([
        client.fetchProjectStates(proj),
        client.fetchGithubPrMappings(proj),
      ]);
      projectStates = states;
      mappings = maps;
      // The skip-backward flag is stored per row; reflect it as a single section
      // toggle (true when any existing mapping carries it).
      skipBackward = maps.some((m) => m.skipBackward);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load PR state mappings";
      projectStates = [];
      mappings = [];
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void projectId;
    void loadProject();
  });

  async function setState(prState: string, taskStateId: string): Promise<void> {
    if (!projectId) return;
    busy = true;
    error = null;
    try {
      await client.upsertGithubPrMapping({
        tasksProjectId: projectId,
        prState,
        taskStateId,
        skipBackward,
      });
      await loadProject();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to save the mapping";
    } finally {
      busy = false;
    }
  }

  // Clear (delete) one PR-state → task-state mapping, returning the row to its
  // unmapped "Set State" placeholder. The server DELETE removes the row by id; we
  // reload so the section flag + the row reflect the removal.
  async function clearState(prState: string): Promise<void> {
    const m = mappingFor(prState);
    if (!m || !projectId) return;
    busy = true;
    error = null;
    try {
      await client.deleteGithubPrMapping(m.id);
      await loadProject();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to clear the mapping";
    } finally {
      busy = false;
    }
  }

  // Toggling the section flag re-upserts every EXISTING mapping (the rows that have
  // a state) with the new skip-backward value so the per-row storage stays in sync.
  async function toggleSkip(next: boolean): Promise<void> {
    skipBackward = next;
    if (!projectId) return;
    const existing = mappings.filter((m) => m.taskStateId);
    if (existing.length === 0) return;
    busy = true;
    error = null;
    try {
      // Re-upsert every existing mapping concurrently (up to 6 rows) instead of
      // sequentially — independent network calls, so Promise.all cuts the round-trips
      // to one wave. A reject still propagates to the catch below (same error handling).
      await Promise.all(
        existing.map((m) =>
          client.upsertGithubPrMapping({
            tasksProjectId: projectId,
            prState: m.prState,
            taskStateId: m.taskStateId,
            skipBackward: next,
          }),
        ),
      );
      await loadProject();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to update the mapping";
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex flex-col gap-3">
  <!-- Project scope picker -->
  <div class="flex flex-col gap-1.5">
    <span class="text-[12px] text-content-dim" id="gh-pr-project-label">Project</span>
    <Select.Root type="single" value={projectId} onValueChange={(v) => (projectId = v)}>
      <Select.Trigger aria-labelledby="gh-pr-project-label" class="sm:max-w-xs">
        {#if selectedProjectName}
          {selectedProjectName}
        {:else}
          <span class="text-content-muted">Choose Project...</span>
        {/if}
      </Select.Trigger>
      <Select.Content>
        {#each projects as p (p.id)}
          <Select.Item value={p.id} label={p.name}>{p.name}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>

  {#if error}
    <p class="rounded-md border border-edge bg-surface-alt px-3 py-2 text-[12px] text-error" role="alert">
      {error}
    </p>
  {/if}

  {#if !projectId}
    <p
      class="rounded-md border border-dashed border-edge px-3 py-6 text-center text-[13px] text-content-muted"
    >
      Mapped PR states will appear here
    </p>
  {:else if loading}
    <p class="text-[13px] text-content-muted">Loading…</p>
  {:else}
    <ul class="divide-y divide-edge overflow-hidden rounded-md border border-edge">
      {#each GITHUB_PR_STATES as pr (pr.value)}
        <li class="flex items-center justify-between gap-3 bg-surface-alt px-3 py-2.5">
          <span class="flex min-w-0 items-center gap-2 text-[13px] text-content">
            <span class="truncate">{pr.label}</span>
            {#if pr.notYetActive}
              <!-- Honest affordance: this state is selectable + persisted for forward-
                   compat, but no GitHub pull_request webhook emits it yet (it needs an
                   approving pull_request_review), so a mapping for it is currently inert. -->
              <span
                class="shrink-0 rounded-full border border-edge bg-surface px-1.5 py-0.5 text-[10px] text-content-muted"
                title="No GitHub pull_request event emits this state yet; a mapping is saved for forward-compatibility but is currently inert."
              >
                not yet active
              </span>
            {/if}
          </span>
          <div class="flex shrink-0 items-center gap-1.5">
            <StateDropdown
              value={mappedStateId(pr.value)}
              options={projectStates}
              variant="row"
              placeholder="Set State"
              disabled={busy || projectStates.length === 0}
              onChange={(next) => setState(pr.value, next)}
            />
            {#if mappingFor(pr.value)?.taskStateId}
              <button
                type="button"
                class="grid size-7 place-items-center rounded-[4px] text-content-dim transition-colors hover:bg-hover-gray hover:text-error"
                onclick={() => clearState(pr.value)}
                disabled={busy}
                aria-label={`Clear mapping for ${pr.label}`}
                title="Clear mapping"
              >
                <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>

    <label class="flex cursor-pointer items-center gap-2 text-[13px] text-content-dim select-none">
      <input
        type="checkbox"
        checked={skipBackward}
        disabled={busy}
        onchange={(e) => toggleSkip((e.currentTarget as HTMLInputElement).checked)}
        class="size-3.5 accent-[color:var(--c7-accent)]"
      />
      Prevent issues from moving to an earlier state due to PR updates
    </label>
  {/if}
</div>
