<script lang="ts">
  // FROZEN picker sheet (WS0). Bottom-sheet wrapper around the shared
  // DateRangeDropdown leaf (variant="row"). Edits start + due together; the sheet
  // stays open so both halves can be set, then the host dismisses it. `onChange`
  // echoes the full { startDate, dueAt } ISO pair (the model converts to epoch-ms
  // at the saver boundary, exactly like TaskDetailCard).
  import MobileSheet from "$lib/components/MobileSheet.svelte";
  import DateRangeDropdown, { type DateRange } from "$lib/components/tasks/DateRangeDropdown.svelte";

  let {
    open = $bindable(false),
    value = { startDate: null, dueAt: null },
    onChange,
    onclose,
    title = "Dates",
  }: {
    open?: boolean;
    value?: DateRange;
    onChange: (next: DateRange) => void;
    onclose?: () => void;
    title?: string;
  } = $props();
</script>

<MobileSheet bind:open {title} {onclose} ariaLabel="Set dates">
  <div class="pb-2">
    <DateRangeDropdown {value} variant="row" {onChange} class="w-full" />
  </div>
</MobileSheet>
