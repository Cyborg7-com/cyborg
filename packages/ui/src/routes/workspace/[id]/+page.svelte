<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import HomePane from "$lib/components/panes/HomePane.svelte";
  import { workspaceState, getLastChannel } from "$lib/state/app.svelte.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";

  const wsId = $derived(page.params.id ?? "");

  // Restore last-viewed channel on reload (v1 "activitySession", Sidebar.tsx:859).
  // Only fires once, when landing on the bare workspace root — deep links to
  // /channel, /dm, /agent, etc. never hit this page, so explicit navigation is
  // never overridden.
  //
  // MOBILE: Home was removed from the bottom nav (Projects · Inbox · Agents), so
  // the bare root lands on the Projects tab (/chats), not the deleted dashboard
  // and not straight into a channel. The restore-to-last-channel effect below is
  // desktop-only; on mobile we canonicalise to /chats so the bottom nav highlights
  // correctly.
  let restoreAttempted = false;
  $effect(() => {
    if (restoreAttempted) return;
    if (!wsId || workspaceState.current?.id !== wsId) return;

    restoreAttempted = true;

    // Mobile: Home was removed from the bottom nav, so land on Chats — the
    // first tab — instead, and skip the desktop restore-to-channel logic.
    if (viewportState.isMobile) {
      void goto(`/workspace/${wsId}/chats`, { replaceState: true });
      return;
    }

    // Desktop: wait until channels have loaded before deciding — restoring only
    // makes sense once the channel list is known (a 0-channel workspace correctly
    // falls through to the home dashboard).
    const channels = workspaceState.channels;
    if (channels.length === 0) {
      // Not done yet — reset so the effect re-runs once channels arrive.
      restoreAttempted = false;
      return;
    }
    const lastId = getLastChannel(wsId);
    if (lastId && channels.some((c) => c.id === lastId)) {
      void goto(`/workspace/${wsId}/channel/${lastId}`, { replaceState: true });
    }
  });
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <HomePane workspaceId={wsId} />
</div>
