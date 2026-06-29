<!--
  TasksTopNav — the Tasks-area top navigation bar that replaces the old left
  "Projects" sidebar (TasksSidebar). Two parts on one row:
    • a PROJECT SWITCHER dropdown (color glyph + active project name + chevron)
      listing every visible project so you can switch from here, and
    • the horizontal SECTION TABS (Overview / Work items / Cycles / Modules /
      Views / Pages) that route to /workspace/<ws>/tasks/<projectId>/<view>.

  Layout-level: mounted by tasks/+layout.svelte so it shows on every project
  section route. Hidden on the bare /tasks redirect frame (no active project).

  Project list reuses the same warm cache + fetch as the former TasksSidebar so
  the switcher paints on the first frame and self-heals on every mount. Visuals
  are theme tokens only (zero raw hex; project color comes from data) so dark +
  light both resolve.
-->
<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { untrack } from "svelte";
  import { fetchProjects, projectsCache } from "$lib/state/app.svelte.js";
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
  } from "$lib/components/ui/dropdown-menu/index.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import { cn } from "$lib/utils.js";

  // Project row shape (id + name + color), mirroring the warm-cache entry.
  interface Project {
    id: string;
    name: string;
    color: string;
    createdAt?: number;
  }

  const wsId = $derived(page.params.id ?? "");
  // Active project from the route (/workspace/<ws>/tasks/<projectId>/…). Null on
  // the bare /tasks redirect frame.
  const activeProjectId = $derived(page.params.projectId ?? null);

  // ── Warm projects cache (same source as the former TasksSidebar) ───────────
  function seedFromCache(id: string | undefined): Project[] {
    if (!id) return [];
    return projectsCache.get(id)?.projects ?? [];
  }

  const _initWsId = page.params.id as string | undefined;
  const _seed = seedFromCache(_initWsId);
  let projects = $state<Project[]>(_seed);
  // Plain let (not $state): writing it must not re-trigger the fetch effect.
  let fetchedForWsId: string | undefined;

  $effect(() => {
    if (!wsId) return;
    if (wsId !== fetchedForWsId) {
      projects = untrack(() => seedFromCache(wsId));
      fetchedForWsId = wsId;
    }
    const currentWsId = wsId;
    fetchProjects()
      .then(({ projects: ps }) => {
        if (fetchedForWsId !== currentWsId) return;
        projects = ps;
        return undefined;
      })
      // intentional: background hydration; cached list renders + self-heals on remount.
      .catch(() => {});
  });

  const activeProject = $derived(projects.find((p) => p.id === activeProjectId) ?? null);

  // Active section = the route's last path segment under the project (static route
  // segments, not a param). Work Items is the default.
  const activeView = $derived.by(() => {
    if (!activeProjectId) return "work-items";
    const segs = page.url.pathname.split("/").filter(Boolean);
    const i = segs.indexOf(activeProjectId);
    return i >= 0 ? (segs[i + 1] ?? "work-items") : "work-items";
  });

  type ViewKey = "overview" | "work-items" | "cycles" | "modules" | "views" | "pages";
  interface ViewRow {
    key: ViewKey;
    label: string;
  }
  // Sections shown in the nav. Overview / Cycles / Modules / Views are hidden for
  // now (their routes still exist); restore by re-adding their rows here.
  const VIEWS: ViewRow[] = [
    { key: "work-items", label: "Work items" },
    { key: "pages", label: "Pages" },
  ];

  function openProject(projectId: string): void {
    if (!wsId) return;
    viewportState.closeDrawer();
    // Switching lands on the project's default Work Items view (Plane default).
    goto(`/workspace/${wsId}/tasks/${projectId}/work-items`);
  }

  function openView(view: ViewKey): void {
    if (!wsId || !activeProjectId) return;
    goto(`/workspace/${wsId}/tasks/${activeProjectId}/${view}`);
  }
</script>

{#if activeProjectId}
  <div
    class="flex h-12 shrink-0 items-center gap-2 overflow-x-auto border-b border-edge bg-surface px-4"
  >
    <!-- Project switcher dropdown -->
    <DropdownMenu>
      <DropdownMenuTrigger
        class="flex shrink-0 items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-hover-gray cursor-pointer focus-ring"
        aria-label="Switch project"
      >
        {#if activeProject}
          <span
            class="grid size-5 shrink-0 place-items-center rounded-[5px] text-[11px] font-semibold uppercase leading-none text-[color:var(--brand-contrast)]"
            style={`background-color:${activeProject.color}`}
          >
            {activeProject.name.trim().charAt(0) || "?"}
          </span>
          <span class="max-w-[180px] truncate text-[14px] font-semibold text-content"
            >{activeProject.name}</span
          >
        {:else}
          <span class="text-[14px] font-semibold text-content">Select project</span>
        {/if}
        <svg
          class="shrink-0 text-content-muted"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-[240px]">
        {#each projects as p (p.id)}
          {@const isActive = p.id === activeProjectId}
          <DropdownMenuItem
            class="gap-2 px-2 py-1.5 text-[13px] cursor-pointer"
            onclick={() => openProject(p.id)}
          >
            <span
              class="grid size-5 shrink-0 place-items-center rounded-[5px] text-[11px] font-semibold uppercase leading-none text-[color:var(--brand-contrast)]"
              style={`background-color:${p.color}`}
            >
              {p.name.trim().charAt(0) || "?"}
            </span>
            <span class="min-w-0 flex-1 truncate">{p.name}</span>
            {#if isActive}
              <svg
                class="shrink-0 text-content-muted"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            {/if}
          </DropdownMenuItem>
        {/each}
      </DropdownMenuContent>
    </DropdownMenu>

    <!-- Divider between the switcher and the section tabs -->
    <span class="mx-1 h-5 w-px shrink-0 bg-edge"></span>

    <!-- Horizontal section tabs — active = accent underline (not a pill) -->
    <nav class="flex h-full items-center gap-1" aria-label="Project sections">
      {#each VIEWS as v (v.key)}
        {@const isActive = v.key === activeView}
        <button
          type="button"
          onclick={() => openView(v.key)}
          class={cn(
            "relative flex h-full shrink-0 items-center px-2.5 text-[13px] font-medium transition-colors",
            isActive
              ? "text-content after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent"
              : "text-content-dim hover:text-content",
          )}
          aria-current={isActive ? "page" : undefined}
        >
          {v.label}
        </button>
      {/each}
    </nav>
  </div>
{/if}
