<script lang="ts">
  // Tier-1 mobile Tasks header (WS0 foundation, frozen). 3-column bar
  // [48px · 1fr · 48px] on the .material-bar + .hairline-b shell. Left: a back
  // chevron when drilled into a detail (calls goBackFromConversation), hidden at a
  // section root. Center: the tappable project glyph + name → TasksProjectSheet.
  // Right: an optional host-supplied action snippet (Work Items mounts Display /
  // Filter here). Renders the tier-2 MobileTasksSectionNav directly beneath. Shown
  // only on project routes; the bare /tasks redirect frame and the /tasks/item/*
  // detail route (which owns its own chrome) render nothing.
  import type { Snippet } from "svelte";
  import { page } from "$app/state";
  import { projectsCache } from "$lib/state/app.svelte.js";
  import { goBackFromConversation } from "$lib/mobile/swipeBack.js";
  import MobileTasksSectionNav from "./MobileTasksSectionNav.svelte";
  import TasksProjectSheet from "./TasksProjectSheet.svelte";
  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";

  let {
    right,
    pagesEnabled = true,
  }: {
    // Host-supplied right-side actions (e.g. Work Items' Display / Filter icons).
    right?: Snippet;
    pagesEnabled?: boolean;
  } = $props();

  const wsId = $derived(page.params.id ?? "");
  const projectId = $derived(page.params.projectId ?? "");
  // Drilled into a detail when a segment sits AFTER /<projectId>/<section> — i.e.
  // /workspace/<ws>/tasks/<projectId>/<section>/<itemId> (6+ segments). At a bare
  // section root the back chevron is hidden (the section strip is the landing).
  const drilled = $derived(page.url.pathname.split("/").filter(Boolean).length > 5);
  const project = $derived(
    wsId && projectId
      ? (projectsCache.get(wsId)?.projects.find((p) => p.id === projectId) ?? null)
      : null,
  );

  let projectSheetOpen = $state(false);
</script>

{#if projectId}
  <header class="material-bar hairline-b shrink-0">
    <div class="grid h-11 grid-cols-[48px_minmax(0,1fr)_48px] items-center gap-1 px-1">
      <!-- Left: back chevron when drilled into a detail. -->
      <div class="flex items-center justify-start">
        {#if drilled}
          <button
            type="button"
            onclick={goBackFromConversation}
            aria-label="Back"
            class="grid size-9 place-items-center rounded-full text-content transition-colors hover:bg-hover-gray focus-ring"
          >
            <ChevronLeftIcon class="size-5" />
          </button>
        {/if}
      </div>

      <!-- Center: tappable project name → project switcher sheet. -->
      <button
        type="button"
        onclick={() => (projectSheetOpen = true)}
        class="flex min-w-0 items-center justify-center gap-1.5 rounded-full px-2 py-1 transition-colors hover:bg-hover-gray focus-ring"
        aria-haspopup="dialog"
      >
        {#if project}
          <span
            class="size-2.5 shrink-0 rounded-full"
            style={`background-color:${project.color}`}
          ></span>
        {/if}
        <span class="min-w-0 truncate text-sm font-semibold text-content">
          {project?.name ?? "Tasks"}
        </span>
        <ChevronDownIcon class="size-4 shrink-0 text-content-muted" />
      </button>

      <!-- Right: host actions (Display / Filter on Work Items). -->
      <div class="flex items-center justify-end">
        {#if right}{@render right()}{/if}
      </div>
    </div>

    <MobileTasksSectionNav {pagesEnabled} />
  </header>

  <TasksProjectSheet bind:open={projectSheetOpen} />
{/if}
