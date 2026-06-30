<script lang="ts">
  // FROZEN picker sheet (WS0). Bottom-sheet wrapper around the shared ParentSelect
  // leaf (variant="inline" — the search + option list directly, no trigger/popover).
  // Single-select (null = No parent): one tap picks + closes. The optional
  // `onSearch` forwards the live query for a host doing server-side filtering;
  // omit it to filter the given `options` locally.
  import MobileSheet from "$lib/components/MobileSheet.svelte";
  import ParentSelect, { type ParentTask } from "$lib/components/tasks/ParentSelect.svelte";

  let {
    open = $bindable(false),
    value = null,
    options = [],
    onChange,
    onSearch,
    onclose,
    title = "Parent",
  }: {
    open?: boolean;
    value?: string | null;
    options?: ParentTask[];
    onChange: (next: string | null) => void;
    onSearch?: (query: string) => void;
    onclose?: () => void;
    title?: string;
  } = $props();

  function pick(next: string | null): void {
    onChange(next);
    open = false;
    onclose?.();
  }
</script>

<MobileSheet bind:open {title} {onclose} ariaLabel="Select parent work item">
  <div class="pb-2">
    <ParentSelect {value} {options} variant="inline" onChange={pick} {onSearch} class="w-full" />
  </div>
</MobileSheet>
