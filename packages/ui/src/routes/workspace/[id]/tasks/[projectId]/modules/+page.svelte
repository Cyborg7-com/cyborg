<script lang="ts">
  // Project Modules route — thin wrapper around the ModulesView component (a
  // master/detail: module list on the left, the selected module's work-items board
  // — data-driven from the project's states — on the right).
  import { page } from "$app/state";
  import ModulesView from "$lib/components/tasks/ModulesView.svelte";

  const wsId = $derived(page.params.id ?? "");
  const projectId = $derived(page.params.projectId ?? "");
</script>

<ModulesView {wsId} {projectId} />
