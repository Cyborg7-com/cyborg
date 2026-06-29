<script lang="ts">
  // Project Page editor route — the rich-text editor for a single page.
  import { page } from "$app/state";
  import PageEditor from "$lib/components/tasks/PageEditor.svelte";

  const wsId = $derived(page.params.id ?? "");
  const projectId = $derived(page.params.projectId ?? "");
  const pageId = $derived(page.params.pageId ?? "");
</script>

{#key pageId}
  <PageEditor {wsId} {projectId} {pageId} />
{/key}
