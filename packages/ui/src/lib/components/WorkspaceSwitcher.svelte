<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import {
    workspaceState,
    notificationState,
  } from "$lib/state/app.svelte.js";
  import { shellConfig } from "$lib/core/plugin.svelte.js";
  import { getInitials, nameToColor } from "$lib/utils.js";
  import { visibleChannels } from "$lib/channel-visibility.js";
  import { Avatar, AvatarImage, AvatarFallback } from "$lib/components/ui/avatar/index.js";
  import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
  } from "$lib/components/ui/dropdown-menu/index.js";
  import RailButton from "$lib/components/RailButton.svelte";
  import FeedbackWidget from "$lib/components/FeedbackWidget.svelte";
  import ProfileMenu from "$lib/components/ProfileMenu.svelte";

  const workspaces = $derived(workspaceState.list);
  const currentId = $derived(workspaceState.current?.id);
  const wsId = $derived(workspaceState.current?.id ?? page.params.id);
  const pathname = $derived(page.url.pathname);

  const currentWs = $derived(workspaceState.current);
  const otherWorkspaces = $derived(workspaces.filter((w) => w.id !== currentId));
  // Total unread across all OTHER workspaces — shown on the collapsed switcher
  // trigger so you know another workspace has activity without opening it.
  const otherWorkspacesUnread = $derived(
    otherWorkspaces.reduce((sum, w) => sum + notificationState.getWorkspaceTotal(w.id), 0),
  );

  const navItems = $derived(shellConfig.navItems);
  const bottomItems = $derived(shellConfig.bottomItems);

  let feedbackOpen = $state(false);

  function switchWorkspace(ws: typeof workspaces[0]) {
    // ONLY navigate — do NOT selectWorkspace here. We're inside the [id] layout,
    // whose $effect reverts the switch if workspaceState.current changes before the
    // URL does (it sees current=new but url=old → restoreSession(old)). Changing
    // the route first lets that same effect drive selectWorkspace(new) cleanly.
    goto(`/workspace/${ws.id}`);
  }

  function isItemActive(item: typeof navItems[0]): boolean {
    if (item.id === "feedback") return feedbackOpen;
    if (item.id === "home")
      return pathname === `/workspace/${wsId}` || pathname === `/workspace/${wsId}/home`;
    const paths = item.pathMatch ?? [item.path];
    return paths.some((p) => pathname.startsWith(`/workspace/${wsId}${p}`));
  }

  function handleItemClick(item: typeof navItems[0]) {
    if (!wsId) return;
    if (item.id === "feedback") {
      feedbackOpen = !feedbackOpen;
      return;
    }
    if (item.id === "chat") {
      // #608: land on the first real (non-group-DM) channel, never a hidden
      // group_dm channel.
      const first = visibleChannels(workspaceState.channels)[0];
      if (first) {
        goto(`/workspace/${wsId}/channel/${first.id}`);
        return;
      }
    }
    goto(`/workspace/${wsId}${item.path}`);
  }
</script>

<div class="relative flex h-full w-[4.375rem] flex-col items-center pt-2 select-none min-h-0">
  <!-- Workspace avatar + dropdown. shadcn DropdownMenu: portaled, solid bg-popover
       background + theme tokens — the previous hand-rolled absolute div painted its
       background via inline var(--dropdown-*) styles and could render transparent. -->
  <DropdownMenu>
    <DropdownMenuTrigger class="relative shrink-0 w-9 h-9 mb-[5px] cursor-pointer">
      {#if currentWs}
        <Avatar class="size-9 rounded-lg after:rounded-lg">
          {#if currentWs.avatarUrl}
            <AvatarImage src={currentWs.avatarUrl} alt={currentWs.name} class="rounded-lg object-cover" />
          {/if}
          <AvatarFallback
            class="rounded-lg text-sm font-bold text-accent-foreground"
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
    </DropdownMenuTrigger>

    <DropdownMenuContent align="start" sideOffset={6} class="w-[300px] p-0 py-1 rounded-xl overflow-hidden">
      <!-- Current workspace -->
      {#if currentWs}
        <div class="w-full px-4 py-2.5 text-sm leading-7 bg-dropdown-selected">
          <div class="leading-[22px] font-bold truncate text-content">
            {currentWs.name}
          </div>
          <div class="text-[12px] leading-[18px] text-content-muted">
            {workspaceState.members.length} member{workspaceState.members.length !== 1 ? "s" : ""} · {workspaceState.agents.length} agent{workspaceState.agents.length !== 1 ? "s" : ""}
          </div>
        </div>
      {/if}

      <!-- Other workspaces -->
      {#if otherWorkspaces.length > 0}
        <DropdownMenuSeparator />
        <div class="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-content-muted">
          Switch workspace
        </div>
        {#each otherWorkspaces as ws (ws.id)}
          <DropdownMenuItem
            class="px-4 w-full h-[48px] gap-3 text-[14px] rounded-none cursor-pointer"
            onclick={() => switchWorkspace(ws)}
          >
            <Avatar class="size-8 rounded-lg after:rounded-lg">
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
            <div class="flex flex-col text-left flex-1 min-w-0">
              <div class="leading-[20px] font-bold truncate text-content">
                {ws.name}
              </div>
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
          </DropdownMenuItem>
        {/each}
      {/if}

      <!-- Add workspace -->
      <DropdownMenuSeparator />
      <DropdownMenuItem
        class="px-4 w-full h-[44px] gap-3 text-[14px] rounded-none cursor-pointer"
        onclick={() => goto("/workspace?new=1")}
      >
        <div class="w-8 h-8 flex items-center justify-center rounded-lg bg-raised">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </div>
        <span class="font-medium text-content-muted">Add a workspace</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>

  <!-- Nav items — scrollable middle zone, driven by shellConfig -->
  <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col items-center py-2 w-full" style="scrollbar-width: none;">
    <div class="relative flex flex-col items-center w-[3.25rem]">
      {#each navItems as item (item.id)}
        <RailButton
          label={item.label}
          icon={item.activeIcon && isItemActive(item) ? item.activeIcon : item.icon}
          active={isItemActive(item)}
          badge={item.badge ?? 0}
          onclick={() => handleItemClick(item)}
        />
      {/each}
    </div>
  </div>

  <!-- Bottom items — pinned -->
  <div class="shrink-0 flex flex-col items-center gap-3 pb-4 w-full">
    {#each bottomItems as item (item.id)}
      <RailButton
        label={item.label}
        icon={item.activeIcon && isItemActive(item) ? item.activeIcon : item.icon}
        active={isItemActive(item)}
        badge={item.badge ?? 0}
        onclick={() => handleItemClick(item)}
      />
    {/each}
    <ProfileMenu />
  </div>

  <FeedbackWidget open={feedbackOpen} onclose={() => (feedbackOpen = false)} />
</div>
