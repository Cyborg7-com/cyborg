<script lang="ts">
  // FROZEN picker sheet (WS0). Bottom-sheet wrapper around the shared LabelDropdown
  // leaf (variant="inline" — the filter + checkbox list directly, no trigger/popover).
  // MULTI-select: each tap toggles and the sheet stays open across toggles; the
  // host dismisses it (swipe-down / backdrop). `onChange` receives the full next id
  // array; the optional `onCreate` enables inline create-by-name.
  import MobileSheet from "$lib/components/MobileSheet.svelte";
  import LabelDropdown from "$lib/components/tasks/LabelDropdown.svelte";
  import type { TaskLabel } from "$lib/core/types.js";

  let {
    open = $bindable(false),
    value = [],
    options = [],
    onChange,
    onCreate,
    onclose,
    title = "Labels",
  }: {
    open?: boolean;
    value?: string[];
    options?: TaskLabel[];
    onChange: (next: string[]) => void;
    onCreate?: (name: string) => void;
    onclose?: () => void;
    title?: string;
  } = $props();
</script>

<MobileSheet bind:open {title} {onclose} ariaLabel="Select labels">
  <div class="pb-2">
    <LabelDropdown {value} {options} variant="inline" {onChange} {onCreate} class="w-full" />
  </div>
</MobileSheet>
