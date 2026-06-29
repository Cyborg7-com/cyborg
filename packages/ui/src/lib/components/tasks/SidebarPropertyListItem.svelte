<script lang="ts">
  // A single PROPERTY ROW for the issue-detail sidebar (Plane's
  // issue-detail-property-row): a fixed leading icon + label on the left, and a
  // grow inline EDITOR slot on the right. This is the row used for State /
  // Assignee / Priority / Start / Due / Labels / Cycle / Modules / Parent — the
  // surface passes the property's icon + name and renders the actual control
  // (a dropdown / date / member picker) into the `children` slot, which fills
  // the rest of the row via the shared `propertyEditor` look.
  //
  // Presentation-only: the row owns NO state and NO control logic — it just lays
  // out the fixed label column and the grow editor column. Every class resolves
  // through an app.css token (lib/tasks/ui.ts), so dark + light both work and
  // there are zero hardcoded colors here.
  import type { Snippet } from "svelte";
  import { propertyRow, propertyIcon, propertyLabel } from "$lib/tasks/ui.js";
  import { cn } from "$lib/utils.js";

  let {
    label,
    icon,
    children,
    class: className,
  }: {
    // The property name shown in the fixed-width quiet label column.
    label: string;
    // Optional leading glyph slot (a lucide icon / inline svg). Sized + colored
    // by `propertyIcon`; omit it for an icon-less row (the label column still
    // aligns because the editor stays in the same place).
    icon?: Snippet;
    // The inline editor control filling the rest of the row (dropdown / date /
    // member trigger / label chips). Rendered inside the grow column.
    children: Snippet;
    class?: string;
  } = $props();
</script>

<div class={cn(propertyRow, className)}>
  {#if icon}
    <span class={propertyIcon}>{@render icon()}</span>
  {/if}
  <span class={propertyLabel}>{label}</span>
  {@render children()}
</div>
