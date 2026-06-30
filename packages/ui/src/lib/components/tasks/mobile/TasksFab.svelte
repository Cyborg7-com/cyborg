<script lang="ts">
  // The one context-aware Tasks FAB (WS0 foundation, frozen). A thin wrapper over
  // the shared FAB primitive: the host passes the per-screen action (`onclick`)
  // and suppresses it (`hidden`) while a sheet is open, the soft keyboard is up,
  // or a board drag is active. Defaults to opening the create-task sheet so the
  // FAB always does something useful even before a host wires a contextual action.
  import FAB from "$lib/components/ui/FAB.svelte";
  import { openCreateTask } from "$lib/tasks/openCreate.svelte.js";

  let {
    onclick,
    ariaLabel = "New work item",
    hidden = false,
  }: {
    onclick?: () => void;
    ariaLabel?: string;
    hidden?: boolean;
  } = $props();

  function handle(): void {
    if (onclick) onclick();
    else openCreateTask({});
  }
</script>

<FAB onclick={handle} {ariaLabel} {hidden} />
