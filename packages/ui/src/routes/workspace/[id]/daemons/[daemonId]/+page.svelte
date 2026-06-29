<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { daemonState, agentsPaneState } from "$lib/state/app.svelte.js";

  // Deep-link compatibility: the primary daemon-detail surface is the Daemon
  // sub-tab inside the Agents pane (which keeps the All agents / Templates
  // tabs reachable). This route just selects the daemon and forwards there,
  // so old /daemons/[daemonId] links never strand the user on a dead-end.
  $effect(() => {
    const wsId = page.params.id as string;
    const daemonId = page.params.daemonId as string;
    if (!wsId || !daemonId) return;
    daemonState.selectedId = daemonId;
    agentsPaneState.subTab = "daemon";
    void goto(`/workspace/${wsId}/agents`, { replaceState: true });
  });
</script>

<div class="flex h-full items-center justify-center text-sm text-content-muted">
  Opening daemon…
</div>
