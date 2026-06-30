<script lang="ts">
  // FROZEN picker sheet (WS0). Bottom-sheet wrapper around the shared
  // AssigneeDropdown leaf (variant="inline" — the grouped option list directly,
  // no trigger/popover). Single-select (null = Unassigned): one tap picks + closes.
  import MobileSheet from "$lib/components/MobileSheet.svelte";
  import AssigneeDropdown from "$lib/components/tasks/AssigneeDropdown.svelte";
  import type { AssigneePools } from "$lib/tasks/assignee.js";

  let {
    open = $bindable(false),
    value = null,
    pools,
    onChange,
    onclose,
    title = "Assignee",
  }: {
    open?: boolean;
    value?: string | null;
    pools: AssigneePools;
    onChange: (next: string | null) => void;
    onclose?: () => void;
    title?: string;
  } = $props();

  function pick(next: string | null): void {
    onChange(next);
    open = false;
    onclose?.();
  }
</script>

<MobileSheet bind:open {title} {onclose} ariaLabel="Select assignee">
  <div class="pb-2">
    <AssigneeDropdown {value} {pools} variant="inline" onChange={pick} class="w-full" />
  </div>
</MobileSheet>
