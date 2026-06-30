<!--
  PagesList — the project Pages index (Plane-style wiki/docs list). A header with
  an "Add page" primary action, Public / Private / Archived tabs, a search box +
  sort menu, then the list of page rows (doc icon, title, visibility, owner, ⋯).
  Backed by the client Pages RPCs (fetchPages / createPage / updatePage /
  setPageArchived / deletePage); refetches on the live `pages_changed` broadcast.
  Left-anchored to match the rest of the Tasks surface. Tokens only.
-->
<script lang="ts">
  import { goto } from "$app/navigation";
  import { client } from "$lib/state/app.svelte.js";
  import { authState } from "$lib/core/state.svelte.js";
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
  } from "$lib/components/ui/dropdown-menu/index.js";
  import { cn } from "$lib/utils.js";
  import type { Page } from "$lib/core/types.js";
  import { buildPageTree, canNestUnder, type PageNode } from "$lib/tasks/page-tree.js";
  import { readPagesCollapsed, writePagesCollapsed } from "$lib/tasks/local-prefs.js";
  import { SvelteSet } from "svelte/reactivity";
  import Emoji from "$lib/components/Emoji.svelte";
  import FileTextIcon from "@lucide/svelte/icons/file-text";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";

  let { wsId, projectId }: { wsId: string; projectId: string } = $props();

  type Tab = "public" | "private" | "archived";
  type SortKey = "updated" | "created" | "title";

  let pages = $state<Page[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let tab = $state<Tab>("public");
  let query = $state("");
  let sortKey = $state<SortKey>("updated");

  const SORT_LABELS: Record<SortKey, string> = {
    updated: "Date modified",
    created: "Date created",
    title: "Title",
  };

  async function load(): Promise<void> {
    if (!projectId) {
      loading = false;
      return;
    }
    try {
      pages = await client.fetchPages(projectId);
      error = null;
    } catch (e) {
      error = `Couldn't load pages: ${e instanceof Error ? e.message : String(e)}`;
      console.error("[pages] fetchPages failed", e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void projectId;
    loading = true;
    void load();
    const off = client.on("pages_changed", () => void load());
    return off;
  });

  // Tab + search → the flat set of rows in scope (before nesting).
  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const rows = pages.filter((p) => {
      if (tab === "archived") return p.archivedAt != null;
      if (p.archivedAt != null) return false;
      return tab === "public" ? p.visibility === "public" : p.visibility === "private";
    });
    return q ? rows.filter((p) => (p.title || "Untitled").toLowerCase().includes(q)) : rows;
  });

  // Sibling comparator driven by the sort menu. The tree builder's own default
  // (sortOrder then title, per the backend contract) still applies when no menu
  // option is in play — here the user's choice orders siblings at every level.
  const compare = $derived.by(() => {
    if (sortKey === "title") return (a: Page, b: Page) => (a.title || "").localeCompare(b.title || "");
    if (sortKey === "created") return (a: Page, b: Page) => b.createdAt - a.createdAt;
    return (a: Page, b: Page) => b.updatedAt - a.updatedAt;
  });

  // The flat (filtered) list reshaped into the rendered hierarchy. Pure $derived —
  // rebuilt only when pages / filters / sort change, never inside an effect. A
  // child whose parent is filtered out is promoted to a root by buildPageTree.
  const tree = $derived(buildPageTree(filtered, compare));

  // Locally-persisted disclosure state: collapsed page ids (default = expanded),
  // keyed per workspace+project so different projects keep independent state.
  const collapsed = new SvelteSet<string>();

  // Hydrate the collapsed set from localStorage whenever the workspace/project
  // changes (and on mount). We refill the SAME reactive instance the rows read
  // from rather than reassigning, so the disclosure chevrons re-render in place.
  // Escape-hatch $effect: syncing a reactive Set to an external (localStorage)
  // store — it depends only on wsId/projectId and never reads `collapsed`, so it
  // can't self-trigger on a later toggle.
  $effect(() => {
    const ids = readPagesCollapsed(wsId, projectId);
    collapsed.clear();
    for (const id of ids) collapsed.add(id);
  });

  function persistCollapsed(): void {
    writePagesCollapsed(wsId, projectId, collapsed);
  }

  function toggleCollapsed(id: string): void {
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    persistCollapsed();
  }

  // ─── Drag-to-nest ────────────────────────────────────────────────
  let draggingId = $state<string | null>(null);
  let dragOverId = $state<string | null>(null); // row currently a valid drop target
  let dragOverRoot = $state(false); // the root/empty area is the drop target

  function onDragStart(e: DragEvent, id: string): void {
    draggingId = id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
    }
  }

  function onDragEnd(): void {
    draggingId = null;
    dragOverId = null;
    dragOverRoot = false;
  }

  // Allow a drop onto a row only when nesting is legal (not onto self/descendant).
  function onDragOverRow(e: DragEvent, targetId: string): void {
    if (draggingId == null) return;
    // Don't let the event bubble to the root drop zone — a row hover must not
    // also light up (or drop to) the root.
    e.stopPropagation();
    dragOverRoot = false;
    if (!canNestUnder(pages, draggingId, targetId) || draggingId === targetId) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
      dragOverId = null;
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    dragOverId = targetId;
  }

  function onDropRow(e: DragEvent, targetId: string): void {
    e.preventDefault();
    e.stopPropagation(); // don't also trigger the root drop zone
    const id = draggingId;
    onDragEnd();
    if (id != null) void reparent(id, targetId);
  }

  function onDragOverRoot(e: DragEvent): void {
    if (draggingId == null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    dragOverRoot = true;
    dragOverId = null;
  }

  function onDropRoot(e: DragEvent): void {
    e.preventDefault();
    const id = draggingId;
    onDragEnd();
    if (id != null) void reparent(id, null);
  }

  // Re-parent a page (null = move to root). Guards against illegal / no-op moves
  // before hitting the network; the backend rejects cycles too, this is the
  // immediate UI feedback.
  async function reparent(id: string, parentId: string | null): Promise<void> {
    const target = pages.find((p) => p.id === id);
    if (!target || target.parentId === parentId) return;
    if (!canNestUnder(pages, id, parentId)) return;
    try {
      error = null;
      if (parentId != null) {
        collapsed.delete(parentId); // reveal the new child
        persistCollapsed();
      }
      await client.updatePage(id, { parentId });
      await load();
    } catch (e) {
      error = `Couldn't move page: ${e instanceof Error ? e.message : String(e)}`;
      console.error("[pages] updatePage(parentId) failed", e);
    }
  }

  async function addSubpage(parent: Page): Promise<void> {
    try {
      error = null;
      const created = await client.createPage(projectId, { parentId: parent.id });
      collapsed.delete(parent.id); // reveal the new child
      persistCollapsed();
      await load();
      openPage(created.id);
    } catch (e) {
      error = `Couldn't add subpage: ${e instanceof Error ? e.message : String(e)}`;
      console.error("[pages] addSubpage failed", e);
    }
  }

  const TABS: { key: Tab; label: string }[] = [
    { key: "public", label: "Public" },
    { key: "private", label: "Private" },
    { key: "archived", label: "Archived" },
  ];

  function openPage(id: string): void {
    goto(`/workspace/${wsId}/tasks/${projectId}/pages/${id}`);
  }

  async function addPage(): Promise<void> {
    try {
      error = null;
      const created = await client.createPage(projectId);
      await load();
      openPage(created.id);
    } catch (e) {
      error = `Couldn't create page: ${e instanceof Error ? e.message : String(e)}`;
      console.error("[pages] createPage failed", e);
    }
  }

  async function toggleVisibility(p: Page): Promise<void> {
    try {
      error = null;
      await client.updatePage(p.id, {
        visibility: p.visibility === "public" ? "private" : "public",
      });
      await load();
    } catch (e) {
      error = `Couldn't change visibility: ${e instanceof Error ? e.message : String(e)}`;
      console.error("[pages] updatePage(visibility) failed", e);
    }
  }

  async function toggleArchived(p: Page): Promise<void> {
    try {
      error = null;
      await client.setPageArchived(p.id, p.archivedAt == null);
      await load();
    } catch (e) {
      error = `Couldn't archive page: ${e instanceof Error ? e.message : String(e)}`;
      console.error("[pages] setPageArchived failed", e);
    }
  }

  async function removePage(p: Page): Promise<void> {
    try {
      error = null;
      await client.deletePage(p.id);
      await load();
    } catch (e) {
      error = `Couldn't delete page: ${e instanceof Error ? e.message : String(e)}`;
      console.error("[pages] deletePage failed", e);
    }
  }

  function fmtRel(ts: number): string {
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function ownerName(p: Page): string {
    if (!p.ownedBy) return "—";
    return authState.getMemberName(p.ownedBy) ?? "Someone";
  }
  function ownerImage(p: Page): string | null {
    return p.ownedBy ? authState.getMemberImage(p.ownedBy) : null;
  }
</script>

<div class="flex h-full w-full flex-col overflow-hidden bg-surface">
  <!-- Header: title + Add page -->
  <header class="flex items-center justify-between gap-3 border-b border-edge px-6 py-3">
    <h1 class="text-[15px] font-semibold text-content">Pages</h1>
    <button
      type="button"
      onclick={addPage}
      class="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium text-[color:var(--brand-contrast)] transition-colors hover:bg-accent-hover"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
      </svg>
      Add page
    </button>
  </header>

  {#if error}
    <div class="border-b border-edge bg-error/10 px-6 py-2 text-[13px] text-error" role="alert">
      {error}
    </div>
  {/if}

  <!-- Tabs + search + sort -->
  <div class="flex items-center justify-between gap-3 border-b border-edge px-6">
    <nav class="flex items-center gap-1" aria-label="Page visibility">
      {#each TABS as t (t.key)}
        {@const isActive = t.key === tab}
        <button
          type="button"
          onclick={() => (tab = t.key)}
          class={cn(
            "relative flex h-10 shrink-0 items-center px-1 text-[13px] font-medium transition-colors",
            isActive
              ? "text-content after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent"
              : "text-content-dim hover:text-content",
          )}
          aria-current={isActive ? "page" : undefined}
        >
          {t.label}
        </button>
      {/each}
    </nav>

    <div class="flex items-center gap-2">
      <div class="relative">
        <svg class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-content-muted" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          bind:value={query}
          placeholder="Search pages…"
          class="h-8 w-40 rounded-md border border-edge bg-surface-alt pl-7 pr-2 text-[13px] text-content placeholder:text-content-muted focus:border-edge-light focus:outline-none"
        />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          class="inline-flex h-8 items-center gap-1.5 rounded-md border border-edge px-2.5 text-[13px] text-content-dim transition-colors hover:bg-hover-gray hover:text-content"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M11 5h10M11 9h7M11 13h4" /><path d="m3 8 3-3 3 3" /><path d="M6 5v14" />
          </svg>
          {SORT_LABELS[sortKey]}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-44">
          {#each Object.entries(SORT_LABELS) as [key, label] (key)}
            <DropdownMenuItem class="cursor-pointer" onclick={() => (sortKey = key as SortKey)}>
              {label}
            </DropdownMenuItem>
          {/each}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>

  <!-- List -->
  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if loading}
      <div class="flex flex-col gap-px px-6 py-4">
        {#each Array.from({ length: 4 }) as _, i (i)}
          <div class="flex items-center gap-3 py-3">
            <span class="size-4 shrink-0 animate-pulse rounded bg-deeper"></span>
            <span class="h-3.5 w-48 animate-pulse rounded bg-deeper"></span>
          </div>
        {/each}
      </div>
    {:else if filtered.length === 0}
      <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <span class="grid size-12 place-items-center rounded-xl bg-surface-alt">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-content-muted" aria-hidden="true">
            <path d="M4 4a2 2 0 0 1 2-2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /><path d="M14 2v6h6" /><path d="M9 13h6M9 17h4" />
          </svg>
        </span>
        <div>
          <p class="text-[14px] font-semibold text-content">
            {tab === "archived" ? "No archived pages" : "No pages yet"}
          </p>
          <p class="mt-1 max-w-sm text-[13px] text-content-muted">
            {tab === "archived"
              ? "Archived pages will show up here."
              : "Capture notes, docs, and PRDs. Click “Add page” to start."}
          </p>
        </div>
      </div>
    {:else}
      <!-- The page hierarchy. Dropping into the padding around the rows (or onto
           the empty tail) re-parents the dragged page to the root. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class={cn("px-3 py-2", dragOverRoot && "rounded-md ring-1 ring-inset ring-accent")}
        ondragover={onDragOverRoot}
        ondragleave={() => (dragOverRoot = false)}
        ondrop={onDropRoot}
      >
        {#each tree as node (node.page.id)}
          {@render pageRow(node, 0)}
        {/each}
      </div>
    {/if}
  </div>
</div>

<!-- A single page row plus its (expanded) descendants. Recursive: indents by
     `depth`, carries a disclosure chevron when it has children, and is a native
     drag source + drop target for re-parenting. -->
{#snippet pageRow(node: PageNode, depth: number)}
  {@const p = node.page}
  {@const hasChildren = node.children.length > 0}
  {@const isExpanded = !collapsed.has(p.id)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    draggable="true"
    ondragstart={(e) => onDragStart(e, p.id)}
    ondragend={onDragEnd}
    ondragover={(e) => onDragOverRow(e, p.id)}
    ondragleave={() => {
      if (dragOverId === p.id) dragOverId = null;
    }}
    ondrop={(e) => onDropRow(e, p.id)}
    class={cn(
      "group flex items-center gap-2 rounded-md py-2.5 pr-3 transition-colors hover:bg-hover-gray",
      dragOverId === p.id && "bg-accent/10 ring-1 ring-inset ring-accent",
      draggingId === p.id && "opacity-50",
    )}
    style={`padding-left:${depth * 18 + 8}px`}
  >
    <!-- Disclosure (or a spacer to keep titles aligned across depths) -->
    {#if hasChildren}
      <button
        type="button"
        onclick={() => toggleCollapsed(p.id)}
        class="grid size-5 shrink-0 place-items-center rounded text-content-muted transition-colors hover:bg-hover-gray hover:text-content"
        aria-expanded={isExpanded}
        aria-label={isExpanded
          ? `Collapse ${p.title || "Untitled"}`
          : `Expand ${p.title || "Untitled"}`}
      >
        <ChevronRightIcon
          size={14}
          class={cn("transition-transform", isExpanded && "rotate-90")}
        />
      </button>
    {:else}
      <span class="size-5 shrink-0" aria-hidden="true"></span>
    {/if}

    <button
      type="button"
      onclick={() => openPage(p.id)}
      class="flex min-w-0 flex-1 items-center gap-3 text-left"
    >
      {#if p.icon}
        <Emoji emoji={p.icon} size={16} class="shrink-0" />
      {:else}
        <FileTextIcon class="shrink-0 text-content-muted" size={16} strokeWidth={1.75} />
      {/if}
      <span class="min-w-0 flex-1 truncate text-[14px] text-content">{p.title || "Untitled"}</span>
    </button>

    <span class="hidden shrink-0 text-[13px] tabular-nums text-content-muted sm:block">
      {fmtRel(p.updatedAt)}
    </span>

    <!-- Visibility -->
    <span class="shrink-0 text-content-muted" title={p.visibility === "public" ? "Public" : "Private"}>
      {#if p.visibility === "public"}
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
        </svg>
      {:else}
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="4" y="11" width="16" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
      {/if}
    </span>

    <!-- Owner -->
    {#if ownerImage(p)}
      <img
        src={ownerImage(p)}
        alt={ownerName(p)}
        title={ownerName(p)}
        class="size-5 shrink-0 rounded-full object-cover"
      />
    {:else}
      <span
        class="grid size-5 shrink-0 place-items-center rounded-full bg-surface-alt text-[10px] font-medium uppercase text-content-dim"
        title={ownerName(p)}
      >
        {ownerName(p).charAt(0)}
      </span>
    {/if}

    <!-- Add subpage (hover affordance) -->
    <button
      type="button"
      onclick={() => void addSubpage(p)}
      class="grid size-6 shrink-0 place-items-center rounded text-content-muted opacity-0 transition-opacity hover:bg-hover-gray hover:text-content group-hover:opacity-100"
      aria-label={`Add subpage under ${p.title || "Untitled"}`}
      title="Add subpage"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>

    <!-- Row menu -->
    <DropdownMenu>
      <DropdownMenuTrigger
        class="grid size-6 shrink-0 place-items-center rounded text-content-muted opacity-0 transition-opacity hover:bg-hover-gray hover:text-content group-hover:opacity-100"
        aria-label="Page actions"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" />
        </svg>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-44">
        <DropdownMenuItem class="cursor-pointer" onclick={() => openPage(p.id)}>Open</DropdownMenuItem>
        <DropdownMenuItem class="cursor-pointer" onclick={() => addSubpage(p)}>
          Add subpage
        </DropdownMenuItem>
        {#if p.parentId != null}
          <DropdownMenuItem class="cursor-pointer" onclick={() => reparent(p.id, null)}>
            Move to root
          </DropdownMenuItem>
        {/if}
        <DropdownMenuItem class="cursor-pointer" onclick={() => toggleVisibility(p)}>
          {p.visibility === "public" ? "Make private" : "Make public"}
        </DropdownMenuItem>
        <DropdownMenuItem class="cursor-pointer" onclick={() => toggleArchived(p)}>
          {p.archivedAt == null ? "Archive" : "Unarchive"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          class="cursor-pointer text-error focus:text-error"
          onclick={() => removePage(p)}
        >
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>

  {#if hasChildren && isExpanded}
    {#each node.children as child (child.page.id)}
      {@render pageRow(child, depth + 1)}
    {/each}
  {/if}
{/snippet}
