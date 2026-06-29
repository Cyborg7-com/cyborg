<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { workspaceState } from "$lib/state/app.svelte.js";

  const wsId = $derived(page.params.id ?? "");

  $effect(() => {
    const first = workspaceState.channels[0];
    if (first && wsId) {
      goto(`/workspace/${wsId}/channel/${first.id}`, { replaceState: true });
    }
  });
</script>

<div class="flex h-full items-center justify-center">
  <p class="text-sm text-content-muted">Select a channel to start chatting</p>
</div>
