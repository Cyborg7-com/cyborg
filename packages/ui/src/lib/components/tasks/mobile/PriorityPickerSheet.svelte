<script lang="ts">
  // FROZEN picker sheet (WS0). Bottom-sheet wrapper around the shared
  // PriorityDropdown leaf (variant="inline" — the option list directly, no
  // trigger/popover). Single-select: one tap picks + closes.
  import MobileSheet from "$lib/components/MobileSheet.svelte";
  import PriorityDropdown from "$lib/components/tasks/PriorityDropdown.svelte";
  import type { Priority } from "$lib/tasks/priority.js";

  let {
    open = $bindable(false),
    value = "none",
    options = undefined,
    onChange,
    onclose,
    title = "Priority",
  }: {
    open?: boolean;
    value?: Priority;
    options?: Priority[];
    onChange: (next: Priority) => void;
    onclose?: () => void;
    title?: string;
  } = $props();

  function pick(next: Priority): void {
    onChange(next);
    open = false;
    onclose?.();
  }
</script>

<MobileSheet bind:open {title} {onclose} ariaLabel="Select priority">
  <div class="pb-2">
    {#if options}
      <PriorityDropdown {value} {options} variant="inline" onChange={pick} class="w-full" />
    {:else}
      <PriorityDropdown {value} variant="inline" onChange={pick} class="w-full" />
    {/if}
  </div>
</MobileSheet>
