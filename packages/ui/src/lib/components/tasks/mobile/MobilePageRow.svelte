<script lang="ts">
  // WS5 (mobile · PAGES) — one row of the mobile Pages tree, recursive over its
  // children. Trimmed to the phone shape the brief locks: [chevron · icon · title
  // · ⋯]. The body (icon + title) opens the page; the ALWAYS-VISIBLE ⋯ button (the
  // desktop hover affordance, lifted to a touch target) opens the page action
  // sheet. Drag-to-nest is CUT on mobile — re-parenting lives in the ⋯ sheet's
  // "Move to root". Pure presentation: props in, callbacks out. Tokens only.
  import type { SvelteSet } from "svelte/reactivity";
  import type { Page } from "$lib/core/types.js";
  import type { PageNode } from "$lib/tasks/page-tree.js";
  import { cn } from "$lib/utils.js";
  import Emoji from "$lib/components/Emoji.svelte";
  import FileTextIcon from "@lucide/svelte/icons/file-text";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import LockIcon from "@lucide/svelte/icons/lock";
  import MoreHorizontalIcon from "@lucide/svelte/icons/more-horizontal";
  // Recursive self-reference: a component may import its own module so the tree
  // renders to arbitrary depth without a parent-owned recursive snippet.
  import Self from "./MobilePageRow.svelte";

  let {
    node,
    depth,
    collapsed,
    onopen,
    ontoggle,
    onactions,
  }: {
    node: PageNode;
    depth: number;
    collapsed: SvelteSet<string>;
    onopen: (id: string) => void;
    ontoggle: (id: string) => void;
    onactions: (page: Page) => void;
  } = $props();

  const p = $derived(node.page);
  const hasChildren = $derived(node.children.length > 0);
  const isExpanded = $derived(!collapsed.has(p.id));
  const titleText = $derived(p.title || "Untitled");
</script>

<div
  class="touch-target-row group flex items-center gap-1 rounded-[var(--radius-md)] pr-1"
  style={`padding-left:${depth * 16}px`}
>
  <!-- Disclosure chevron, or an aligning spacer so titles line up across depths. -->
  {#if hasChildren}
    <button
      type="button"
      onclick={() => ontoggle(p.id)}
      class="grid size-9 shrink-0 place-items-center rounded-[var(--radius-sm)] text-content-muted transition-colors hover:bg-hover-gray hover:text-content focus-ring"
      aria-expanded={isExpanded}
      aria-label={isExpanded ? `Collapse ${titleText}` : `Expand ${titleText}`}
    >
      <ChevronRightIcon class={cn("size-4 transition-transform", isExpanded && "rotate-90")} />
    </button>
  {:else}
    <span class="size-9 shrink-0" aria-hidden="true"></span>
  {/if}

  <!-- Row body → open the page. -->
  <button
    type="button"
    onclick={() => onopen(p.id)}
    class="pressable-row flex min-w-0 flex-1 items-center gap-2.5 rounded-[var(--radius-sm)] py-2 text-left"
  >
    {#if p.icon}
      <Emoji emoji={p.icon} size={18} class="shrink-0" />
    {:else}
      <FileTextIcon class="shrink-0 text-content-muted" size={18} strokeWidth={1.75} />
    {/if}
    <span class="min-w-0 flex-1 truncate text-sm text-content">{titleText}</span>
    {#if p.visibility === "private"}
      <LockIcon class="size-3.5 shrink-0 text-content-muted" aria-label="Private" />
    {/if}
  </button>

  <!-- Always-visible overflow ⋯ → the page action sheet. -->
  <button
    type="button"
    onclick={() => onactions(p)}
    class="grid size-9 shrink-0 place-items-center rounded-[var(--radius-sm)] text-content-muted transition-colors hover:bg-hover-gray hover:text-content focus-ring"
    aria-label={`Actions for ${titleText}`}
  >
    <MoreHorizontalIcon class="size-5" />
  </button>
</div>

{#if hasChildren && isExpanded}
  {#each node.children as child (child.page.id)}
    <Self node={child} depth={depth + 1} {collapsed} {onopen} {ontoggle} {onactions} />
  {/each}
{/if}
