<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import HomePane from "$lib/components/panes/HomePane.svelte";

  const wsId = $derived(page.params.id ?? "");

  // Home is desktop-only now — it was removed from the mobile tab bar (Projects ·
  // Inbox · Agents). Any mobile entry that still resolves to /home (a saved last
  // route on cold launch, a workspace switch, a deep link) bounces to the
  // Projects tab. Gating HomePane behind !isMobile means the deleted dashboard
  // never paints before the redirect (no flash).
  $effect(() => {
    if (viewportState.isMobile && wsId) {
      void goto(`/workspace/${wsId}/chats`, { replaceState: true });
    }
  });
</script>

{#if !viewportState.isMobile}
  <div class="flex min-h-0 flex-1 flex-col">
    <HomePane workspaceId={wsId} />
  </div>
{/if}
