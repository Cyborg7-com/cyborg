<script lang="ts">
  // FROZEN picker sheet (WS0). Bottom-sheet wrapper around the shared StateDropdown
  // leaf (variant="inline" — the grouped option list, no trigger/popover, so the
  // sheet opens DIRECTLY to the options). Single-select: one tap picks + closes.
  // Other teams wire `onChange` to their saver (e.g. useTaskDetail.saveState).
  import MobileSheet from "$lib/components/MobileSheet.svelte";
  import StateDropdown from "$lib/components/tasks/StateDropdown.svelte";
  import type { TaskState } from "$lib/core/types.js";

  let {
    open = $bindable(false),
    value = null,
    options = [],
    onChange,
    onclose,
    title = "State",
  }: {
    open?: boolean;
    value?: string | null;
    options?: TaskState[];
    onChange: (next: string) => void;
    onclose?: () => void;
    title?: string;
  } = $props();

  function pick(next: string): void {
    onChange(next);
    open = false;
    onclose?.();
  }
</script>

<MobileSheet bind:open {title} {onclose} ariaLabel="Select state">
  <div class="pb-2">
    <StateDropdown {value} {options} variant="inline" onChange={pick} class="w-full" />
  </div>
</MobileSheet>
