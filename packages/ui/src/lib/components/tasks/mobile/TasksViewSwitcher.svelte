<script lang="ts">
  // Work-Items layout switcher (WS0 foundation, frozen). Built on the shared
  // SegmentedControl primitive. Segments: List · Board · Calendar · Gantt.
  // Spreadsheet is intentionally omitted on mobile (LOCKED DECISION — redundant
  // with List on a phone). Calendar renders as an agenda, Gantt as a read-only
  // timeline; both stay here so the view count is honest. `bind:layout` to the
  // work-items page's local layout $state.
  import SegmentedControl from "$lib/components/ui/SegmentedControl.svelte";
  import type { Layout } from "$lib/tasks/view.js";

  let {
    layout = $bindable<Layout>("list"),
    onChange,
    class: className = undefined,
  }: {
    layout?: Layout;
    onChange?: (layout: Layout) => void;
    class?: string;
  } = $props();

  const OPTIONS: { value: Layout; label: string }[] = [
    { value: "list", label: "List" },
    { value: "board", label: "Board" },
    { value: "calendar", label: "Calendar" },
    { value: "gantt", label: "Gantt" },
  ];

  function handle(next: string): void {
    const l = next as Layout;
    layout = l;
    onChange?.(l);
  }
</script>

<SegmentedControl
  options={OPTIONS}
  value={layout}
  onChange={handle}
  ariaLabel="Work item layout"
  class={className}
/>
