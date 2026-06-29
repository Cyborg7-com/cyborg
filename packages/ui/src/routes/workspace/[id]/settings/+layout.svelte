<script lang="ts">
  import { page } from "$app/state";
  import SettingsNav from "$lib/components/settings/SettingsNav.svelte";
  import { shellConfig } from "$lib/core/plugin.svelte.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import { goBackFromConversation } from "$lib/mobile/swipeBack";

  let { children } = $props();

  const basePath = $derived(`/workspace/${page.params.id}/settings`);
  const isRoot = $derived(page.url.pathname === basePath || page.url.pathname === basePath + "/");
  // /settings/daemon doubles as the top-level "Daemons" bottom-nav tab. When it's
  // reached that way the page is a tab destination, not a settings sub-page, so the
  // "back to settings" chevron is wrong (the bottom nav handles navigation). Keep
  // the title bar, drop the chevron. Desktop is unaffected (this is the mobile branch).
  const isDaemonTab = $derived(
    page.url.pathname === basePath + "/daemon" || page.url.pathname === basePath + "/daemon/",
  );

  // Active tab label for the desktop breadcrumb. Longest-href match wins so e.g.
  // "/notifications" beats the empty-href "General" root. Falls back to the
  // General root when nothing else matches.
  const activeTab = $derived.by(() => {
    const path = page.url.pathname;
    let best: { label: string; len: number } | null = null;
    for (const tab of shellConfig.settingsTabs) {
      const full = basePath + tab.href;
      const matches = tab.href === "" ? path === basePath || path === basePath + "/" : path.startsWith(full);
      if (matches && (!best || tab.href.length > best.len)) {
        best = { label: tab.label, len: tab.href.length };
      }
    }
    return best?.label ?? "General";
  });

  // Title for the mobile sub-page header bar (S8). Profile/Appearance are
  // mobile-only routes without a settings-tab entry, so they're named here;
  // everything else reuses the tab label. Unknown sub-routes (e.g. /logs)
  // title-case their first path segment instead of lying with "General".
  const mobileTitle = $derived.by(() => {
    const path = page.url.pathname;
    if (path.startsWith(basePath + "/profile")) return "Profile";
    if (path.startsWith(basePath + "/appearance")) return "Appearance";
    if (activeTab !== "General") return activeTab;
    const seg = path.slice(basePath.length).split("/").find(Boolean);
    return seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : "Settings";
  });
</script>

{#if viewportState.isMobile}
  <!-- S8 mobile: iOS Settings pattern — no tab strip. The ROOT renders its own
       large-title list (settings/+page.svelte); every SUB-PAGE gets a 44pt
       header bar here: back chevron + centered 17pt title, content full-width
       below. The chevron uses the same origin-aware pop as the edge-swipe
       (computeBackTarget maps /settings/<sub> → /settings), so button and
       gesture always land in the same place and the pop animation plays. -->
  <div class="flex h-full flex-col overflow-hidden bg-surface">
    {#if !isRoot}
      <div class="grid h-[44px] shrink-0 grid-cols-[48px_minmax(0,1fr)_48px] items-center">
        {#if !isDaemonTab}
          <button
            type="button"
            onclick={goBackFromConversation}
            class="pressable ml-1 flex h-[44px] w-[44px] items-center justify-center rounded-[12px] text-content-dim focus-ring"
            aria-label="Back to settings"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
          </button>
        {/if}
        <span class="justify-self-center truncate text-[17px] font-semibold text-content">{mobileTitle}</span>
      </div>
    {/if}
    <div class="flex-1 min-w-0 overflow-y-auto">
      {@render children()}
    </div>
  </div>
{:else}
  <!-- Desktop: nav left, content right (unchanged). -->
  <div class="flex h-full flex-col overflow-hidden sm:flex-row">
    <SettingsNav {basePath} />
    <div class="flex flex-1 min-w-0 flex-col overflow-hidden">
      <!-- Desktop breadcrumb above the content pane. -->
      <div class="hidden shrink-0 items-center gap-1.5 border-b border-edge px-6 py-2.5 text-[13px] sm:flex">
        <span class="text-content-muted">Settings</span>
        <svg class="h-3.5 w-3.5 text-content-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span class="font-medium text-content">{activeTab}</span>
      </div>
      <div class="flex-1 min-w-0 overflow-y-auto">
        {@render children()}
      </div>
    </div>
  </div>
{/if}
