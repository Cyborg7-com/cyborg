<script lang="ts">
  import { page } from "$app/state";
  import LogsPane from "$lib/components/panes/LogsPane.svelte";

  const wsId = $derived(page.params.id ?? "");
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <LogsPane workspaceId={wsId} />
</div>
