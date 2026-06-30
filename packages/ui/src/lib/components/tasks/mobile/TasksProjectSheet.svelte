<script lang="ts">
  // Project switcher sheet (WS0 foundation, frozen). Tier-1 of the IA: opened from
  // the tappable project name in MobileTasksHeader. Lists the workspace's visible
  // projects (same warm cache + fetch as the desktop TasksTopNav); selecting one
  // navigates to its default Work Items view. Theme tokens only; project color is
  // data-driven (no token exists for an arbitrary project color).
  import MobileSheet from "$lib/components/MobileSheet.svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { projectsCache, fetchProjects } from "$lib/state/app.svelte.js";
  import CheckIcon from "@lucide/svelte/icons/check";
  import { cn } from "$lib/utils.js";

  let {
    open = $bindable(false),
    onclose,
  }: {
    open?: boolean;
    onclose?: () => void;
  } = $props();

  const wsId = $derived(page.params.id ?? "");
  const currentProjectId = $derived(page.params.projectId ?? "");
  const projects = $derived(wsId ? (projectsCache.get(wsId)?.projects ?? []) : []);

  // Best-effort hydrate when the cache is cold and the sheet opens.
  $effect(() => {
    if (!open || !wsId) return;
    if ((projectsCache.get(wsId)?.projects ?? []).length === 0) {
      void fetchProjects().catch(() => {}); // intentional: best-effort hydrate; the cache fills on a later open
    }
  });

  function selectProject(id: string): void {
    open = false;
    onclose?.();
    if (!wsId || id === currentProjectId) return;
    void goto(`/workspace/${wsId}/tasks/${id}/work-items`);
  }
</script>

<MobileSheet bind:open title="Projects" {onclose} ariaLabel="Switch project">
  <div class="flex flex-col gap-0.5 pb-2">
    {#each projects as project (project.id)}
      {@const active = project.id === currentProjectId}
      <button
        type="button"
        onclick={() => selectProject(project.id)}
        class={cn(
          "flex items-center gap-2.5 rounded-[var(--radius-md)] px-3 py-2.5 text-left transition-colors hover:bg-hover-gray focus-ring",
          active && "bg-hover-gray",
        )}
        aria-current={active ? "true" : undefined}
      >
        <span
          class="size-2.5 shrink-0 rounded-full"
          style={`background-color:${project.color}`}
        ></span>
        <span class="min-w-0 flex-1 truncate text-sm text-content">{project.name}</span>
        {#if active}
          <CheckIcon class="size-4 shrink-0 text-accent" />
        {/if}
      </button>
    {/each}
    {#if projects.length === 0}
      <p class="px-3 py-6 text-center text-sm text-content-muted">No projects yet</p>
    {/if}
  </div>
</MobileSheet>
