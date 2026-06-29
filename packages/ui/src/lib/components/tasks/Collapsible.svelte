<script lang="ts">
  // A count/progress COLLAPSIBLE section for the issue-detail body — the widget
  // wrapping Plane's "Sub-work-items" / "Links" / "Attachments" groups. The
  // header carries a rotating chevron, the section title, and a trailing meta
  // cluster (a count badge, OR a "done / total" progress fraction + thin bar),
  // and the slotted body shows/hides on toggle.
  //
  // Wraps the repo's shadcn-svelte Collapsible primitive (bits-ui), so open
  // state, accessibility (aria-expanded / aria-controls), and the
  // open/close animation hooks all come from the primitive — this only supplies
  // the Plane-faithful look (lib/tasks/ui.ts) and the count/progress affordance.
  // The chevron rotates off the trigger's data-state, so no extra state is held
  // here. `open` is bindable so a surface can control the section externally.
  //
  // Presentation-only and token-only: every class resolves through an app.css
  // token, so dark + light both work and there are zero hardcoded colors.
  import type { Snippet } from "svelte";
  import {
    Collapsible as CollapsibleRoot,
    CollapsibleTrigger,
    CollapsibleContent,
  } from "$lib/components/ui/collapsible/index.js";
  import {
    collapsibleHeader,
    collapsibleChevron,
    collapsibleTitle,
    collapsibleMeta,
    collapsibleCount,
    collapsibleProgressTrack,
    collapsibleProgressFill,
    collapsibleBody,
  } from "$lib/tasks/ui.js";
  import { cn } from "$lib/utils.js";

  let {
    title,
    open = $bindable(true),
    count,
    done,
    total,
    actions,
    children,
    class: className,
  }: {
    // Section heading shown in the header ("Sub-work items" / "Links" / …).
    title: string;
    // Open/closed state — bindable so the surface can drive it externally.
    open?: boolean;
    // A plain item count shown as a badge ("3"). Ignored when `total` is set
    // (progress mode takes over). Omit both for a header with no meta badge.
    count?: number;
    // Progress mode: when `total` is given the meta cluster shows a
    // "<done>/<total>" fraction + a thin completion bar (sub-work-items). `done`
    // defaults to 0.
    done?: number;
    total?: number;
    // Optional trailing actions snippet placed AFTER the count/progress (e.g. a
    // "+ Add" button). Rendered inside the meta cluster, not the trigger, so its
    // own clicks don't toggle the section.
    actions?: Snippet;
    // The collapsible body content (the rows list).
    children: Snippet;
    class?: string;
  } = $props();

  // Progress mode is active whenever a total is supplied. The fill width is the
  // completion ratio clamped to [0,1]; an empty total renders an empty bar.
  const inProgressMode = $derived(total !== undefined);
  const doneCount = $derived(done ?? 0);
  const pct = $derived(
    inProgressMode && (total ?? 0) > 0 ? Math.min(100, Math.max(0, (doneCount / (total as number)) * 100)) : 0,
  );
</script>

<CollapsibleRoot bind:open class={cn("flex flex-col", className)}>
  <div class={collapsibleHeader}>
    <CollapsibleTrigger
      class="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-ring"
      aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
    >
      <!-- chevron-right: rotates 90° to point down when the section is open. -->
      <span class={cn(collapsibleChevron, open && "rotate-90")}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </span>
      <span class={collapsibleTitle}>{title}</span>
    </CollapsibleTrigger>

    <div class={collapsibleMeta}>
      {#if inProgressMode}
        <span class="text-[12px] tabular-nums">{doneCount}/{total}</span>
        <span class={collapsibleProgressTrack} aria-hidden="true">
          <span class={collapsibleProgressFill} style={`width:${pct}%`}></span>
        </span>
      {:else if count !== undefined}
        <span class={collapsibleCount}>{count}</span>
      {/if}
      {#if actions}
        {@render actions()}
      {/if}
    </div>
  </div>

  <CollapsibleContent class={collapsibleBody}>
    {@render children()}
  </CollapsibleContent>
</CollapsibleRoot>
