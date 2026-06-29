<!--
  ProjectSubNav — the stacked secondary nav Plane reveals under an active project:
  Overview, Work items (the default view), Cycles, Modules, Views, Pages (Plane's
  project-navigation.tsx order + sentence-case labels). One vertical list of quiet
  rows nested under a left guide rail; the active row tints (bg-dropdown-selected +
  text-content) and the icon inherits the row text color. Each row is a leading
  glyph + label, routing to /workspace/<ws>/tasks/<projectId>/<view>. Styled with
  inline Plane-faithful tailwind (theme tokens) so dark + light both resolve.

  FEATURE GATING (seam): Plane gates Cycles / Modules / Pages / Views behind
  per-project feature flags. The client `Project` type carries no flags yet
  (ws-client.ts), so the `features` prop defaults every gated view ON; when the
  server starts returning per-project flags, pass them here and the gated rows
  hide with no other change. Overview + Work Items are always shown.

  Token-only — zero raw hex, dark + light both resolve.
-->
<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import { cn } from "$lib/utils.js";

  // Which gated views this project enables. Defaults to all-on (the seam for
  // future server-side per-project feature flags).
  interface ProjectFeatures {
    cycles?: boolean;
    modules?: boolean;
    pages?: boolean;
    views?: boolean;
  }

  let {
    wsId,
    projectId,
    features = {},
  }: { wsId: string; projectId: string; features?: ProjectFeatures } = $props();

  // The active view is the route's last path segment under the project (the
  // views are STATIC route segments — work-items / cycles / … — not a route
  // param). Work Items is the default, so a path that doesn't end in a known view
  // segment highlights it too.
  const activeView = $derived.by(() => {
    const segs = page.url.pathname.split("/").filter(Boolean);
    const i = segs.indexOf(projectId);
    return i >= 0 ? (segs[i + 1] ?? "work-items") : "work-items";
  });

  // Stable glyph key per view; mapped to an inline SVG below (lucide-style),
  // keeping the icon set local + token-tintable like the rest of the surface.
  type ViewKey = "overview" | "work-items" | "cycles" | "modules" | "pages" | "views";
  interface ViewRow {
    key: ViewKey;
    label: string;
    // Whether this row is gated behind a project feature flag.
    gated?: keyof ProjectFeatures;
  }

  // Order + label casing mirror Plane's project-navigation.tsx sortOrder
  // (Overview prepended per the EE navigation root) — Work items / Cycles /
  // Modules / Views / Pages. Plane uses sentence case ("Work items"), not Title
  // Case; Views precedes Pages (Plane sortOrder 4 vs 5).
  const VIEWS: ViewRow[] = [
    { key: "overview", label: "Overview" },
    { key: "work-items", label: "Work items" },
    { key: "cycles", label: "Cycles", gated: "cycles" },
    { key: "modules", label: "Modules", gated: "modules" },
    { key: "views", label: "Views", gated: "views" },
    { key: "pages", label: "Pages", gated: "pages" },
  ];

  // A gated row shows when its flag is unset (default-on seam) or explicitly true.
  const visibleViews = $derived(
    VIEWS.filter((v) => !v.gated || features[v.gated] !== false),
  );

  function openView(view: ViewKey): void {
    if (!wsId) return;
    viewportState.closeDrawer();
    goto(`/workspace/${wsId}/tasks/${projectId}/${view}`);
  }
</script>

<!-- Plane projects-list-item.tsx:480-483 — the nested nav panel: `relative mt-1
     mb-1.5 flex flex-col gap-0.5 pl-6` with an absolute vertical guide line
     (`top-0 bottom-1 left-[15px] w-[1px] bg-layer-3`) that reads as the nesting
     rail under the project row. -->
<div class="relative mb-1.5 mt-1 flex flex-col gap-0.5 pl-6">
  <div class="absolute bottom-1 left-[15px] top-0 w-[1px] bg-edge"></div>
  {#each visibleViews as v (v.key)}
    {@const isActive = v.key === activeView}
    <!-- Plane SidebarNavItem (sidebar-navigation.tsx) — rounded-md px-2 py-1;
         active row tints (bg-layer-transparent-active text-primary), idle is
         text-secondary hover:bg-layer-transparent-hover. The leading icon has NO
         color class of its own, so it INHERITS the row's text color (active →
         content, idle → dim), never a permanent muted tint. Label is text-11
         font-medium. -->
    <button
      type="button"
      onclick={() => openView(v.key)}
      class={cn(
        "group flex items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors",
        isActive
          ? "bg-dropdown-selected text-content"
          : "text-content-dim hover:bg-hover-gray hover:text-content",
      )}
      aria-current={isActive ? "page" : undefined}
    >
      <span class="grid size-4 shrink-0 place-items-center">
        {#if v.key === "overview"}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" />
          </svg>
        {:else if v.key === "work-items"}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" />
          </svg>
        {:else if v.key === "cycles"}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" />
          </svg>
        {:else if v.key === "modules"}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="8" height="8" rx="1" /><rect x="13" y="3" width="8" height="8" rx="1" /><rect x="3" y="13" width="8" height="8" rx="1" /><rect x="13" y="13" width="8" height="8" rx="1" />
          </svg>
        {:else if v.key === "pages"}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 4a2 2 0 0 1 2-2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /><path d="M14 2v6h6" />
          </svg>
        {:else}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" />
          </svg>
        {/if}
      </span>
      <span class="min-w-0 flex-1 truncate text-[11px] font-medium">{v.label}</span>
    </button>
  {/each}
</div>
