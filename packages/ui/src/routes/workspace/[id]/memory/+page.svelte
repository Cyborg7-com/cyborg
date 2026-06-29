<script lang="ts">
  import { page } from "$app/state";
  import MemoryPane from "$lib/components/panes/MemoryPane.svelte";

  const wsId = $derived(page.params.id ?? "");
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <MemoryPane workspaceId={wsId} />
</div>
