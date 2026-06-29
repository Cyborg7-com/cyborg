<!--
  TasksSidebar — the Tasks-tab left sidebar, echoing ChannelSidebar's section
  scaffold. It lists every VISIBLE project (server-enforced visibility — we only
  ever render client.fetchProjects results) under a single collapsible
  "Projects" section, each row a color dot + name (Plane's project list). The
  ACTIVE project (the one in the current route) reveals its stacked ProjectSubNav
  (Overview / Work Items / Cycles / …) inline beneath the row, matching Plane's
  projects → work-items navigation. Selecting a project routes to its default
  Work Items view.

  Visuals come entirely from theme tokens + lib/tasks/ui.ts — zero raw hex, so
  dark + light both resolve. The project warm cache + fetch mirrors
  ChannelSidebar exactly so the list paints on the first frame after a tab
  switch and self-heals on every mount.
-->
<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { untrack } from "svelte";
  import { fetchProjects, projectsCache, workspaceState } from "$lib/state/app.svelte.js";
  import SidebarSection from "$lib/components/SidebarSection.svelte";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import ProjectSubNav from "$lib/components/tasks/ProjectSubNav.svelte";
  import { inboxProjectId, INBOX_PROJECT_NAME } from "$lib/tasks/constants.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import { cn } from "$lib/utils.js";

  // The project list shape (id + name + color), mirroring ChannelSidebar's local
  // Project interface and the warm-cache entry. `createdAt` is optional so a
  // cache-seeded row (which may predate the field) types cleanly.
  interface Project {
    id: string;
    name: string;
    color: string;
    createdAt?: number;
  }

  const wsId = $derived(page.params.id ?? "");
  // The active project is whatever the current route is scoped to
  // (/workspace/<ws>/tasks/<projectId>/…). Null on the bare /tasks redirect frame.
  const activeProjectId = $derived(page.params.projectId ?? null);

  // ── Warm projects cache ──────────────────────────────────────────────────
  // Seed synchronously from the module-level warm cache so projects paint on the
  // FIRST frame (the same cache ChannelSidebar fills), then background-refetch on
  // every mount. Keyed by wsId so a workspace switch can never bleed across.
  function seedFromCache(id: string | undefined): Project[] {
    if (!id) return [];
    return projectsCache.get(id)?.projects ?? [];
  }

  const _initWsId = page.params.id as string | undefined;
  // Snapshot the seed once so `loading`'s initializer reads the const (not the
  // $state) — avoids Svelte's state_referenced_locally warning, mirroring
  // ChannelSidebar's _seed pattern.
  const _seed = seedFromCache(_initWsId);
  let projects = $state<Project[]>(_seed);
  // Plain let (not $state): writing it must not re-trigger the fetch effect.
  let fetchedForWsId: string | undefined;
  let loading = $state(_seed.length === 0);

  $effect(() => {
    if (!wsId) return;
    if (wsId !== fetchedForWsId) {
      const fresh = untrack(() => seedFromCache(wsId));
      projects = fresh;
      loading = fresh.length === 0;
      fetchedForWsId = wsId;
    }
    const currentWsId = wsId;
    fetchProjects()
      .then(({ projects: ps }) => {
        // Discard if the workspace changed mid-flight.
        if (fetchedForWsId !== currentWsId) return;
        projects = ps;
        loading = false;
        return undefined;
      })
      // intentional: background hydration; on failure the cached list renders and
      // self-heals on remount — never surface a sidebar error for this.
      .catch(() => {
        loading = false;
      });
  });

  // The per-workspace synthetic Inbox holds orphan tasks (created with no chat
  // project → task.projectId null). It never appears in fetchProjects (it isn't a
  // chat project), so surface it as a project row WHENEVER it actually holds such
  // tasks — making those otherwise-invisible tasks reachable. The row reuses the
  // exact project-row + ProjectSubNav rendering below; its deterministic id routes
  // the work-items board to the Inbox. Tasks are already loaded workspace-wide
  // (selectWorkspace), so this needs no server call and reacts as tasks land.
  const hasInboxTasks = $derived((workspaceState.tasks ?? []).some((t) => !t.projectId));
  // The rendered list: the Inbox row (when populated) above the chat-linked
  // projects. `--state-unstarted` is the neutral state token (no raw hex), keeping
  // the leading color tile token-driven like every other row.
  const rows = $derived<Project[]>(
    hasInboxTasks && wsId
      ? [{ id: inboxProjectId(wsId), name: INBOX_PROJECT_NAME, color: "var(--state-unstarted)" }, ...projects]
      : projects,
  );

  let projectsOpen = $state(true);

  function openProject(projectId: string): void {
    if (!wsId) return;
    viewportState.closeDrawer();
    // Selecting a project lands on its default Work Items view (Plane default).
    goto(`/workspace/${wsId}/tasks/${projectId}/work-items`);
  }
</script>

<!-- No per-tab title bar: Plane's projects area is just the "Projects" disclosure
     (SidebarSection), with no big "Tasks" H1 above it. -->
<div class="flex h-full flex-col overflow-hidden bg-surface-alt">
  <ScrollArea class="min-h-0 flex-1">
    <div class="py-2">
      <SidebarSection label="Projects" bind:open={projectsOpen}>
        {#if loading && rows.length === 0}
          <!-- Shimmer rows while the first project fetch is in flight. -->
          {#each Array.from({ length: 3 }) as _, i (i)}
            <div class="flex items-center gap-1.5 px-2 py-1.5">
              <span class="size-4 shrink-0 animate-pulse rounded-[4px] bg-deeper"></span>
              <span class="h-3 flex-1 animate-pulse rounded bg-deeper"></span>
            </div>
          {/each}
        {:else if rows.length === 0}
          <p class="px-3 py-1.5 text-[12px] text-content-muted">No projects yet</p>
        {:else}
          {#each rows as project (project.id)}
            {@const isActive = project.id === activeProjectId}
            <!-- Plane projects-list-item.tsx:292-351 — the project row: rounded-md
                 px-2 py-1.5, hover:bg-layer-transparent-hover, active row tinted
                 (bg-layer-transparent-active). Leading is a size-4 logo tile
                 (Logo, 16px); we map Plane's emoji/logo to a small rounded glyph
                 tile filled with the project color showing its initial. Name =
                 text-13 font-medium text-secondary (text-primary when active). -->
            <button
              type="button"
              onclick={() => openProject(project.id)}
              class={cn(
                "group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover-gray",
                isActive && "bg-dropdown-selected",
              )}
              aria-current={isActive ? "true" : undefined}
            >
              <span class="grid size-4 shrink-0 place-items-center">
                <span
                  class="grid size-4 place-items-center rounded-[4px] text-[10px] font-semibold uppercase leading-none text-[color:var(--brand-contrast)]"
                  style={`background-color:${project.color}`}
                >
                  {project.name.trim().charAt(0) || "?"}
                </span>
              </span>
              <span
                class={cn(
                  "min-w-0 flex-1 truncate text-[13px] font-medium text-content-dim",
                  isActive && "text-content",
                )}>{project.name}</span
              >
            </button>
            {#if isActive}
              <!-- Plane reveals the project's stacked sub-nav beneath the active
                   row; the work-items / cycles / … views live one level deeper. -->
              <ProjectSubNav {wsId} projectId={project.id} />
            {/if}
          {/each}
        {/if}
      </SidebarSection>
    </div>
  </ScrollArea>
</div>
