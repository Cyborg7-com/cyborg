<script lang="ts">
  import { page } from "$app/state";
  import {
    workspaceState,
    daemonState,
    selectDaemon,
    authState,
    client,
  } from "$lib/state/app.svelte.js";
  import type { Daemon } from "$lib/state/app.svelte.js";
  import { cn } from "$lib/utils.js";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    TooltipProvider,
  } from "$lib/components/ui/tooltip/index.js";
  import { goto } from "$app/navigation";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import MobileSheet from "$lib/components/MobileSheet.svelte";

  const currentUserId = $derived(authState.user?.id);
  // Your own daemon(s) — the "YOU" one — always first, then the rest in their
  // existing order. (Array.sort is stable, so non-owned daemons keep order.)
  const daemons = $derived(
    [...daemonState.list].sort(
      (a, b) => (a.ownerId === currentUserId ? 0 : 1) - (b.ownerId === currentUserId ? 0 : 1),
    ),
  );
  // The daemon whose detail view is open: an explicit selection wins (clicks
  // switch the Agents pane to the Daemon sub-tab in-page, so there's no route
  // param on /agents), then any /daemons/[daemonId] deep-link param, then the
  // effective default so a row is highlighted even before a click.
  const activeDaemonId = $derived(
    daemonState.selectedId ??
      (page.params.daemonId as string | undefined) ??
      daemonState.effectiveId(currentUserId) ??
      null,
  );

  function locationLabel(daemon: Daemon): string {
    return daemonState.locationLabel(daemon.meta) ?? "Unknown location";
  }

  // ── "N daemons outdated → Update" aggregate (#663) ──
  // One npm-view of the latest daemon version (via any online daemon), compared
  // against each daemon's published meta.version. Bounded: a single fetch, not
  // one per daemon. Fetched once when an online daemon with a known version is
  // present; silent on failure (the per-daemon detail still has its own check).
  const wsId = $derived(workspaceState.current?.id);
  let latestDaemonVersion = $state<string | null>(null);
  let latestFetchedForWs: string | null = null;
  let isFetchingLatest = false;
  function semver(v: string | null | undefined): [number, number, number] | null {
    const m = v?.match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }
  function isOutdated(daemon: Daemon): boolean {
    const a = semver(latestDaemonVersion);
    const b = semver(daemon.meta?.version);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  }
  const outdatedCount = $derived(
    latestDaemonVersion ? daemons.filter((d) => daemonState.isOnline(d.id) && isOutdated(d)).length : 0,
  );
  $effect(() => {
    const id = wsId;
    if (!id || latestFetchedForWs === id || isFetchingLatest) return;
    const probe = daemons.find((d) => daemonState.isOnline(d.id) && d.meta?.version);
    if (!probe) return;
    // In-flight guard prevents concurrent fetches; only mark the workspace done
    // on SUCCESS so a transient npm/network failure can be retried (a failed
    // fetch left the badge permanently broken otherwise).
    isFetchingLatest = true;
    void client
      .daemonUpdateLatest(id, probe.id)
      .then((r) => {
        if (wsId === id && r.ok && r.latest) {
          latestDaemonVersion = r.latest;
          latestFetchedForWs = id;
        }
        return undefined;
      })
      // intentional: best-effort version probe; transient failure leaves the badge un-updated and is retried (in-flight guard above)
      .catch(() => undefined)
      .finally(() => {
        isFetchingLatest = false;
      });
  });

  function accessCount(daemon: Daemon): number {
    return daemonState.accessUserIds(daemon.id).length;
  }

  function isActive(id: string): boolean {
    return activeDaemonId === id;
  }

  // ── Mobile: platform tile glyph ──────────────────────────────────────────
  // Returns the correct SVG path string for the platform glyph. Supports
  // "darwin" / "macos" → Apple, "linux" → Tux penguin outline,
  // "win32" / "windows" → Windows grid. Falls back to server-rack outline.
  function platformGlyph(platform: string | undefined): "apple" | "linux" | "windows" | "server" {
    if (!platform) return "server";
    const p = platform.toLowerCase();
    if (p === "darwin" || p === "macos" || p === "mac") return "apple";
    if (p === "linux") return "linux";
    if (p === "win32" || p === "windows" || p === "win") return "windows";
    return "server";
  }

  // ── Mobile: "…" action menu ──────────────────────────────────────────────
  // One sheet is shared; opening a row sets the target daemon.
  let actionSheetOpen = $state(false);
  let actionTarget = $state<Daemon | null>(null);
  let actionBusy = $state(false);
  let actionError = $state<string | null>(null);

  // Remove-access confirm state.
  let removeSheetOpen = $state(false);

  function openActions(daemon: Daemon, e: MouseEvent | TouchEvent): void {
    e.stopPropagation();
    actionTarget = daemon;
    actionError = null;
    actionBusy = false;
    actionSheetOpen = true;
  }

  async function confirmRemoveAccess(): Promise<void> {
    const wsId = workspaceState.current?.id;
    const uid = currentUserId;
    if (!actionTarget || !wsId || !uid || actionBusy) return;
    actionBusy = true;
    actionError = null;
    try {
      await client.revokeDaemonAccess(wsId, actionTarget.id, uid);
      // Refresh daemon list + access grants so the row/access entry is removed.
      const [daemonsResp, accessResp] = await Promise.all([
        client.listDaemons(wsId),
        client.fetchDaemonAccess(wsId).catch(() => ({ access: [] })),
      ]);
      daemonState.load(daemonsResp.daemons, accessResp.access);
    } catch (err) {
      actionError = err instanceof Error ? err.message : "Failed to remove access.";
      actionBusy = false;
      return;
    }
    removeSheetOpen = false;
    actionTarget = null;
    actionBusy = false;
  }
</script>

<!-- ── Desktop branch (byte-identical to the original) ────────────────────── -->
{#if !viewportState.isMobile}
  <aside
    class="relative flex h-full w-[var(--panel-default)] min-w-[var(--panel-default)] flex-col shrink-0 min-h-0 bg-sidebar-bg border-r border-solid border-r-edge-dim overflow-hidden"
  >
    <div class="shrink-0 px-4 pt-3 pb-2 flex items-center justify-between">
      <span class="text-white text-[15px] font-bold">Daemons</span>
      <div class="flex items-center gap-2">
        {#if outdatedCount > 0}
          <!-- Aggregate update nudge (#663): click a daemon to open its detail
               and run the one-click update. -->
          <span
            class="flex items-center gap-1 rounded-full px-[7px] py-[1px] text-[11px] font-semibold tabular-nums"
            style="color: var(--health-watching-text, #d97706); background: color-mix(in srgb, var(--health-watching-text, #d97706) 14%, transparent);"
            title="{outdatedCount} daemon{outdatedCount === 1 ? '' : 's'} can be updated — open a daemon to update it"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
            {outdatedCount} outdated
          </span>
        {/if}
        {#if daemons.length > 0}
          <span class="text-[11px] text-content-dim tabular-nums">{daemons.length}</span>
        {/if}
      </div>
    </div>

    <ScrollArea class="flex-1 min-h-0">
      <div class="px-2 pb-3 flex flex-col gap-0.5">
        {#if daemons.length === 0}
          <div class="px-2 py-3 text-[12px] leading-relaxed text-content-muted">
            No daemons in this workspace yet. Start a daemon and connect it to the relay to see it
            here.
          </div>
        {:else}
          {#each daemons as daemon (daemon.id)}
            {@const online = daemonState.isOnline(daemon.id)}
            {@const owned = daemon.ownerId === currentUserId}
            <button
              type="button"
              onclick={() => { viewportState.closeDrawer(); selectDaemon(daemon.id); }}
              class={cn(
                "group/daemon w-full flex items-start gap-2.5 px-2.5 py-2 rounded-md cursor-pointer text-left transition-colors touch-target-row",
                isActive(daemon.id)
                  ? "bg-[var(--sidebar-active)] text-[var(--sidebar-active-text)]"
                  : "hover:bg-hover-gray text-sidebar-gray",
              )}
            >
              <span
                class={cn(
                  "mt-1 h-2 w-2 rounded-full shrink-0",
                  online ? "bg-online" : "bg-content-dim",
                )}
              ></span>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1.5">
                  <span class="truncate text-[13px] font-medium">{daemon.label}</span>
                  {#if owned}
                    <span
                      class="shrink-0 rounded bg-surface-alt px-1 text-[9px] uppercase leading-[14px] tracking-wide text-content-muted"
                      >You</span
                    >
                  {/if}
                </div>
                <div class="truncate text-[11px] text-content-muted">{locationLabel(daemon)}</div>
                <div class="mt-0.5 flex items-center gap-2 text-[10px] text-content-dim">
                  <span>{online ? "Online" : "Offline"}</span>
                  <TooltipProvider>
                    <Tooltip>
                      <!-- child snippet: render the trigger as the span itself —
                           the default trigger is a <button>, which would nest
                           inside the daemon row button (invalid HTML / a11y). -->
                      <TooltipTrigger>
                        {#snippet child({ props })}
                          <span {...props} class="flex items-center gap-1">
                            <svg
                              width="10"
                              height="10"
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="1.5"
                            >
                              <circle cx="6" cy="5" r="2.5" />
                              <path d="M1.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" />
                            </svg>
                            {accessCount(daemon)}
                          </span>
                        {/snippet}
                      </TooltipTrigger>
                      <TooltipContent side="right" class="text-xs">
                        {accessCount(daemon)} with access
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  {#if daemon.meta?.cyboInstalled}
                    <span class="rounded bg-surface-alt px-1 leading-[14px] text-content-muted"
                      >cybo</span
                    >
                  {/if}
                </div>
              </div>
            </button>
          {/each}
        {/if}
      </div>
    </ScrollArea>
  </aside>

<!-- ── Mobile branch: iOS-style grouped card rows ─────────────────────────── -->
{:else}
  <aside
    class="relative flex h-full flex-col min-h-0 bg-surface overflow-hidden"
  >
    <!-- Header: 22px bold "Daemons" + count badge + 44pt "+" add button -->
    <div class="shrink-0 flex items-center justify-between px-4 pt-5 pb-3" style="padding-top: max(1.25rem, var(--sat));">
      <div class="flex items-center gap-2.5">
        <span class="text-[22px] font-bold leading-tight text-content">Daemons</span>
        {#if daemons.length > 0}
          <span
            class="flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-surface-alt px-[6px] text-[13px] font-semibold tabular-nums text-content-muted"
          >{daemons.length}</span>
        {/if}
      </div>
      <!-- 44pt "+" add button: navigates to /agents (Daemon sub-tab) so the user
           can see the connect-daemon instructions. Daemons connect themselves via
           the cyborg CLI; there is no server-side "add daemon" flow. -->
      <button
        type="button"
        aria-label="Connect a daemon"
        onclick={() => {
          const wsId = workspaceState.current?.id;
          viewportState.closeDrawer();
          if (wsId) void goto(`/workspace/${wsId}/agents`);
        }}
        class="daemon-add-btn flex h-[44px] w-[44px] items-center justify-center rounded-full text-accent transition-colors active:opacity-60"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>

    <!-- Daemon list: grouped card rows -->
    <div class="flex-1 min-h-0 overflow-y-auto px-4 pb-4 flex flex-col gap-3">
      {#if daemons.length === 0}
        <!-- Empty state: iOS-style centered card -->
        <div class="mt-8 flex flex-col items-center gap-3 rounded-2xl bg-surface-alt px-6 py-8 text-center">
          <!-- Server-rack icon -->
          <span class="flex h-[56px] w-[56px] items-center justify-center rounded-full bg-hover-gray text-content-dim">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="4" width="20" height="6" rx="2"/>
              <rect x="2" y="14" width="20" height="6" rx="2"/>
              <path d="M6 7h.01M6 17h.01"/>
            </svg>
          </span>
          <p class="text-[15px] font-semibold text-content">No daemons yet</p>
          <p class="text-[13px] leading-relaxed text-content-muted">
            Start a daemon on a machine and connect it to the relay to see it here.
          </p>
        </div>
      {:else}
        <!-- Grouped card: all rows share one rounded card container -->
        <div class="daemon-card overflow-hidden rounded-2xl bg-surface-alt">
          {#each daemons as daemon, i (daemon.id)}
            {@const online = daemonState.isOnline(daemon.id)}
            {@const owned = daemon.ownerId === currentUserId}
            {@const active = isActive(daemon.id)}
            {@const glyph = platformGlyph(daemon.meta?.platform)}
            {@const loc = locationLabel(daemon)}
            {@const count = accessCount(daemon)}
            {@const hasCybo = !!daemon.meta?.cyboInstalled}
            <!-- Row: div[role=button] so the trailing <button> isn't nested inside
                 a <button> (invalid HTML). ConversationRow uses the same pattern. -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              role="button"
              tabindex="0"
              aria-label={daemon.label}
              aria-pressed={active}
              onclick={() => { viewportState.closeDrawer(); selectDaemon(daemon.id); }}
              onkeydown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  viewportState.closeDrawer();
                  selectDaemon(daemon.id);
                }
              }}
              class={cn(
                "daemon-row relative w-full min-h-[64px] flex items-center gap-3 px-4 py-3 text-left transition-colors active:bg-hover-gray",
                active && "bg-accent/10",
                i > 0 && "border-t border-edge-dim/50",
              )}
            >
              <!-- Platform tile: 40×40 rounded-[10px], status dot overlay -->
              <div class="relative shrink-0">
                <div
                  class={cn(
                    "flex h-[40px] w-[40px] items-center justify-center rounded-[10px]",
                    online ? "bg-online/15 text-online" : "bg-content-dim/10 text-content-dim",
                  )}
                >
                  {#if glyph === "apple"}
                    <!-- Apple logo mark (stylised path) -->
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.7 9.05 7.44c1.32.06 2.22.73 3 .77 1.14-.23 2.22-.92 3.45-.83 1.45.12 2.55.73 3.27 1.85-2.93 1.76-2.37 5.78.28 6.88-.58 1.43-1.3 2.86-2 3.17zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
                    </svg>
                  {:else if glyph === "linux"}
                    <!-- Tux penguin simplified outline -->
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <ellipse cx="12" cy="10" rx="5" ry="6"/>
                      <path d="M7 16c-2 1.5-2 4 1 5h8c3-1 3-3.5 1-5"/>
                      <circle cx="10" cy="9" r="1" fill="currentColor"/>
                      <circle cx="14" cy="9" r="1" fill="currentColor"/>
                    </svg>
                  {:else if glyph === "windows"}
                    <!-- Windows grid -->
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                      <path d="M3 5.6L10.5 4v7H3V5.6zm0 12.8L10.5 20v-7H3v4.8zm8.5 1.7L21 22V13h-9.5v7.1zM11.5 4v7H21V2L11.5 4z"/>
                    </svg>
                  {:else}
                    <!-- Server rack fallback -->
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="2" y="4" width="20" height="6" rx="2"/>
                      <rect x="2" y="14" width="20" height="6" rx="2"/>
                      <path d="M6 7h.01M6 17h.01"/>
                    </svg>
                  {/if}
                </div>
                <!-- 10px status dot pinned bottom-right of the tile -->
                <span
                  class={cn(
                    "absolute -bottom-[2px] -right-[2px] h-[10px] w-[10px] rounded-full border-[1.5px] border-surface-alt",
                    online ? "bg-online" : "bg-content-dim",
                  )}
                ></span>
              </div>

              <!-- Text column -->
              <div class="flex-1 min-w-0">
                <!-- Name + YOU pill + active checkmark -->
                <div class="flex items-center gap-1.5">
                  <span
                    class={cn(
                      "truncate text-[16px] font-semibold leading-[21px]",
                      active ? "text-accent" : "text-content",
                    )}
                  >{daemon.label}</span>
                  {#if owned}
                    <span
                      class="shrink-0 rounded-[4px] bg-accent/20 px-[5px] py-[1px] text-[10px] font-semibold uppercase tracking-wide text-accent"
                    >YOU</span>
                  {/if}
                  {#if active}
                    <!-- iOS-style accent checkmark for selected daemon -->
                    <svg class="ml-auto shrink-0 text-accent" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M5 12l5 5 9-9"/>
                    </svg>
                  {/if}
                </div>
                <!-- Second line: host · platform · N members -->
                <div class="mt-[2px] flex items-center gap-1.5 text-[13px] leading-[18px] text-content-muted">
                  <span class="truncate">{loc}</span>
                  <span class="shrink-0 text-content-dim">·</span>
                  <span class="shrink-0 tabular-nums">{count} {count === 1 ? "member" : "members"}</span>
                  {#if hasCybo}
                    <span class="shrink-0 rounded-[4px] bg-surface-alt px-[5px] py-[1px] text-[10px] font-medium text-content-muted leading-[15px]">cybo</span>
                  {/if}
                </div>
              </div>

              <!-- Trailing "…" action button: 44×44pt touch target.
                   Only shown for non-owners — owners have no applicable actions
                   in this sheet (daemon management lives in Settings › AI).
                   stopPropagation prevents the row's onclick (selectDaemon) from
                   also firing when the user taps "…". -->
              {#if !owned}
                <button
                  type="button"
                  aria-label="Daemon options"
                  onclick={(e) => openActions(daemon, e)}
                  class="daemon-more-btn -mr-1 flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full text-content-muted transition-colors active:bg-hover-gray"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <circle cx="5" cy="12" r="1.5"/>
                    <circle cx="12" cy="12" r="1.5"/>
                    <circle cx="19" cy="12" r="1.5"/>
                  </svg>
                </button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </aside>

  <!-- ── "…" action sheet ──────────────────────────────────────────────────── -->
  <!-- Uses MobileSheet for the established iOS bottom-sheet idiom. Only opened
       for non-owner daemons (the "…" button is hidden for owned daemons).
       "Remove access" calls revokeDaemonAccess then re-fetches the daemon list. -->
  <MobileSheet bind:open={actionSheetOpen} title={actionTarget?.label ?? "Daemon"} maxHeight="60vh">
    <div class="flex flex-col gap-1 pb-1">
      <!-- Remove access -->
      <button
        type="button"
        onclick={() => { actionSheetOpen = false; removeSheetOpen = true; }}
        class="action-row flex items-center gap-3 rounded-xl px-1 py-3.5 text-[17px] text-error active:bg-hover-gray"
      >
        <span class="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-error/10 text-error">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
        </span>
        <span>Remove access</span>
      </button>
    </div>
  </MobileSheet>

  <!-- ── Remove-access confirm sheet ───────────────────────────────────────── -->
  <MobileSheet bind:open={removeSheetOpen} title="Remove access?" maxHeight="50vh">
    <div class="flex flex-col gap-3 py-2">
      <p class="text-[14px] leading-relaxed text-content-muted">
        You'll lose access to <span class="font-semibold text-content">{actionTarget?.label ?? "this daemon"}</span>. The daemon owner can re-grant access later.
      </p>
      {#if actionError}
        <p class="text-[13px] text-error">{actionError}</p>
      {/if}
      <button
        type="button"
        onclick={confirmRemoveAccess}
        disabled={actionBusy}
        class="w-full rounded-xl bg-error py-3.5 text-[16px] font-semibold text-white transition-opacity disabled:opacity-50 active:opacity-70"
      >
        {actionBusy ? "Removing…" : "Remove access"}
      </button>
      <button
        type="button"
        onclick={() => { removeSheetOpen = false; actionError = null; }}
        class="w-full rounded-xl bg-surface-alt py-3.5 text-[16px] font-semibold text-content active:opacity-70"
      >
        Cancel
      </button>
    </div>
  </MobileSheet>
{/if}

<style>
  /* Pressable feedback for daemon rows — matches ConversationRow's pressable-row
     pattern. The active: variant handles the tap flash; transition-colors keeps
     the accent-tint state change smooth. */
  .daemon-row {
    -webkit-tap-highlight-color: transparent;
    cursor: pointer;
  }

  /* "…" button: no default button chrome in WebKit */
  .daemon-more-btn,
  .daemon-add-btn {
    -webkit-tap-highlight-color: transparent;
    -webkit-appearance: none;
    appearance: none;
    background: none;
    border: none;
    cursor: pointer;
  }

  /* Action-sheet rows: clear default button chrome */
  .action-row {
    -webkit-tap-highlight-color: transparent;
    -webkit-appearance: none;
    appearance: none;
    background: none;
    border: none;
    cursor: pointer;
    width: 100%;
    text-align: left;
  }
</style>
