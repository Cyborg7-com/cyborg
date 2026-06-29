<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { agentsPaneState } from "$lib/state/app.svelte.js";

  // Deep-link compatibility: daemon management lives in the Agents pane's
  // Daemon sub-tab now. Forward there (the pane resolves the effective daemon).
  $effect(() => {
    const wsId = page.params.id as string;
    if (!wsId) return;
    agentsPaneState.subTab = "daemon";
    void goto(`/workspace/${wsId}/agents`, { replaceState: true });
  });
</script>

<div class="flex h-full items-center justify-center text-sm text-content-muted">
  Opening daemons…
</div>
