<script lang="ts">
  // /tasks entry — now a project-routing frame, not a board. Tasks are
  // project-scoped (Plane structure), so this landing route redirects to a
  // default project's Work Items view, or shows a project PICKER when there are
  // several / none. The actual board lives at /tasks/<projectId>/work-items.
  //
  // SCOPE NOTE: the old workspace-level "Scheduled" (recurring-task) board that
  // used to live here is intentionally NOT ported into the project shell — where
  // recurring schedules belong in the project-scoped IA is a product decision
  // left to the parent. SchedulesBoard is untouched and not deleted.
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { untrack } from "svelte";
  import { fetchProjects, projectsCache } from "$lib/state/app.svelte.js";
  import { subNavRow, subNavLabel } from "$lib/tasks/ui.js";
  import { cn } from "$lib/utils.js";

  interface Project {
    id: string;
    name: string;
    color: string;
    createdAt?: number;
  }

  const wsId = $derived(page.params.id ?? "");

  function seed(id: string | undefined): Project[] {
    if (!id) return [];
    return projectsCache.get(id)?.projects ?? [];
  }

  // Snapshot the seed once so `loading`'s initializer reads the const (not the
  // $state), avoiding Svelte's state_referenced_locally warning.
  const _seed = seed(page.params.id as string | undefined);
  let projects = $state<Project[]>(_seed);
  let loading = $state(_seed.length === 0);
  let fetchedForWsId: string | undefined;

  // Load projects, then auto-redirect to the first one's Work Items view (the
  // default landing). When the cache already has exactly the data we need we
  // redirect on the first frame with no flash.
  $effect(() => {
    if (!wsId) return;
    if (wsId !== fetchedForWsId) {
      const fresh = untrack(() => seed(wsId));
      projects = fresh;
      loading = fresh.length === 0;
      fetchedForWsId = wsId;
      // Cache hit: redirect immediately to the default project.
      if (fresh.length > 0) {
        void goto(`/workspace/${wsId}/tasks/${fresh[0].id}/work-items`, { replaceState: true });
        return;
      }
    }
    const currentWsId = wsId;
    fetchProjects()
      .then(({ projects: ps }) => {
        if (fetchedForWsId !== currentWsId) return;
        projects = ps;
        loading = false;
        // Auto-redirect to the default project once loaded.
        if (ps.length > 0) {
          void goto(`/workspace/${currentWsId}/tasks/${ps[0].id}/work-items`, {
            replaceState: true,
          });
        }
        return undefined;
      })
      .catch(() => {
        loading = false;
      });
  });

  function openProject(projectId: string): void {
    if (!wsId) return;
    void goto(`/workspace/${wsId}/tasks/${projectId}/work-items`);
  }
</script>

<div class="flex h-full w-full flex-col overflow-hidden">
  <header class="flex items-center gap-3 border-b border-edge px-4 py-2.5">
    <h2 class="text-sm font-semibold text-content">Tasks</h2>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if loading}
      <p class="px-6 py-4 text-[13px] text-content-muted">Loading projects…</p>
    {:else if projects.length === 0}
      <div class="flex h-full flex-col items-center justify-center px-6 text-center text-content-muted">
        <p class="text-sm">No projects yet</p>
        <p class="mt-1 text-xs">
          Create a project from the channels sidebar to start tracking work items.
        </p>
      </div>
    {:else}
      <!-- Fallback picker (shown only if the redirect hasn't completed). -->
      <div class="mx-auto w-full max-w-md px-4 py-6">
        <h3 class="mb-2 text-[13px] font-medium uppercase tracking-wide text-content-muted">
          Choose a project
        </h3>
        {#each projects as project (project.id)}
          <button
            type="button"
            onclick={() => openProject(project.id)}
            class={cn(subNavRow, "w-full")}
          >
            <span
              class="size-2.5 shrink-0 rounded-full"
              style={`background-color:${project.color}`}
            ></span>
            <span class={subNavLabel}>{project.name}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>
