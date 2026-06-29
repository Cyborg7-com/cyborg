<script lang="ts">
  import { page } from "$app/state";
  import AuditPane from "$lib/components/panes/AuditPane.svelte";

  const wsId = $derived(page.params.id ?? "");
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <AuditPane workspaceId={wsId} />
</div>
