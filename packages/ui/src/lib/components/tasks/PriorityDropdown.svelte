<script lang="ts">
  // Controlled PRIORITY editor for the Tasks surfaces. Renders a trigger CHIP
  // (compact card) or a ROW editor (detail-panel property row) that opens a
  // dropdown listing the five priorities, each with its PriorityIcon. Selecting
  // one fires onChange(priority) — the PARENT owns persistence; this component
  // holds NO client/state references and no internal "current value" beyond the
  // controlled `value` prop.
  //
  // Token-only: every class resolves through an app.css token via lib/tasks/ui.ts
  // (inlineRowControl / propertyEditor / propertyEditorEmpty / menuPanel /
  // filterOption / menuItemRowActive), so dark + light both work and there are
  // zero raw color literals here. The per-priority color comes from PriorityIcon
  // (the --priority-* token), never inlined.
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
  } from "$lib/components/ui/dropdown-menu/index.js";
  import PriorityIcon from "$lib/components/tasks/PriorityIcon.svelte";
  import { haptic } from "$lib/mobile/haptics.js";
  import { PRIORITIES } from "$lib/tasks/constants.js";
  import type { Priority } from "$lib/tasks/priority.js";
  import {
    workPriorityBox,
    propertyEditor,
    propertyEditorEmpty,
    menuPanel,
    filterOption,
    menuItemRowActive,
  } from "$lib/tasks/ui.js";
  import { cn } from "$lib/utils.js";

  let {
    value = "none",
    options = PRIORITIES.map((p) => p.key),
    disabled = false,
    onChange,
    placeholder = "Priority",
    variant = "chip",
    class: className,
  }: {
    // The current priority. Controlled — never mutated here.
    value?: Priority;
    // Which priorities to offer. Defaults to all five (urgent → none).
    options?: Priority[];
    disabled?: boolean;
    // Fired with the chosen priority on every selection.
    onChange: (next: Priority) => void;
    // Trigger hint when value is "none" in `row` variant.
    placeholder?: string;
    // "chip" = compact card affordance; "row" = full-width detail-panel editor;
    // "inline" = the option list rendered directly (no trigger/popover) for the
    // mobile picker sheet.
    variant?: "chip" | "row" | "inline";
    class?: string;
  } = $props();

  const meta = $derived(PRIORITIES.find((p) => p.key === value) ?? PRIORITIES[PRIORITIES.length - 1]);
  // The list shown in the menu, in the canonical constants order.
  const items = $derived(PRIORITIES.filter((p) => options.includes(p.key)));
  const isEmpty = $derived(value === "none");
  // chip = Plane's PRIORITY box (border-without-text, icon-only square); its
  // border is priority-KEYED. Full class strings so Tailwind keeps the utilities.
  const PRIORITY_BORDER: Record<Priority, string> = {
    urgent: "border-priority-urgent",
    high: "border-priority-high",
    medium: "border-priority-medium",
    low: "border-priority-low",
    none: "border-edge",
  };
  const triggerClass = $derived(
    variant === "row" ? propertyEditor : cn(workPriorityBox, PRIORITY_BORDER[value]),
  );
</script>

{#if variant === "inline"}
  <!-- Inline option list for the mobile picker sheet: same rows as the popover
       (PriorityIcon + label, selected row tinted), no trigger/popover. One tap
       fires onChange — the sheet persists + closes. -->
  <div class={cn("flex flex-col", className)}>
    {#each items as p (p.key)}
      <button
        type="button"
        {disabled}
        aria-label={`Priority: ${p.label}`}
        aria-pressed={value === p.key}
        class={cn(filterOption, "cursor-pointer", value === p.key && menuItemRowActive)}
        onclick={() => {
          haptic("selection");
          onChange(p.key);
        }}
      >
        <PriorityIcon priority={p.key} size={16} />
        <span class="truncate">{p.label}</span>
      </button>
    {/each}
  </div>
{:else}
  <DropdownMenu>
  <DropdownMenuTrigger
    {disabled}
    title={meta.label}
    aria-label={`Priority: ${meta.label}`}
    class={cn(triggerClass, "data-[state=open]:bg-hover-gray", className)}
  >
    <PriorityIcon priority={value} size={variant === "row" ? 16 : 12} />
    {#if variant === "row"}
      <span class={cn("truncate", isEmpty && propertyEditorEmpty)}>
        {isEmpty ? placeholder : meta.label}
      </span>
    {/if}
  </DropdownMenuTrigger>
  <DropdownMenuContent align="start" class={cn(menuPanel, "p-1")}>
    {#each items as p (p.key)}
      <DropdownMenuItem
        class={cn(filterOption, "cursor-pointer", value === p.key && menuItemRowActive)}
        onSelect={() => onChange(p.key)}
      >
        <PriorityIcon priority={p.key} size={16} />
        <span class="truncate">{p.label}</span>
      </DropdownMenuItem>
    {/each}
  </DropdownMenuContent>
  </DropdownMenu>
{/if}
