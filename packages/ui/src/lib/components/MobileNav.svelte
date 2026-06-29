<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import {
    workspaceState,
    notificationState,
    daemonAccessRequestsState,
    authState,
  } from "$lib/state/app.svelte.js";
  import { shellConfig } from "$lib/core/plugin.svelte.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import { haptic } from "$lib/mobile/haptics";
  import { cn } from "$lib/utils.js";

  // Mobile bottom tab bar: Projects · Team · Daemons. Settings + Feedback live in
  // the top-right profile menu (Slack pattern), NOT a tab.
  // "Chats" opens the channels + DMs list (/chats), not a single channel.
  // This is mobile-only — the desktop rail (shellConfig) is untouched.
  //
  // P2 redesign: iOS-native chrome — .material-bar blur + .hairline-t replace
  // the opaque bg/border; active tab = accent-tinted FILLED icon vs muted
  // outline (filled variants come from shellConfig activeIcon where they exist;
  // DMs + Agents get local filled paths below); springy badge pop on count
  // change; selection haptic once per tab CHANGE. Height, safe-area (--sab),
  // badge data sources, and routes are unchanged.
  // Chat bubble — used for the "Projects" tab (channels = where you chat).
  const CHAT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/></svg>`;
  // Filled variant for the active state.
  const CHAT_ICON_FILLED = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3C6.5 3 2 6.8 2 11.5c0 1.5.5 3 1.3 4.3L2 21l5.4-1.3c1.4.6 2.9.8 4.6.8 5.5 0 10-3.8 10-8.5S17.5 3 12 3z"/></svg>`;
  // AI-style three-sparkle glyph (four-pointed stars) — used for the "Team" tab
  // (humans + agents/AI). Filled for both states; the nav tints inactive muted vs
  // active, so no outline variant.
  const SPARKLES_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 6.5Q15 13.5 22 13.5Q15 13.5 15 20.5Q15 13.5 8 13.5Q15 13.5 15 6.5Z M6.5 3Q6.5 6.5 10 6.5Q6.5 6.5 6.5 10Q6.5 6.5 3 6.5Q6.5 6.5 6.5 3Z M5.5 15.5Q5.5 18 8 18Q5.5 18 5.5 20.5Q5.5 18 3 18Q5.5 18 5.5 15.5Z"/></svg>`;
  const allItems = $derived([...shellConfig.navItems, ...shellConfig.bottomItems]);
  const findItem = (id: string) => allItems.find((i) => i.id === id);

  // Per-tab unread split: channel mentions belong to Projects; everything else
  // (human DMs + agents) belongs to Team. The old single "chat" badge used the
  // whole-workspace total, so a human DM lit up Projects — wrong.
  const channelBadge = $derived.by(() => {
    const id = workspaceState.current?.id ?? page.params.id;
    if (!id) return 0;
    let n = 0;
    for (const c of workspaceState.channels ?? []) n += notificationState.getCount(id, c.id);
    return n;
  });
  const teamBadge = $derived.by(() => {
    const id = workspaceState.current?.id ?? page.params.id;
    if (!id) return 0;
    return Math.max(0, notificationState.getWorkspaceTotal(id) - channelBadge);
  });
  // Owner notification without an Activity tab (#705): daemon access-requests
  // awaiting MY action (incoming on daemons I own). Shown as a count badge on the
  // always-visible Daemons tab, so the owner sees a pending request from anywhere —
  // including the Projects/home screen — and taps through to approve/deny.
  const daemonRequestBadge = $derived(
    daemonAccessRequestsState.pendingIncoming(authState.user?.id).length,
  );
  // Home + Activity removed on mobile (too busy, redundant on a phone). The
  // Inbox and Agents tabs were ~80% the same (both surfaced the cybo roster +
  // live sessions), so they're merged into one "Team" tab. Mobile tabs are now
  // just Projects · Team. Desktop rail (shellConfig) is untouched.
  //   Projects = channels grouped by project (/chats)
  //   Team    = everyone you work with — Humans · Agents · Sessions (/dms)
  //   Daemons = your machines (/settings/daemon — the clean daemon page; the old
  //             /daemons route redirects to the removed Agents view, so don't use it)
  // "Daemons" tab — a server rack (machines). Outline + filled variants.
  const DAEMONS_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><line x1="7" y1="7" x2="7.01" y2="7"/><line x1="7" y1="17" x2="7.01" y2="17"/></svg>`;
  const DAEMONS_ICON_FILLED = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/></svg>`;
  const tabs = $derived(
    [
      { ...findItem("chat"), id: "chat", label: "Projects", icon: CHAT_ICON, activeIcon: CHAT_ICON_FILLED, path: "/chats", pathMatch: ["/chats", "/channel", "/threads", "/saved"], badge: channelBadge, position: "nav", order: 1 },
      { id: "dms", label: "Team", icon: SPARKLES_ICON, activeIcon: SPARKLES_ICON, path: "/dms", pathMatch: ["/dms", "/dm/", "/agent", "/agents"], badge: teamBadge, position: "nav", order: 2 },
      { id: "daemons", label: "Daemons", icon: DAEMONS_ICON, activeIcon: DAEMONS_ICON_FILLED, path: "/settings/daemon", pathMatch: ["/settings/daemon"], badge: daemonRequestBadge, position: "nav", order: 3 },
    ].filter((i): i is NonNullable<typeof i> => Boolean(i?.icon)),
  );

  const wsId = $derived(workspaceState.current?.id ?? page.params.id);
  const pathname = $derived(page.url.pathname);

  function isItemActive(item: (typeof tabs)[number]): boolean {
    if (item.id === "home")
      return pathname === `/workspace/${wsId}` || pathname === `/workspace/${wsId}/home`;
    const paths = item.pathMatch ?? [item.path];
    return paths.some((p) => p && pathname.startsWith(`/workspace/${wsId}${p}`));
  }

  // Index of the active tab — drives the liquid-glass selection pill's slide.
  const activeIndex = $derived(tabs.findIndex((t) => isItemActive(t)));

  function handleItemClick(item: (typeof tabs)[number]): void {
    if (!wsId) return;
    viewportState.closeDrawer();
    // Selection tick only when the tab actually CHANGES — re-tapping the
    // active tab is silent (iOS tab bars don't tick on re-select).
    if (!isItemActive(item)) haptic("selection");
    goto(`/workspace/${wsId}${item.path}`);
  }
</script>

<!-- iOS 26 "Liquid Glass" tab bar (CSS approximation — true Liquid Glass is a
     native material unavailable to WKWebView): a floating translucent capsule
     with a heavy backdrop blur, specular edge highlights, a soft drop shadow,
     and a glassy selection pill that slides between tabs. Stays in normal flow
     (reserves its own height) so it doesn't overlap content. -->
<nav class="lg-tabwrap shrink-0" style="padding-bottom: calc(var(--sab) + 9px);">
  <div class="lg-tabbar" style="--pill-x: {(activeIndex < 0 ? 0 : activeIndex) * 100}%; --tab-count: {tabs.length};">
    <!-- The sliding glass selection pill (hidden when no tab matches). -->
    <span class="lg-pill" style="opacity: {activeIndex < 0 ? 0 : 1};" aria-hidden="true"></span>

    {#each tabs as item (item.id)}
      {@const active = isItemActive(item)}
      <button
        type="button"
        class={cn(
          "lg-tab relative z-[1] flex flex-1 flex-col items-center justify-center gap-[3px] transition-colors duration-200",
          active ? "text-content" : "text-content-muted",
        )}
        onclick={() => handleItemClick(item)}
        aria-label={(item.badge ?? 0) > 0 ? `${item.label}, ${item.badge} unread` : item.label}
        aria-current={active ? "page" : undefined}
      >
        <span class="relative" aria-hidden="true">
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          {@html active && item.activeIcon ? item.activeIcon : item.icon}
          {#if (item.badge ?? 0) > 0}
            {#key item.badge}
              <span
                class="badge-pop absolute -top-1.5 -right-2 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold leading-none text-white"
              >
                {(item.badge ?? 0) > 99 ? "99+" : item.badge}
              </span>
            {/key}
          {/if}
        </span>
        <span class="text-[10.5px] font-medium leading-none">{item.label}</span>
      </button>
    {/each}
  </div>
</nav>

<style>
  /* Float the capsule with a side gutter; transparent wrap lets the page show
     through underneath. --primary→currentColor so the registry SVGs tint with
     the button's accent/muted text color. */
  .lg-tabwrap {
    --primary: currentColor;
    padding: 8px 16px 0;
    background: transparent;
  }
  .lg-tabwrap :global(svg) {
    width: 1.375rem;
    height: 1.375rem;
  }

  .lg-tabbar {
    position: relative;
    display: flex;
    gap: 0;
    height: 58px;
    padding: 6px;
    border-radius: 999px;
    /* Liquid glass: translucent theme-aware fill + heavy blur/saturation. */
    background: color-mix(in srgb, var(--bg-base) 60%, transparent);
    -webkit-backdrop-filter: blur(22px) saturate(180%);
    backdrop-filter: blur(22px) saturate(180%);
    /* Edge light + soft float + inner specular top / shaded bottom. */
    border: 1px solid color-mix(in srgb, white 16%, transparent);
    box-shadow:
      0 8px 28px rgba(0, 0, 0, 0.26),
      0 2px 6px rgba(0, 0, 0, 0.16),
      inset 0 1px 0 color-mix(in srgb, white 38%, transparent),
      inset 0 -1px 1px color-mix(in srgb, black 10%, transparent);
  }
  /* Opaque-ish fallback where backdrop-filter is unsupported. */
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .lg-tabbar {
      background: color-mix(in srgb, var(--bg-base) 94%, transparent);
    }
  }

  /* Sliding glassy selection pill — sits behind the active tab. Neutral (NOT
     accent): a frosted monochrome pill that tints with the theme — soft dark on
     light, soft light on dark — so the active tab reads black-on-light /
     white-on-dark with no blue. Width = one tab (1/--tab-count); the inline
     --pill-x = activeIndex * 100% slides it onto the active tab. */
  .lg-pill {
    position: absolute;
    top: 6px;
    bottom: 6px;
    left: 6px;
    width: calc((100% - 12px) / var(--tab-count, 2));
    border-radius: 999px;
    background: color-mix(in srgb, var(--text-primary) 13%, transparent);
    border: 1px solid color-mix(in srgb, var(--text-primary) 16%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, white 38%, transparent),
      0 2px 8px rgba(0, 0, 0, 0.18);
    transform: translateX(var(--pill-x));
    transition:
      transform 0.46s cubic-bezier(0.32, 0.72, 0, 1),
      opacity 0.2s ease;
  }

  .badge-pop {
    animation: mobile-nav-badge-pop 250ms var(--ease-spring, cubic-bezier(0.32, 0.72, 0, 1));
  }
  @keyframes mobile-nav-badge-pop {
    0% { transform: scale(0.5); }
    60% { transform: scale(1.1); }
    100% { transform: scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .lg-pill { transition: opacity 0.2s ease; }
    .badge-pop { animation: none; }
  }
</style>
