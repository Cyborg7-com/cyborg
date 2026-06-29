<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { workspaceState, authState, disconnectFromServer, deleteAccount, setMyPresence, selfPresenceState, notifyClientPrefsState } from "$lib/state/app.svelte.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import ThemeToggle from "$lib/components/settings/ThemeToggle.svelte";
  import ProfileSettings from "$lib/components/settings/ProfileSettings.svelte";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { preferencesState } from "$lib/state/preferences.svelte.js";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import Avatar from "$lib/components/Avatar.svelte";
  import { cn } from "$lib/utils.js";
  import { goBackFromConversation } from "$lib/mobile/swipeBack";
  import { isTauriIOS } from "$lib/mobile/push.js";
  import { manageSubscriptions } from "$lib/mobile/iap.js";
  import { licenseState } from "$lib/state/license.svelte.js";

  // Presence (Away) + Pause notifications (DND) moved here from the profile menu.
  // Away reads from the global selfPresenceState (consistent across navigations —
  // the relay doesn't echo self-presence); DND is global via notifyClientPrefsState.
  const isAway = $derived(selfPresenceState.away);
  const dndActive = $derived(notifyClientPrefsState.dnd);
  // #619: Tasks-tab visibility toggle (default OFF). Gates the Tasks rail item;
  // the recurring-schedule engine + RPCs stay intact whether on or off.
  const showTasksTab = $derived(preferencesState.showTasksTab);
  function toggleAway() {
    setMyPresence(!selfPresenceState.away);
  }
  function toggleDnd() {
    notifyClientPrefsState.toggleDnd();
  }
  const canManageSubscription = $derived(isTauriIOS() && licenseState.state === "active");

  // Inline subscription details for the iOS "Manage subscription" card. Source is
  // the already-fetched server license — no extra fetch, no invented fields.
  const license = $derived(licenseState.license);

  function fmtDate(ms: number | null): string {
    if (!ms || Number.isNaN(ms)) return "—";
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
  }

  // Mirrors the billing page's tone palette + pill. This card is gated to an
  // ACTIVE license, so only the active-state branches can fire; we keep the same
  // TONE_COLOR map + pill markup so it reads identically to the billing screen.
  type Tone = "success" | "info" | "warn" | "error" | "muted";
  const badge = $derived.by((): { label: string; tone: Tone } => {
    if (!license) return { label: "Loading…", tone: "muted" };
    if (license.status === "past_due" || license.status === "unpaid") {
      return { label: "Payment overdue", tone: "error" };
    }
    if (license.status === "canceled") return { label: "Canceled", tone: "muted" };
    if (license.cancelAtPeriodEnd) return { label: "Canceling", tone: "warn" };
    return { label: "Active", tone: "success" };
  });

  const TONE_COLOR: Record<Tone, string> = {
    success: "var(--color-online, #3daa7c)",
    info: "var(--c7-accent, var(--color-link))",
    warn: "var(--color-warning, #e8ab5a)",
    error: "var(--color-error, #e01e5a)",
    muted: "var(--text-muted)",
  };

  const workspace = $derived(workspaceState.current);
  const members = $derived(workspaceState.members);

  // Real build version from the Electron shell (same source the About tab uses),
  // not a hardcoded string. Absent in the browser, where we hide the footer.
  const desktop = (window as unknown as { cyborg7Desktop?: { getVersion: () => Promise<string> } })
    .cyborg7Desktop;
  let appVersion = $state<string | null>(null);

  onMount(() => {
    // Guard the METHOD, not just the bridge: a partial mock could expose
    // cyborg7Desktop without getVersion, and desktop?.getVersion() would throw.
    if (desktop?.getVersion) {
      void (async () => {
        try {
          appVersion = await desktop.getVersion();
        } catch {
          // Version is best-effort; leave it null (footer hides) on failure.
        }
      })();
    }
  });

  let confirmLogout = $state(false);
  let confirmDelete = $state(false);
  let deleting = $state(false);
  let deleteError = $state<string | null>(null);

  function handleLogout() {
    confirmLogout = false;
    disconnectFromServer();
    goto("/login");
  }

  // App-Store Guideline 5.1.1(v): in-app account deletion. deleteAccount()
  // deletes the account server-side, clears the saved session, and routes to
  // /login on success. On failure we surface the error and keep the user
  // signed in.
  async function handleDeleteAccount() {
    confirmDelete = false;
    deleting = true;
    deleteError = null;
    try {
      await deleteAccount();
    } catch (e) {
      deleteError = e instanceof Error ? e.message : "Could not delete account. Please try again.";
      deleting = false;
    }
  }

  // ── S8 mobile root list (iOS Settings pattern) ────────────────────────────
  // Same identity data the Profile sub-page (ProfileSettings) edits: prefer the
  // just-uploaded optimistic image, then the persisted PG avatar.
  const basePath = $derived(`/workspace/${page.params.id}/settings`);
  const user = $derived(authState.user);
  const profileImage = $derived(authState.user?.imageUrl ?? authState.profileImage);
  const userName = $derived(user?.name ?? user?.email ?? "User");

  // Fixed iOS-grouped presentation of EXACTLY the configured settings tabs
  // (same hrefs — the sub-pages already exist as routes and swipe-back already
  // maps /settings/<sub> → /settings). General's own content is split across
  // this root list + the mobile-only /profile and /appearance sub-routes. Tile
  // colors are deliberate constants (iOS Settings icon tiles keep the same
  // saturated color in both themes; the glyph is always white).
  interface MobileNavCell {
    id: string;
    label: string;
    href: string;
    tile: string;
  }
  const prefCells: MobileNavCell[] = [
    { id: "notifications", label: "Notifications", href: "/notifications", tile: "#ff3b30" },
    { id: "appearance", label: "Appearance", href: "/appearance", tile: "var(--c7-accent)" },
  ];
  const workspaceCells: MobileNavCell[] = [
    { id: "workspace", label: "Workspace", href: "/workspace", tile: "#007aff" },
    { id: "members", label: "Members", href: "/members", tile: "#34c759" },
    { id: "billing", label: "Billing", href: "/billing", tile: "#af52de" },
  ];
  const infraCells: MobileNavCell[] = [
    { id: "backend", label: "Backend", href: "/backend", tile: "#5ac8fa" },
    { id: "daemon", label: "Daemon", href: "/daemon", tile: "#8e8e93" },
    { id: "ai", label: "AI", href: "/ai", tile: "#ff2d55" },
    { id: "mcp", label: "MCP", href: "/mcp", tile: "#ff9500" },
    { id: "logs", label: "Logs", href: "/logs", tile: "#636366" },
  ];
  const aboutCells: MobileNavCell[] = [
    { id: "about", label: "About", href: "/about", tile: "#8e8e93" },
  ];
</script>

{#snippet hairline60()}
  <!-- Separator ONLY between cells inside a grouped card, inset to the label
       start (16px pad + 28px tile + 16px gap = 60px, iOS). -->
  <div class="ml-[60px]" style="height: 0.5px; background: var(--hairline);"></div>
{/snippet}

{#snippet chevron()}
  <svg class="shrink-0 text-content-muted" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
{/snippet}

{#snippet glyph(id: string)}
  <!-- text-accent-foreground = #ffffff in both themes (text-white is remapped
       to var(--primary) in this app and flips with the theme). -->
  <svg class="h-4 w-4 text-accent-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {#if id === "notifications"}
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    {:else if id === "appearance"}
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    {:else if id === "workspace"}
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
      <line x1="8" y1="21" x2="16" y2="21"/>
      <line x1="12" y1="17" x2="12" y2="21"/>
    {:else if id === "members"}
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    {:else if id === "billing"}
      <rect x="1" y="4" width="22" height="16" rx="2" ry="2"/>
      <line x1="1" y1="10" x2="23" y2="10"/>
    {:else if id === "backend"}
      <path d="M22 12H2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0zM12 22c1.66 0 3-4.48 3-10S13.66 2 12 2 9 6.48 9 12s1.34 10 3 10z"/>
    {:else if id === "daemon"}
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
      <line x1="6" y1="6" x2="6.01" y2="6"/>
      <line x1="6" y1="18" x2="6.01" y2="18"/>
    {:else if id === "ai"}
      <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/>
      <path d="M19 15l.7 1.8L21.5 17.5l-1.8.7L19 20l-.7-1.8L16.5 18.5l1.8-.7z"/>
    {:else if id === "mcp"}
      <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z"/>
    {:else if id === "logs"}
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="8" y1="13" x2="16" y2="13"/>
      <line x1="8" y1="17" x2="16" y2="17"/>
      <line x1="8" y1="9" x2="10" y2="9"/>
    {:else}
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="16" x2="12" y2="12"/>
      <line x1="12" y1="8" x2="12.01" y2="8"/>
    {/if}
  </svg>
{/snippet}

{#snippet navCard(cells: MobileNavCell[])}
  <div class="overflow-hidden rounded-[14px] bg-surface-alt">
    {#each cells as cell, i (cell.id)}
      {#if i > 0}{@render hairline60()}{/if}
      <button
        type="button"
        onclick={() => goto(basePath + cell.href)}
        class="pressable-row flex h-[48px] w-full items-center gap-4 px-[16px] text-left focus-ring"
      >
        <span class="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[7px]" style="background-color: {cell.tile};">
          {@render glyph(cell.id)}
        </span>
        <span class="min-w-0 flex-1 truncate text-[16px] text-content">{cell.label}</span>
        {@render chevron()}
      </button>
    {/each}
  </div>
{/snippet}

{#if viewportState.isMobile}
  <!-- S8 mobile ROOT: iOS Settings list — profile card → grouped nav cards →
       workspace info (quiet, read-only) → sign out → danger. ProfileSettings
       and the theme picker moved to the /profile and /appearance sub-routes. -->
  <div class="px-4 pb-8 pt-1">
    <!-- Back to wherever Settings was opened from (profile menu → previous tab).
         computeBackTarget returns "" for the settings root, so this pops history. -->
    <button
      type="button"
      onclick={goBackFromConversation}
      class="pressable -ml-2 mb-1 flex h-[40px] w-[40px] items-center justify-center rounded-[12px] text-content-dim focus-ring"
      aria-label="Back"
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
    </button>
    <h1 class="text-[28px] font-bold leading-[34px] tracking-[-0.01em] text-content">Settings</h1>

    <div class="mt-4 space-y-5">
      <!-- Profile card → Profile sub-page (hosts the existing ProfileSettings). -->
      <button
        type="button"
        onclick={() => goto(`${basePath}/profile`)}
        class="pressable-row flex w-full items-center gap-4 overflow-hidden rounded-[14px] bg-surface-alt px-[16px] py-[10px] text-left focus-ring"
      >
        <Avatar name={userName} image={profileImage} width={56} fontSize={22} borderRadius="50%" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-[17px] font-semibold text-content">{userName}</span>
          {#if user?.email}
            <span class="block truncate text-[13px] text-content-muted">{user.email}</span>
          {/if}
        </span>
        {@render chevron()}
      </button>

      <!-- Presence + notifications (moved from the profile menu). Tap to toggle;
           trailing pill shows the active state. -->
      <div class="overflow-hidden rounded-[14px] bg-surface-alt">
        <button
          type="button"
          onclick={toggleAway}
          class="pressable-row flex h-[48px] w-full items-center gap-3 px-[16px] text-left focus-ring"
          aria-pressed={isAway}
        >
          <span class="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[7px]" style="background-color: #8e8e93;">
            <span class={cn("h-[10px] w-[10px] rounded-full", isAway ? "bg-content-muted" : "bg-online")}></span>
          </span>
          <span class="min-w-0 flex-1 truncate text-[16px] text-content">Away</span>
          <span class="text-[14px] text-content-muted">{isAway ? "On" : "Off"}</span>
        </button>
        {@render hairline60()}
        <button
          type="button"
          onclick={toggleDnd}
          class="pressable-row flex h-[48px] w-full items-center gap-3 px-[16px] text-left focus-ring"
          aria-pressed={dndActive}
        >
          <span class="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[7px]" style="background-color: #ff3b30;">
            <svg class="h-4 w-4 text-accent-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
          </span>
          <span class="min-w-0 flex-1 truncate text-[16px] text-content">Pause notifications</span>
          <span class={cn("text-[14px]", dndActive ? "text-error" : "text-content-muted")}>{dndActive ? "On" : "Off"}</span>
        </button>
        {@render hairline60()}
        <button
          type="button"
          onclick={() => preferencesState.toggleShowTasksTab()}
          class="pressable-row flex h-[48px] w-full items-center gap-3 px-[16px] text-left focus-ring"
          aria-pressed={showTasksTab}
        >
          <span class="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[7px]" style="background-color: #34c759;">
            <svg class="h-4 w-4 text-accent-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          </span>
          <span class="flex min-w-0 flex-1 items-center gap-2 truncate text-[16px] text-content">
            Tasks tab
            <Badge variant="secondary" class="shrink-0">Beta</Badge>
          </span>
          <span class={cn("text-[14px]", showTasksTab ? "text-online" : "text-content-muted")}>{showTasksTab ? "On" : "Off"}</span>
        </button>
      </div>

      <!-- Preferences -->
      {@render navCard(prefCells)}

      <!-- Workspace -->
      {@render navCard(workspaceCells)}

      <!-- (Read-only workspace Name/role/Members card removed — it duplicated the
           Workspace settings page and broke the grouped-list flow.) -->

      <!-- Infrastructure -->
      {@render navCard(infraCells)}

      <!-- About -->
      {@render navCard(aboutCells)}

      <!-- Manage subscription (iOS active subscribers) — moved from the profile
           menu. Shows the current plan/status/renewal inline (from the
           already-fetched server license) and the action row opens the native
           App Store manage sheet. -->
      {#if canManageSubscription}
        <div>
          <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">Subscription</p>
          <div class="overflow-hidden rounded-[14px] bg-surface-alt">
            {#if license}
              <div class="flex min-h-[44px] items-center justify-between px-[16px] py-[10px]">
                <span class="text-[16px] text-content">Status</span>
                <span
                  class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-semibold"
                  style="color: {TONE_COLOR[badge.tone]}; background: color-mix(in srgb, {TONE_COLOR[badge.tone]} 14%, transparent);"
                >
                  <span class="h-[6px] w-[6px] rounded-full bg-current"></span>
                  {badge.label}
                </span>
              </div>
              {@render hairline60()}
              <div class="flex min-h-[44px] items-center justify-between px-[16px] py-[10px]">
                <span class="text-[16px] text-content">Plan</span>
                <span class="text-[16px] font-semibold capitalize text-content">{license.plan}</span>
              </div>
              {#if license.currentPeriodEnd && license.state !== "trialing"}
                {@render hairline60()}
                <div class="flex min-h-[44px] items-center justify-between px-[16px] py-[10px]">
                  <span class="text-[16px] text-content">
                    {license.cancelAtPeriodEnd ? "Access until" : "Renews"}
                  </span>
                  <span class="text-[15px] text-content-muted">{fmtDate(license.currentPeriodEnd)}</span>
                </div>
              {/if}
              {@render hairline60()}
            {/if}
            <button
              type="button"
              onclick={() => void manageSubscriptions()}
              class="pressable-row flex h-[48px] w-full items-center gap-4 px-[16px] text-left focus-ring"
            >
              <span class="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[7px]" style="background-color: #af52de;">
                <svg class="h-4 w-4 text-accent-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
              </span>
              <span class="min-w-0 flex-1 truncate text-[16px] text-content">Manage subscription</span>
              {@render chevron()}
            </button>
          </div>
        </div>
      {/if}

      <!-- Sign out: centered red text cell in its own card (iOS). -->
      <div class="overflow-hidden rounded-[14px] bg-surface-alt">
        <button
          type="button"
          onclick={() => { confirmLogout = true; }}
          class="pressable-row flex h-[48px] w-full items-center justify-center px-[16px] focus-ring"
        >
          <span class="text-[16px] text-error">Sign out</span>
        </button>
      </div>

      <!-- Danger: App-Store Guideline 5.1.1(v) requires in-app account
           deletion — same confirm flow + error surface as desktop. -->
      <div>
        <div class="overflow-hidden rounded-[14px] bg-surface-alt">
          <button
            type="button"
            onclick={() => { confirmDelete = true; }}
            disabled={deleting}
            class="pressable-row flex h-[48px] w-full items-center justify-center gap-2 px-[16px] focus-ring disabled:opacity-50"
          >
            {#if deleting}
              <svg class="h-4 w-4 animate-spin text-error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
              </svg>
              <span class="text-[16px] text-error">Deleting…</span>
            {:else}
              <span class="text-[16px] text-error">Delete account</span>
            {/if}
          </button>
        </div>
        <p class="px-[16px] pt-2 text-[13px] text-content-muted">
          Permanently delete your account and all associated data. This cannot be undone.
        </p>
        {#if deleteError}
          <p class="px-[16px] pt-1 text-[13px] text-error">{deleteError}</p>
        {/if}
      </div>

      <!-- Version -->
      {#if appVersion}
        <p class="pt-1 text-center text-[11px] text-content-muted">v{appVersion}</p>
      {/if}
    </div>
  </div>
{:else}
  <div class="mx-auto max-w-2xl px-6 py-8 space-y-8">
    <header>
      <h1 class="text-lg font-semibold text-content">General</h1>
      <p class="mt-1 text-xs text-content-muted">App preferences and workspace info</p>
    </header>

    <!-- Profile -->
    <section class="space-y-4">
      <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
        Profile
      </span>
      <ProfileSettings />
    </section>

    <!-- Appearance -->
    <section class="space-y-3">
      <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
        Appearance
      </span>
      <div class="flex items-center justify-between rounded-lg border border-edge px-4 py-3">
        <div>
          <div class="text-sm font-medium text-content">Theme</div>
          <div class="text-[11px] text-content-dim">Choose between dark, light, or system preference</div>
        </div>
        <ThemeToggle />
      </div>
      <div class="flex items-center justify-between rounded-lg border border-edge px-4 py-3">
        <div>
          <div class="flex items-center gap-2 text-sm font-medium text-content">
            Tasks tab
            <Badge variant="secondary">Beta</Badge>
          </div>
          <div class="text-[11px] text-content-dim">Recurring scheduled runs for your agents — beta</div>
        </div>
        <Switch
          checked={showTasksTab}
          onCheckedChange={(v) => preferencesState.setShowTasksTab(v)}
          aria-label="Toggle Tasks tab"
        />
      </div>
    </section>

    <!-- Workspace info -->
    {#if workspace}
      <section class="space-y-3">
        <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
          Workspace
        </span>
        <div class="rounded-lg border border-edge divide-y divide-edge">
          <div class="flex items-center justify-between px-4 py-3">
            <span class="text-sm text-content-dim">Name</span>
            <span class="text-sm font-medium text-content">{workspace.name}</span>
          </div>
          <div class="flex items-center justify-between px-4 py-3">
            <span class="text-sm text-content-dim">Your role</span>
            <span class="text-sm font-medium text-content capitalize">{workspace.role}</span>
          </div>
          <div class="flex items-center justify-between px-4 py-3">
            <span class="text-sm text-content-dim">Members</span>
            <span class="text-sm font-medium text-content">{members.length}</span>
          </div>
          {#if workspace.settings?.defaultAgentModel}
            <div class="flex items-center justify-between px-4 py-3">
              <span class="text-sm text-content-dim">Default model</span>
              <span class="text-sm font-mono text-content-muted">{workspace.settings.defaultAgentModel}</span>
            </div>
          {/if}
        </div>
      </section>
    {/if}

    <!-- Sign out -->
    <section class="space-y-3">
      <button
        onclick={() => { confirmLogout = true; }}
        class="flex w-full items-center justify-center gap-2 rounded-lg border border-edge px-4 py-3 text-sm font-medium text-error hover:bg-error/10 transition-colors"
      >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
        Sign out
      </button>
    </section>

    <!-- Danger zone — App-Store Guideline 5.1.1(v) requires in-app account
         deletion for any app that supports account creation. -->
    <section class="space-y-3">
      <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
        Danger zone
      </span>
      <div class="rounded-lg border border-error/40 px-4 py-3 space-y-3">
        <div>
          <div class="text-sm font-medium text-content">Delete account</div>
          <div class="text-[11px] text-content-dim">
            Permanently delete your account and all associated data. This cannot be undone.
          </div>
        </div>
        <button
          onclick={() => { confirmDelete = true; }}
          disabled={deleting}
          class="flex w-full items-center justify-center gap-2 rounded-lg bg-error px-4 py-2.5 text-sm font-medium text-accent-foreground hover:bg-error/80 transition-colors disabled:opacity-50"
        >
          {#if deleting}
            <svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
            Deleting…
          {:else}
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
            Delete account
          {/if}
        </button>
        {#if deleteError}
          <p class="text-[11px] text-error">{deleteError}</p>
        {/if}
      </div>
    </section>

    <!-- Version -->
    {#if appVersion}
      <p class="text-center text-xs text-content-muted">v{appVersion}</p>
    {/if}
  </div>
{/if}

<ConfirmDialog
  open={confirmLogout}
  title="Sign out"
  message="You will need to log in again to access this workspace."
  confirmLabel="Sign out"
  destructive
  onconfirm={handleLogout}
  oncancel={() => { confirmLogout = false; }}
/>

<ConfirmDialog
  open={confirmDelete}
  title="Delete account"
  message="This permanently deletes your account and cannot be undone. Workspaces you solely own are deleted; shared workspaces are transferred to another admin."
  confirmLabel="Delete account"
  destructive
  onconfirm={handleDeleteAccount}
  oncancel={() => { confirmDelete = false; }}
/>
