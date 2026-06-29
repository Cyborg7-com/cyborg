<script lang="ts">
  // Project Pages route — the Pages index (list + tabs + search/sort). The page
  // editor lives one level deeper at pages/[pageId].
  import { page } from "$app/state";
  import PagesList from "$lib/components/tasks/PagesList.svelte";

  const wsId = $derived(page.params.id ?? "");
  const projectId = $derived(page.params.projectId ?? "");
</script>

<PagesList {wsId} {projectId} />
