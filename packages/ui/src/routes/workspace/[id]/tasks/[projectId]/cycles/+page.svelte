<script lang="ts">
  // Project Cycles route — thin wrapper around the CyclesView component (a
  // master/detail: cycle list on the left, the selected cycle's work-items board
  // — data-driven from the project's states — on the right).
  import { page } from "$app/state";
  import CyclesView from "$lib/components/tasks/CyclesView.svelte";

  const wsId = $derived(page.params.id ?? "");
  const projectId = $derived(page.params.projectId ?? "");
</script>

<CyclesView {wsId} {projectId} />
