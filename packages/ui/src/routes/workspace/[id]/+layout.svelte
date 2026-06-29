<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { isTauriIOS } from "$lib/mobile/push";
  import WorkspaceSwitcher from "$lib/components/WorkspaceSwitcher.svelte";
  import ChannelSidebar from "$lib/components/channel/ChannelSidebar.svelte";
  import DaemonSidebar from "$lib/components/daemon/DaemonSidebar.svelte";
  import TerminalPaneHost from "$lib/components/agent/TerminalPaneHost.svelte";
  import MessageSearch from "$lib/components/channel/MessageSearch.svelte";
  import TrialBar from "$lib/components/trial/TrialBar.svelte";
  import UpdateBanner from "$lib/components/UpdateBanner.svelte";
  import MobileNav from "$lib/components/MobileNav.svelte";
  import MobileTopBar from "$lib/components/MobileTopBar.svelte";
  import QuickSwitcher from "$lib/components/QuickSwitcher.svelte";
  import KeyboardShortcutsModal from "$lib/components/keyboard/KeyboardShortcutsModal.svelte";
  import PanelLeftOpenIcon from "@lucide/svelte/icons/panel-left-open";
  import { RAIL_ICONS } from "$lib/core/plugin.svelte.js";
  import { activityState } from "$lib/state/app.svelte.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import {
    isDrawerDismissKey,
    isEditableTarget,
    shouldCloseDrawerOnSwipe,
  } from "$lib/state/drawer-dismiss.js";
  import { subscribe as subscribeKeyboard } from "$lib/mobile/keyboard-state";
  import { installPushTransition } from "$lib/mobile/pushTransition";
  import { setNativeVisibility } from "$lib/mobile/nativeComposer";
  import {
    authState,
    workspaceState,
    connectToServer,
    getSavedSession,
    clearSavedSession,
    selectWorkspace,
    connectionState,
    handleBillingReturn,
    AuthError,
  } from "$lib/state/app.svelte.js";

  let { children } = $props();

  // Hide the bottom tab bar while the keyboard is open (iOS). With the layout
  // shrunk to the keyboard-reduced --app-vh, a visible nav would sit between the
  // messages and the keyboard AND collide with the native composer pill (which
  // rides to the keyboard top) — so collapse it, matching V1 + Slack/Mattermost.
  // keyboard-state is driven by Swift's __cgKeyboardWillShow/Hide hooks.
  let keyboardOpen = $state(false);
  onMount(() => subscribeKeyboard((open) => (keyboardOpen = open)));

  // iOS push/pop navigation transition (P2): UINavigationController-style
  // slide for list→detail (push) and back-button (pop) navs inside the mobile
  // workspace shell. Companion to installSwipeBack() (root +layout) — it
  // plugs into the same pushState capture wrap + snapshot machinery and is
  // suppressed for navs the swipe gesture already animated. Installed here
  // (not the root layout) because it only ever applies inside the workspace
  // shell; iOS-shell-gated, no-op everywhere else.
  onMount(() => {
    if (!isTauriIOS()) return;
    return installPushTransition();
  });

  // Post-Stripe-Checkout return: ?billing=success re-fetches the license + toasts;
  // ?billing=canceled closes the modal. Clean the param so a refresh doesn't
  // re-trigger it. Runs once per param value (guarded by lastBillingParam).
  let lastBillingParam: string | null = null;
  $effect(() => {
    const billing = page.url.searchParams.get("billing");
    if (!billing || billing === lastBillingParam) return;
    lastBillingParam = billing;
    void handleBillingReturn(billing);
    const url = new URL(page.url);
    url.searchParams.delete("billing");
    void goto(`${url.pathname}${url.search}${url.hash}`, { replaceState: true, noScroll: true });
  });

  const pathname = $derived(page.url.pathname);
  const wsId = $derived(page.params.id);

  // On mobile a terminal session takes over the full screen — hide the bottom
  // tab bar (MobileNav) so the terminal isn't cramped/cluttered by it. The
  // mobile shell is a flex column and MobileNav carries its own height + safe-
  // area padding (--sab), so removing it from flow lets <main> reclaim the space
  // with no leftover gap. The terminal route page (owned separately) provides
  // back-button + swipe-back to leave. Desktop and non-terminal routes unchanged.
  const isTerminalRoute = $derived(pathname.includes("/terminal/"));

  // ── Caveat #7: JS defensive deactivation of the native composer pill ──
  // The native UIKit pill is a window-anchored overlay above the WebView; its
  // visibility is normally a pure function of the WebView URL (Swift URL-KVO,
  // which shows it on TERMINAL chat routes and hides it on everything else).
  // But Caveat #12 records that the KVO is unreliable for SOME `pushState`
  // transitions — when it misses one, a pill shown on a chat route lingers onto
  // the next page (the channel-details info page, settings screens, lists). So
  // this watcher is the belt-and-suspenders layer: on EVERY non-chat route it
  // hides the pill via the light `composer_set_visible` toggle (isHidden only —
  // it does NOT touch the ownership stack, activationSeq, theme, or constraints,
  // so thread LIFO + swipe-back hide/restore semantics are untouched). It never
  // FORCES the pill back on a chat route — showing is owned by the KVO + the
  // MessageInput register/activate handshake + thread LIFO + swipe-back restore,
  // and force-showing here would fight an open thread overlay or an in-progress
  // swipe-back. A terminal-segment match (id is the LAST segment) mirrors Swift's
  // `isChatPath`, so `/channel/<id>/details` and `/settings/**` correctly read as
  // non-chat. `agent` is EXCLUDED here just as it is in Swift's `isChatPath`:
  // agent chat routes use the WEB AgentComposer (not the native pill, which only
  // the channel/dm MessageInput registers), so they must read as non-chat and
  // this watcher must actively HIDE the pill on them — otherwise a missed KVO
  // would leave the native pill stacked under the web "Message agent…" composer
  // (the double-composer bug). iOS-gated; no-op on web / desktop / Android.
  $effect(() => {
    const path = pathname;
    if (!isTauriIOS()) return;
    const comps = path.split("/").filter(Boolean);
    // /workspace/<ws>/<kind>/<id> with <id> as the terminal segment.
    const isChatRoute =
      comps.length === 4 &&
      comps[0] === "workspace" &&
      (comps[2] === "channel" || comps[2] === "dm");
    if (!isChatRoute) void setNativeVisibility(false);
  });
  const showChannelSidebar = $derived(
    (pathname.startsWith(`/workspace/${wsId}/channel`) ||
    pathname.startsWith(`/workspace/${wsId}/agent`) ||
    // Terminal sessions (#656) live alongside agent sessions — keep the chat
    // sidebar visible so the user can navigate away and back (was full-screen,
    // which stranded the user with no way out of the terminal view).
    pathname.startsWith(`/workspace/${wsId}/terminal`) ||
    // `/dm/` (trailing slash) so the DMs-tab list route `/dms` doesn't collide
    // with the DM-conversation route `/workspace/<ws>/dm/<id>`.
    pathname.startsWith(`/workspace/${wsId}/dm/`)) &&
    !pathname.startsWith(`/workspace/${wsId}/agents`) &&
    pathname !== `/workspace/${wsId}/agent/new`,
  );
  // Daemon management lives under Agents: the global daemon selector renders to
  // the left of the Agents pane and on the daemons/[daemonId] detail route.
  const showDaemonSidebar = $derived(
    pathname.startsWith(`/workspace/${wsId}/daemons`) ||
    pathname.startsWith(`/workspace/${wsId}/agents`),
  );
  const showSidebar = $derived(showChannelSidebar || showDaemonSidebar);
  // Tasks routes own their own top bar (TasksTopNav) and have no message search,
  // so the global search top bar is hidden there.
  const isTasks = $derived(pathname.startsWith(`/workspace/${wsId}/tasks`));

  // Activity moved off the left rail into a minimalist top-bar bell button.
  // Same destination (/workspace/<id>/activity = ActivityPane) and same unread
  // source (activityState.unreadCount) the rail item used.
  const activityUnread = $derived(activityState.unreadCount);
  const activityActive = $derived(
    pathname.startsWith(`/workspace/${wsId}/activity`),
  );

  // On mobile the sidebar is a slide-in drawer; close it whenever the route
  // changes (e.g. the user tapped a channel inside the drawer). Re-selecting the
  // ACTIVE item is a same-URL no-op (no route change), so the sidebars ALSO call
  // closeDrawer() directly — this effect covers distinct-route navigations.
  $effect(() => {
    pathname;
    viewportState.closeDrawer();
    searchOpen = false;
  });

  // a11y: Escape closes the open drawer (an open overlay must be dismissable by
  // keyboard). Guarded so it only acts when the drawer is actually open.
  function handleWindowKeydown(e: KeyboardEvent): void {
    // Mod+Shift+\ toggles the desktop workspace sidebar (Cmd on mac / Ctrl
    // elsewhere). Shift is required so Ctrl+\ stays free — it's SIGQUIT in a
    // terminal, which this feature is meant to coexist with. Desktop-only.
    if (
      (e.metaKey || e.ctrlKey) &&
      e.shiftKey &&
      e.key === "\\" &&
      !viewportState.isMobile
    ) {
      e.preventDefault();
      viewportState.toggleSidebar();
      return;
    }
    if (!viewportState.drawerOpen || !isDrawerDismissKey(e.key)) return;
    // Escape inside an editable field cancels/blurs THAT field — don't hijack it
    // to close the drawer (would unmount the inline alias / create-channel form
    // and lose the input). Let the field's own handler take it.
    if (isEditableTarget(e.target)) return;
    e.preventDefault();
    viewportState.closeDrawer();
  }

  // Swipe-left-to-close on the drawer panel (the panel sits at the left edge;
  // dragging it back toward the edge dismisses it). Tracked locally; a fast or
  // long enough leftward swipe closes. Vertical-dominant gestures are ignored
  // so list scrolling inside the drawer isn't hijacked.
  let drawerTouch: { x: number; y: number } | null = null;
  function onDrawerTouchStart(e: TouchEvent): void {
    const t = e.touches[0];
    drawerTouch = t ? { x: t.clientX, y: t.clientY } : null;
  }
  function onDrawerTouchEnd(e: TouchEvent): void {
    const start = drawerTouch;
    drawerTouch = null;
    const t = e.changedTouches[0];
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    // Leftward, horizontally-dominant, past a threshold → close.
    if (shouldCloseDrawerOnSwipe(dx, dy)) viewportState.closeDrawer();
  }

  // Current workspace drives the mobile top-bar title. The workspace switcher
  // itself now lives in the profile menu (ProfileMenu), keeping the bar lean.
  const currentWs = $derived(workspaceState.current);

  // Retry a failed workspace switch (workspaceState.switchError) for the target
  // currently in the URL.
  const switchTargetWs = $derived(workspaceState.list.find((w) => w.id === page.params.id));
  async function retrySwitch(): Promise<void> {
    if (!switchTargetWs) {
      goto("/workspace");
      return;
    }
    await selectWorkspace(switchTargetWs);
  }

  // Mobile search is collapsed to an icon; tapping it expands the full-width
  // search input over the bar.
  let searchOpen = $state(false);

  let restoring = $state(true);
  let restoreInProgress = false;
  // Counts consecutive transient connect failures while restoring, so the
  // "Reconnecting…" screen can offer a manual escape if the relay stays down.
  let restoreAttempts = $state(0);

  $effect(() => {
    const effectWsId = page.params.id as string;
    const isAuth = authState.authenticated;
    const currentId = workspaceState.current?.id;

    if (!effectWsId) {
      goto("/workspace");
      return;
    }

    if (isAuth && currentId === effectWsId) {
      restoring = false;
      return;
    }

    if (!restoreInProgress) {
      void restoreSession(effectWsId, isAuth);
    }
  });

  async function restoreSession(targetWsId: string, isAuth: boolean): Promise<void> {
    restoreInProgress = true;
    try {
      if (isAuth) {
        const ws = workspaceState.list.find((w) => w.id === targetWsId);
        if (ws) {
          await selectWorkspace(ws);
          restoring = false;
        } else {
          goto("/workspace");
        }
        return;
      }

      const saved = getSavedSession();
      if (!saved) {
        goto("/login");
        return;
      }

      // Retry transient relay outages (e.g. a deploy) instead of logging out.
      // Only a genuine auth failure clears the session and bounces to login —
      // a relay that's merely down/restarting keeps the user in place and
      // reconnects automatically once it's back.
      for (;;) {
        // Bail if the user navigated away mid-retry (e.g. clicked "Log in
        // again"). Otherwise a late-succeeding connect would yank them back to
        // this workspace and clobber their navigation.
        if (page.params.id !== targetWsId) return;
        try {
          await connectToServer(saved.url, saved.token);
          break;
        } catch (e) {
          if (e instanceof AuthError) {
            clearSavedSession();
            goto("/login");
            return;
          }
          restoreAttempts += 1;
          connectionState.status = "reconnecting";
          const delay = Math.min(1000 * 2 ** restoreAttempts, 15_000);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      if (page.params.id !== targetWsId) return;
      restoreAttempts = 0;
      const ws = workspaceState.list.find((w) => w.id === targetWsId);
      if (ws) {
        await selectWorkspace(ws);
        restoring = false;
      } else {
        goto("/workspace");
      }
    } catch (e) {
      // A non-connect failure during restore. Only treat a real auth error as a
      // reason to log out; anything else leaves the session intact.
      if (e instanceof AuthError) {
        clearSavedSession();
        goto("/login");
      }
    } finally {
      restoreInProgress = false;
    }
  }

  function goToLogin(): void {
    clearSavedSession();
    goto("/login");
  }

  // ── iOS deep-link drain (Caveat #3: persist-and-drain) ──
  // The live plugin `deep-link` event races on background-resume, so the native
  // layer ALSO persists every notification-tap URL to disk. On mount we drain
  // that pending URL (handles cold-launch + background-resume taps), and we
  // subscribe to the live `deep-link` event for foreground taps. We deliberately
  // do NOT drain on `visibilitychange` — v1 found that caused teleport bugs.
  // Everything is gated behind `isTauriIOS()` so web/desktop/Android are
  // unaffected, and the live listener is torn down on destroy.
  onMount(() => {
    if (!isTauriIOS()) return;
    let listener: { unregister: () => void } | undefined;
    let cancelled = false;

    void (async () => {
      const { invoke, addPluginListener } = await import("@tauri-apps/api/core");

      try {
        // Cold-launch + background-resume drain: the native plugin persists every
        // tapped URL to UserDefaults["cyborg7.pendingLaunchUrl"]; the plugin
        // command resolves it as { url }. (The legacy host `get_pending_deep_link`
        // read a file the new plugin never writes — that was the regression.)
        const pending = await invoke<{ url: string | null } | string | null>(
          "plugin:cyborg-push|get_pending_launch_url",
        );
        const url = typeof pending === "string" ? pending : pending?.url;
        if (!cancelled && url) goto(url);
      } catch (err) {
        console.warn("[deep-link] drain failed", err);
      }

      try {
        // Foreground taps arrive via the plugin `trigger("deep-link", …)`, which
        // Tauri delivers ONLY to addPluginListener('cyborg-push', …) — a global
        // listen() does NOT see plugin triggers (matches nativeComposer.ts).
        const un = await addPluginListener<{ url?: string } | string>(
          "cyborg-push",
          "deep-link",
          (payload) => {
            const u = typeof payload === "string" ? payload : payload?.url;
            if (u) goto(u);
          },
        );
        // If the component was destroyed before registration resolved, unsubscribe now.
        if (cancelled) un.unregister();
        else listener = un;
      } catch (err) {
        console.warn("[deep-link] listen failed", err);
      }
    })();

    return () => {
      cancelled = true;
      listener?.unregister();
    };
  });
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#if restoring}
  <div class="flex h-full flex-col items-center justify-center gap-4 bg-surface">
    <div class="flex items-center gap-3 text-sm text-content-muted">
      <div class="h-4 w-4 rounded-full border-2 border-content-muted border-t-transparent animate-spin"></div>
      <span>{connectionState.deploying ? "Updating… reconnecting" : "Reconnecting…"}</span>
    </div>
    {#if restoreAttempts >= 3}
      <div class="flex flex-col items-center gap-2 text-xs text-content-muted">
        <span>This is taking longer than usual.</span>
        <button type="button" class="text-link hover:underline" onclick={goToLogin}>Log in again</button>
      </div>
    {/if}
  </div>
{:else if workspaceState.switchError}
  <!-- Workspace switch failed — show the error + a retry instead of a dead view. -->
  <div class="flex h-full flex-col items-center justify-center gap-4 bg-surface px-6 text-center">
    <p class="max-w-sm text-sm text-content">{workspaceState.switchError}</p>
    <div class="flex items-center gap-3 text-xs">
      <button
        type="button"
        class="rounded-md bg-btn-primary-bg px-3 py-1.5 font-medium text-btn-primary-text hover:bg-btn-primary-hover"
        onclick={retrySwitch}
      >
        Try again
      </button>
      <button type="button" class="text-link hover:underline" onclick={() => goto("/workspace")}>
        All workspaces
      </button>
    </div>
  </div>
{:else if workspaceState.switching}
  <!-- Switching workspaces (rail click): clear indicator instead of a blank shell. -->
  <div class="flex h-full flex-col items-center justify-center gap-3 bg-surface">
    <div class="h-5 w-5 rounded-full border-2 border-content-muted border-t-transparent animate-spin"></div>
    <span class="text-sm text-content-muted">
      Switching to {switchTargetWs?.name ?? "workspace"}…
    </span>
  </div>
{:else if viewportState.isMobile}
  <!-- ── Mobile shell: top bar + full-width main + bottom tab bar + drawer ── -->
  <div class="flex h-full flex-col overflow-hidden bg-surface">
    <MobileTopBar
      bind:searchOpen
      showSidebar={showSidebar}
      showChannelSidebar={showChannelSidebar}
      wsName={currentWs?.name ?? ""}
    />

    <!-- Trial / paused / activate band — same component as desktop. It also hosts
         ActivateLicenseModal, which on iOS opens the native RevenueCat paywall.
         Without this the iOS shell had no upgrade entry point at all. -->
    <TrialBar />

    <main class="relative flex flex-1 min-w-0 min-h-0 flex-col overflow-hidden bg-surface">
      {@render children()}
      <!-- Tab-change keep-alive (internal docs): persistent terminal panes that
           survive navigation. Overlays the route content on terminal routes;
           hidden (but mounted) everywhere else so a live pty never tears down. -->
      <TerminalPaneHost />
    </main>

    {#if !keyboardOpen && !isTerminalRoute}
      <MobileNav />
    {/if}

    <!-- Slide-in drawer for the channel / daemon sidebar -->
    {#if showSidebar && viewportState.drawerOpen}
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <div
        class="fixed inset-0 z-[var(--z-overlay-backdrop)] bg-black/50"
        onclick={() => viewportState.closeDrawer()}
      ></div>
      <!-- Safe-area insets live on the absolutely-positioned aside below (via its
           top/bottom offsets), NOT as panel padding — see the <style> note.
           touch handlers add swipe-left-to-close; the panel is a presentational
           container (the real closes are backdrop tap / Escape / selection), so
           the static-interaction lint is suppressed like the backdrop above. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="drawer-panel fixed left-0 top-0 bottom-0 z-[var(--z-drawer)] flex w-[82%] max-w-[var(--panel-wide)] flex-col bg-surface shadow-xl"
        ontouchstart={onDrawerTouchStart}
        ontouchend={onDrawerTouchEnd}
      >
        {#if showChannelSidebar}
          <ChannelSidebar />
        {:else if showDaemonSidebar}
          <DaemonSidebar />
        {/if}
      </div>
    {/if}
  </div>
{:else}
  <div class="flex h-full overflow-hidden">
    <WorkspaceSwitcher />
    <!-- Content area with border + rounded corners (matches original WorkspaceLayout) -->
    <div class="relative flex flex-col flex-1 min-w-0 min-h-0 mr-1 mb-1 rounded-lg overflow-hidden border border-solid border-edge-dim">
      <UpdateBanner />
      <TrialBar />
      {#if !isTasks}
        <div class="flex h-9 shrink-0 items-center gap-2 px-3 border-b border-edge-dim bg-surface">
          <!-- Reveal affordance lives in the top bar (not over page content) — shown
               only when the inline sidebar is collapsed. Keyboard equiv: Mod+Shift+\. -->
          {#if showSidebar && viewportState.sidebarCollapsed}
            <button
              type="button"
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
              title="Show sidebar"
              aria-label="Show sidebar"
              onclick={() => viewportState.setSidebarCollapsed(false)}
            >
              <PanelLeftOpenIcon class="h-4 w-4" />
            </button>
          {/if}
          <div class="mx-auto">
            <MessageSearch />
          </div>
          <!-- Activity bell — relocated from the left rail. Same destination
               (ActivityPane at /activity) + unread source (activityState) the
               rail item used; the bell icon is the rail's own Activity glyph.
               ml-auto pins it to the far right while MessageSearch stays centred
               via its own mx-auto. -->
          <a
            href={`/workspace/${wsId}/activity`}
            class="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-content-muted transition-colors hover:bg-surface-hover hover:text-content {activityActive ? 'bg-surface-hover text-content' : ''}"
            title="Activity"
            aria-label={activityUnread > 0 ? `Activity, ${activityUnread} unread` : "Activity"}
            aria-current={activityActive ? "page" : undefined}
          >
            <div class="relative h-4 w-4 [&>svg]:h-4 [&>svg]:w-4" aria-hidden="true">
              {@html activityActive ? RAIL_ICONS.activityFilled : RAIL_ICONS.activityOutline}
              {#if activityUnread > 0}
                <span
                  class="absolute -top-1.5 -right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-error px-1 text-[9px] font-bold leading-none text-accent-foreground"
                >
                  {activityUnread > 99 ? "99+" : activityUnread}
                </span>
              {/if}
            </div>
          </a>
        </div>
      {/if}
      <div class="flex flex-1 min-h-0 overflow-hidden">
        {#if showChannelSidebar && !viewportState.sidebarCollapsed}
          <ChannelSidebar />
        {/if}
        {#if showDaemonSidebar && !viewportState.sidebarCollapsed}
          <DaemonSidebar />
        {/if}
        <main class="relative flex flex-1 min-w-0 min-h-0 flex-col overflow-hidden bg-surface">
          {@render children()}
          <!-- Tab-change keep-alive (internal docs): persistent terminal panes
               that survive navigation. Overlays the route content on terminal
               routes; hidden (but mounted) elsewhere so a live pty never tears
               down on a tab switch. -->
          <TerminalPaneHost />
        </main>
      </div>
    </div>
  </div>
{/if}

<!-- Global command-palette + shortcuts help. Mounted once the workspace shell is
     live (not during restore / switch screens) so their global Cmd/Ctrl-K and
     Cmd/Ctrl-/ listeners are active anywhere inside a workspace. -->
{#if !restoring && !workspaceState.switchError && !workspaceState.switching}
  <QuickSwitcher />
  <KeyboardShortcutsModal />
{/if}

<style>
  /* Pin the drawer sidebar to fill the panel. Neither the aside's `h-full`
     (height: 100%) NOR `flex: 1 1 0` is reliable in WKWebView here: the panel's
     height comes from top/bottom offsets rather than an explicit `height`, and
     iOS WebKit treats that as indefinite for both percentage-height AND flex
     main-size resolution — so the aside collapsed to content height, floating the
     pinned "Invite Agents"/"Invite Humans" footer up under the DM list (the ~180px
     jump the Chats tab never had). Absolute positioning with top/bottom offsets
     ALWAYS yields a definite used height in WebKit, so the aside fills the panel
     and its inner `flex-1` scroll area + `mt-auto` footer resolve correctly. Safe
     areas ride on the offsets (the panel no longer pads), so the header clears the
     notch and the footer clears the home indicator. Direct-child selector so it
     only hits the sidebar root, not any nested <aside>. */
  .drawer-panel > :global(aside) {
    position: absolute !important;
    left: 0 !important;
    right: 0 !important;
    top: var(--sat, 0px) !important;
    bottom: var(--sab, 0px) !important;
    width: auto !important;
    height: auto !important;
    min-width: 0 !important;
    min-height: 0 !important;
  }
</style>
