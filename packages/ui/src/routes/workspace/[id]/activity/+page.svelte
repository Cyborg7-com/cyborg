<script lang="ts">
  import { page } from "$app/state";
  import ActivityPane from "$lib/components/panes/ActivityPane.svelte";

  const wsId = $derived(page.params.id ?? "");
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <ActivityPane workspaceId={wsId} />
</div>
