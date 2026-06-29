<!--
  SidebarSection — the collapsible section scaffold ChannelSidebar repeated ~6×
  (Favorites, Channels, Agent sessions, Archived sessions, Plugin sections,
  Direct Messages). Wraps the shared `Collapsible` + the header row (h-[34px]
  px-2, chevron, label) so the section height / spacing / chevron live in one
  place (#530).

  Props:
  - `label`        — section title.
  - `open`         — bindable open state. Defaults to true so always-open
                     sections (e.g. plugin sections) can pass `open={true}`.
  - `onOpenChange` — forwarded to the underlying Collapsible.
  - `class`        — extra classes on the outer Collapsible (the px-2 base is
                     always applied; callers add margins like `mt-2`).
  - `labelSuffix`  — optional snippet rendered inside the trigger after the
                     label (e.g. an item-count badge).
  - `actions`      — optional snippet rendered at the right of the header row
                     (e.g. new-channel / new-session buttons). Brings its own
                     container so callers keep full control of the button group.
  - `children`     — the section body (rendered inside CollapsibleContent).
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "$lib/components/ui/collapsible/index.js";
  import { cn } from "$lib/utils.js";

  let {
    label,
    open = $bindable(true),
    onOpenChange,
    class: className = "",
    labelSuffix,
    actions,
    children,
  }: {
    label: string;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    class?: string;
    labelSuffix?: Snippet;
    actions?: Snippet;
    children: Snippet;
  } = $props();
</script>

<Collapsible bind:open {onOpenChange} class={cn("px-2", className)}>
  <div class="flex items-center justify-between px-2 h-[34px]">
    <CollapsibleTrigger class="flex items-center gap-1.5 text-[15px] text-content-dim hover:text-content cursor-pointer">
      <svg class={cn("shrink-0 transition-transform duration-150", !open && "-rotate-90")} width="12" height="12" viewBox="0 0 16 16" fill="var(--secondary)">
        <path d="M4.5 6L8 9.5L11.5 6" stroke="var(--secondary)" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span class="font-semibold">{label}</span>
      {#if labelSuffix}
        {@render labelSuffix()}
      {/if}
    </CollapsibleTrigger>
    {#if actions}
      {@render actions()}
    {/if}
  </div>
  <CollapsibleContent>
    {@render children()}
  </CollapsibleContent>
</Collapsible>
