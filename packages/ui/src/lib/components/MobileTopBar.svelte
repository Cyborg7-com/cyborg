<script lang="ts">
  import { goto } from "$app/navigation";
  import MobileSearchOverlay from "$lib/components/MobileSearchOverlay.svelte";
  import ProfileMenu from "$lib/components/ProfileMenu.svelte";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import {
    workspaceState,
    notificationState,
  } from "$lib/state/app.svelte.js";
  import { getInitials, nameToColor } from "$lib/utils.js";
  import { Avatar, AvatarImage, AvatarFallback } from "$lib/components/ui/avatar/index.js";
  import MobileSheet from "$lib/components/MobileSheet.svelte";

  // Mobile-only top bar: hamburger (when a sidebar applies) · workspace logo +
  // switcher · message search · profile. Search collapses to an icon and expands
  // full-width over the bar; `searchOpen` is owned by the layout (it resets on
  // route change) and bound here.
  let {
    searchOpen = $bindable(false),
    showSidebar,
    showChannelSidebar,
    wsName,
  }: {
    searchOpen?: boolean;
    showSidebar: boolean;
    showChannelSidebar: boolean;
    wsName: string;
  } = $props();

  // The left logo owns workspace switching on mobile (the desktop rail is hidden
  // here). Mirrors WorkspaceSwitcher.svelte verbatim: the current ws, the OTHER
  // workspaces, and the cross-workspace unread aggregate shown on the logo badge.
  const currentWs = $derived(workspaceState.current);
  const otherWorkspaces = $derived(
    workspaceState.list.filter((w) => w.id !== currentWs?.id),
  );
  // Total unread across all OTHER workspaces — shown on the collapsed switcher
  // trigger so you know another workspace has activity without opening it. The
  // active workspace is excluded (its own unread shows on its channel/DM rows).
  const otherWorkspacesUnread = $derived(
    otherWorkspaces.reduce((sum, w) => sum + notificationState.getWorkspaceTotal(w.id), 0),
  );

  // The workspace picker is an iOS bottom sheet on mobile (replaces the web
  // dropdown). Open state owned locally; closed on switch / add.
  let switcherOpen = $state(false);

  function switchWorkspace(ws: { id: string }) {
    switcherOpen = false;
    // Clear the target's badge optimistically so it disappears the moment you tap
    // in; seedCounts re-syncs from server truth on workspace load.
    notificationState.clearWorkspace(ws.id);
    // ONLY navigate — do NOT selectWorkspace here. We're inside the [id] layout,
    // whose $effect reverts the switch if workspaceState.current changes before the
    // URL does (it sees current=new but url=old → restoreSession(old)). Changing
    // the route first lets that same effect drive selectWorkspace(new) cleanly.
    //
    // Land on the Projects tab (/chats), not the bare workspace root. Home was
    // removed from the mobile tab bar, so switching a workspace lands on the first
    // real tab. Routing directly here (vs the bare root) is explicit and avoids a
    // double-hop; /chats carries the same `[id]` param, so the layout effect drives
    // selectWorkspace(new) cleanly.
    goto(`/workspace/${ws.id}/chats`);
  }
</script>

<!-- The Android WebView (wry) already insets its content below the status bar,
     and env(safe-area-inset-top) ALSO reports that inset — so adding var(--sat)
     here double-counts it and leaves a tall empty band between the status bar and
     the bar. Use a plain height; the WebView's own top inset keeps the content
     clear of the status bar.

     P2 redesign: iOS material chrome — .material-bar (translucent blur, opaque
     fallback where backdrop-filter is unsupported) + .hairline-b replace the
     opaque bg/border. The bar deliberately STAYS in normal flow (content does
     not scroll under it): overlaying it on the scroll container would have to
     re-touch the --app-vh / keyboard machinery (Caveats #8/#20) and the
     swipe-back peek geometry, which all assume <main> starts below the bar —
     not worth the risk this wave (safe version per spec). -->
<div
  class="mobile-top-bar material-bar hairline-b z-40 flex shrink-0 items-center gap-1 px-2"
  style="height: 2.75rem;"
>
  <!-- Full-screen search overlay — only on mobile (isMobile gate), rendered as
       a fixed overlay above the entire shell so it doesn't disturb the flex
       column layout or the app-vh / keyboard machinery. Activated by the search
       icon in the bar below; dismissed via Cancel or route change (searchOpen
       reset in the layout's $effect). -->
  {#if searchOpen}
    <MobileSearchOverlay onclose={() => (searchOpen = false)} />
  {/if}

  <!-- The ☰ drawer toggle only applies to the daemon/agents sidebar — chat/DM
         navigation lives in the Chats bottom tab now (+ swipe-back), so we don't
         show a hamburger next to the logo on chat routes (W2 redesign). -->
    {#if showSidebar && !showChannelSidebar}
      <button
        type="button"
        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-content-muted active:bg-raised touch-target"
        aria-label="Open sidebar"
        onclick={() => viewportState.openDrawer()}
      >
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
    {/if}
    <!-- Workspace logo + name + chevron — tap to open the workspace picker. The
         logo carries a cross-workspace unread COUNT badge (other workspaces only).
         Reuses the desktop WorkspaceSwitcher.svelte trigger/badge/picker markup. -->
    <!-- Workspace picker trigger — taps open an iOS bottom sheet (mobile). -->
    <button
      type="button"
      onclick={() => (switcherOpen = true)}
      class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 cursor-pointer active:bg-raised touch-target-row"
      aria-label="Switch workspace"
      aria-haspopup="dialog"
      aria-expanded={switcherOpen}
    >
      <span class="relative shrink-0">
        {#if currentWs}
          <Avatar class="size-7 rounded-lg after:rounded-lg">
            {#if currentWs.avatarUrl}
              <AvatarImage src={currentWs.avatarUrl} alt={currentWs.name} class="rounded-lg object-cover" />
            {/if}
            <AvatarFallback
              class="rounded-lg text-[11px] font-bold text-accent-foreground"
              style="background-color: {nameToColor(currentWs.name)};"
            >
              {getInitials(currentWs.name)}
            </AvatarFallback>
          </Avatar>
        {/if}

        {#if otherWorkspacesUnread > 0}
          <!-- Unread in OTHER workspaces — visible on the collapsed switcher. -->
          <span
            class="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-accent-foreground"
          >
            {otherWorkspacesUnread > 99 ? "99+" : otherWorkspacesUnread}
          </span>
        {/if}
      </span>
      <span class="min-w-0 truncate text-[15px] font-bold text-content">{currentWs?.name ?? wsName}</span>
      <svg class="shrink-0 text-content-dim" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>

    {#if switcherOpen}
      <MobileSheet open={switcherOpen} ariaLabel="Switch workspace" onclose={() => (switcherOpen = false)}>
        <!-- Current workspace -->
        {#if currentWs}
          <div class="mb-3 flex items-center gap-3 rounded-[12px] bg-dropdown-selected px-4 py-3">
            <Avatar class="size-9 shrink-0 rounded-lg after:rounded-lg">
              {#if currentWs.avatarUrl}
                <AvatarImage src={currentWs.avatarUrl} alt={currentWs.name} class="rounded-lg object-cover" />
              {/if}
              <AvatarFallback
                class="rounded-lg text-[13px] font-bold text-accent-foreground"
                style="background-color: {nameToColor(currentWs.name)};"
              >
                {getInitials(currentWs.name)}
              </AvatarFallback>
            </Avatar>
            <div class="min-w-0">
              <div class="truncate text-[16px] font-bold text-content">{currentWs.name}</div>
              <div class="text-[13px] text-content-muted">
                {workspaceState.members.length} member{workspaceState.members.length !== 1 ? "s" : ""} · {workspaceState.agents.length} agent{workspaceState.agents.length !== 1 ? "s" : ""}
              </div>
            </div>
          </div>
        {/if}

        <!-- Other workspaces -->
        {#if otherWorkspaces.length > 0}
          <div class="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-content-muted">
            Switch workspace
          </div>
          <div class="mb-3 overflow-hidden rounded-[12px] bg-surface-alt">
            {#each otherWorkspaces as ws, i (ws.id)}
              {#if i > 0}
                <div class="mx-4 h-px" style="background-color: var(--hairline);"></div>
              {/if}
              <button
                type="button"
                class="flex min-h-[48px] w-full items-center gap-3 px-4 text-left active:bg-raised"
                onclick={() => switchWorkspace(ws)}
              >
                <Avatar class="size-8 shrink-0 rounded-lg after:rounded-lg">
                  {#if ws.avatarUrl}
                    <AvatarImage src={ws.avatarUrl} alt={ws.name} class="rounded-lg object-cover" />
                  {/if}
                  <AvatarFallback
                    class="rounded-lg text-xs font-bold text-accent-foreground"
                    style="background-color: {nameToColor(ws.name)};"
                  >
                    {getInitials(ws.name)}
                  </AvatarFallback>
                </Avatar>
                <div class="flex min-w-0 flex-1 flex-col text-left">
                  <div class="truncate text-[16px] font-bold text-content">{ws.name}</div>
                </div>
                {#if notificationState.getWorkspaceTotal(ws.id) > 0}
                  <span
                    class="ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold leading-none text-accent-foreground"
                  >
                    {notificationState.getWorkspaceTotal(ws.id) > 99
                      ? "99+"
                      : notificationState.getWorkspaceTotal(ws.id)}
                  </span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}

        <!-- Add workspace -->
        <div class="overflow-hidden rounded-[12px] bg-surface-alt">
          <button
            type="button"
            class="flex min-h-[48px] w-full items-center gap-3 px-4 text-left active:bg-raised"
            onclick={() => { switcherOpen = false; goto("/workspace?new=1"); }}
          >
            <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-raised">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </div>
            <span class="text-[16px] font-medium text-content-muted">Add a workspace</span>
          </button>
        </div>
      </MobileSheet>
    {/if}
    <!-- Message search icon removed from the mobile top bar. -->
    <div class="shrink-0">
      <ProfileMenu />
    </div>
</div>
