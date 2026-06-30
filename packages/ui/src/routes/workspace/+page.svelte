<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { cn } from "$lib/utils.js";
  import {
    client,
    workspaceState,
    selectWorkspace,
    createWorkspace,
    authState,
    connectToServer,
    getSavedSession,
    clearSavedSession,
    connectionState,
    AuthError,
  } from "$lib/state/app.svelte.js";
  import { getInitials } from "$lib/utils.js";
  import { isTauriIOS } from "$lib/mobile/push.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import Splash from "$lib/components/Splash.svelte";

  interface WsDaemonInfo {
    count: number;
    ownsDaemon: boolean;
    hasAgentAccess: boolean;
  }

  let restoring = $state(false);
  let restoreAttempted = false;
  // Counts consecutive transient connect failures during cold-start restore, so
  // the splash can offer a manual escape if the relay stays unreachable instead
  // of spinning on "Connecting…" forever (mirrors workspace/[id]/+layout).
  let restoreAttempts = $state(0);
  // In-flight guard so a rapid double-click on the escape hatch can't fire
  // clearSavedSession()/goto() twice.
  let loggingOut = $state(false);
  let daemonInfo = $state<Record<string, WsDaemonInfo>>({});
  // The id of the workspace currently being entered, so the clicked card shows a
  // spinner (selectWorkspace → goto is async and gave NO feedback → looked frozen).
  let selectingId = $state<string | null>(null);
  let showCreate = $state(false);
  let newName = $state("");
  let creating = $state(false);
  let createError = $state("");

  // Guided 2-step create wizard (additive). Step 1 = name (+ optional
  // description); Step 2 = optional visibility note + confirm. After a
  // successful create we show a brief "invite members?" screen instead of
  // bouncing straight into the workspace. Description/visibility are collected
  // for the guided feel but, since the create RPC only persists the name today,
  // they're presentational — the workspace is still created via the existing
  // createWorkspace(name) path (no behavior regression).
  let createStep = $state<1 | 2>(1);
  let newDescription = $state("");
  let newVisibility = $state<"private" | "public">("private");
  let createdWorkspace = $state<{ id: string; name: string } | null>(null);

  function resetCreate() {
    showCreate = false;
    createStep = 1;
    newName = "";
    newDescription = "";
    newVisibility = "private";
    createError = "";
    createdWorkspace = null;
  }

  $effect(() => {
    if (!authState.authenticated && !restoreAttempted) {
      restoreAttempted = true;
      void tryRestore();
    }
  });

  $effect(() => {
    if (authState.authenticated && workspaceState.list.length > 0) {
      void loadDaemonInfo();
    }
  });

  // Solo-workspace UX: if the user has exactly one workspace, skip this picker
  // and drop straight into it on app start (most users only ever have one). The
  // "Add workspace" entry point (WorkspaceSwitcher) navigates here with ?new=1,
  // which opts OUT of the redirect so single-workspace users can still create
  // another instead of getting bounced right back in.
  let autoRedirected = false;
  $effect(() => {
    if (autoRedirected) return;
    if (!authState.authenticated) return;
    if (page.url.searchParams.has("new")) return;
    const list = workspaceState.list;
    if (list.length === 1) {
      autoRedirected = true;
      const only = list[0];
      selectWorkspace(only)
        // Mobile: land on Home tab (same rationale as handleSelect).
        .then(() => goto(viewportState.isMobile ? `/workspace/${only.id}/chats` : `/workspace/${only.id}`))
        .catch(() => {
          autoRedirected = false;
        });
    }
  });

  // Show the cold-start splash (not the picker) whenever we're mid-restore or
  // about to auto-enter the single workspace, so the picker never flashes past:
  //  - restoring                              → session being restored
  //  - have a saved session but not authed    → first-frame restore window
  //  - authed + 1 workspace + not ?new        → auto-redirect in flight
  // Genuine multi-/zero-workspace and ?new visits fall through to the picker.
  const showSplash = $derived(
    restoring ||
      (!authState.authenticated && getSavedSession() !== null) ||
      (authState.authenticated &&
        !page.url.searchParams.has("new") &&
        workspaceState.list.length === 1),
  );

  // Arriving via "Add workspace" (?new=1): open the create form straight away.
  // Must be a reactive $effect, not onMount — SvelteKit reuses this component
  // across /workspace ↔ /workspace?new=1, so onMount wouldn't re-fire when the
  // user cancels (back to /workspace) and clicks "Add workspace" again. The
  // effect tracks the query param, so it reopens the form on every ?new=1 visit.
  $effect(() => {
    if (page.url.searchParams.has("new")) showCreate = true;
  });

  // iOS cold-launch deep-link drain (Caveat #3). A notification-tap that
  // cold-launches the app lands HERE (root → /workspace list), but the live
  // drain lives in workspace/[id]/+layout, which only mounts AFTER the user
  // opens a workspace — so a cold-launch tap was stranded on the list until a
  // manual tap. Drain the persisted URL here too and route straight to the
  // target. get_pending_deep_link clears the key on read, so the [id] layout
  // can't double-navigate. iOS-only; no-op on web/desktop/Android.
  let deepLinkDrained = false;
  $effect(() => {
    if (!isTauriIOS() || deepLinkDrained) return;
    if (!authState.authenticated) return;
    deepLinkDrained = true;
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        // Use the SAME plugin command + { url } shape as the workspace/[id] layout
        // drain. The legacy host `get_pending_deep_link` no longer exists in the new
        // plugin — invoking it here THREW, so a cold-launch notification tap never
        // routed and got stranded on this list (daemon/agents view) instead of
        // opening the message. (Mirror of routes/workspace/[id]/+layout.svelte.)
        const pending = await invoke<{ url: string | null } | string | null>(
          "plugin:cyborg-push|get_pending_launch_url",
        );
        const url = typeof pending === "string" ? pending : pending?.url;
        if (url) goto(url);
      } catch (err) {
        console.warn("[deep-link] list drain failed", err);
      }
    })();
  });

  async function loadDaemonInfo(): Promise<void> {
    const userId = authState.user?.id;
    if (!userId) return;
    const results: Record<string, WsDaemonInfo> = {};
    await Promise.all(
      workspaceState.list.map(async (ws) => {
        try {
          const [{ daemons }, { access }] = await Promise.all([
            client.listDaemons(ws.id),
            client.fetchDaemonAccess(ws.id),
          ]);
          const ownsDaemon = daemons.some((d) => d.ownerId === userId);
          const hasAgentAccess = ownsDaemon || access.some((a) => a.userId === userId);
          results[ws.id] = { count: daemons.length, ownsDaemon, hasAgentAccess };
        } catch {
          results[ws.id] = { count: 0, ownsDaemon: false, hasAgentAccess: false };
        }
      }),
    );
    daemonInfo = results;
  }

  async function tryRestore(): Promise<void> {
    const saved = getSavedSession();
    if (!saved) {
      goto("/login");
      return;
    }
    restoring = true;
    // Retry transient relay outages (deploy) instead of logging out. Only a real
    // auth failure clears the session and bounces to login.
    restoreAttempts = 0;
    try {
      for (;;) {
        // Bail if the user logged out / the session was cleared mid-retry, so a
        // late-succeeding connect can't pull them back in.
        if (!getSavedSession()) return;
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
          await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** restoreAttempts, 15_000)));
        }
      }
      restoreAttempts = 0;
    } finally {
      restoring = false;
    }
  }

  // Cold-start escape hatch: a NetworkError loop retries forever (a relay that
  // stays down never throws AuthError), so without this the splash spins on
  // "Connecting…" with no way out. Same affordance as workspace/[id]/+layout.
  function goToLogin(): void {
    if (loggingOut) return;
    loggingOut = true;
    clearSavedSession();
    goto("/login");
  }

  async function handleSelect(ws: typeof workspaceState.list[0]): Promise<void> {
    if (selectingId) return; // ignore re-clicks while a selection is in flight
    selectingId = ws.id;
    try {
      await selectWorkspace(ws);
      // Mobile (boss directive): land on Home tab, not the bare root.
      // The bare root's restore-to-last-channel effect is desktop-only; mobile has
      // a dedicated Home tab and must not bounce straight into a channel on entry.
      await goto(viewportState.isMobile ? `/workspace/${ws.id}/chats` : `/workspace/${ws.id}`);
    } finally {
      // Always clear. On success we navigate away (the reset is harmless), but if
      // selection throws OR goto resolves false (SvelteKit returns false on an
      // aborted/redirected navigation instead of throwing), this frees the card so
      // it isn't stuck spinning forever.
      selectingId = null;
    }
  }

  async function handleCreate(): Promise<void> {
    const name = newName.trim();
    if (!name || creating) return;
    creating = true;
    createError = "";
    try {
      const ws = await createWorkspace(name);
      // Pre-select so both "Enter workspace" and "Invite members" land in it.
      await selectWorkspace(ws);
      createdWorkspace = { id: ws.id, name: ws.name };
    } catch (e) {
      createError = e instanceof Error ? e.message : "Failed to create workspace";
    } finally {
      creating = false;
    }
  }

  function enterCreatedWorkspace(): void {
    const id = createdWorkspace?.id;
    resetCreate();
    // Mobile: land on Home tab (same rationale as handleSelect above).
    if (id) goto(viewportState.isMobile ? `/workspace/${id}/chats` : `/workspace/${id}`);
  }

  function inviteToCreatedWorkspace(): void {
    const id = createdWorkspace?.id;
    resetCreate();
    if (id) goto(`/workspace/${id}/settings/members`);
  }

  // Loading skeleton: show placeholders when authenticated but list hasn't
  // populated yet (brief flash between auth restore and first ws:list response).
  const showSkeleton = $derived(
    authState.authenticated && workspaceState.list.length === 0 && !showCreate,
  );
</script>

{#if showSplash}
  <Splash />
  {#if restoreAttempts >= 3}
    <!-- Escape hatch over the cold-start splash: a NetworkError retry loop never
         resolves on its own when the relay stays down, so offer a manual way out
         instead of an unexplained infinite spinner. Same copy/affordance as the
         workspace/[id]/+layout "taking longer than usual" screen. -->
    <div
      class="fixed inset-x-0 z-[calc(var(--z-modal)+1)] flex flex-col items-center gap-2 px-6 text-center text-xs text-content-muted"
      style="bottom: max(env(safe-area-inset-bottom, 0px), 24px); padding-bottom: 48px;"
    >
      <span>This is taking longer than usual.</span>
      <button type="button" class="text-link hover:underline" disabled={loggingOut} onclick={goToLogin}>Log in again</button>
    </div>
  {/if}
{:else if viewportState.isMobile}
<!-- ── iOS / mobile branch — new redesign ───────────────────────────────────── -->
<!-- Top-aligned layout — content starts in the upper portion, not vertically
     centred. Responsive: full-width on mobile, centered column on desktop. -->
<div class="min-h-full bg-[color:var(--bg-base)]">
  <div class="mx-auto w-full max-w-md px-4 pb-10" style="padding-top: max(calc(env(safe-area-inset-top, 0px) + 24px), 36px);">

    <h1 class="text-[28px] font-bold leading-[34px] tracking-[-0.01em] text-content">Your Workspaces</h1>

    <div class="mt-5 space-y-3">

      <!-- Create workspace -->
      {#if showCreate}
        {#if createdWorkspace}
          <!-- Post-create success: offer to invite before entering. -->
          <div class="overflow-hidden rounded-[14px]" style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);">
            <div class="flex items-start gap-3 px-4 py-4">
              <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-online/15 text-online">
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <div class="min-w-0 flex-1">
                <p class="text-[15px] font-semibold text-content">You created {createdWorkspace.name}</p>
                <p class="mt-0.5 text-[13px] text-content-muted">Invite teammates now, or jump straight in.</p>
                <div class="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onclick={inviteToCreatedWorkspace}
                    class="rounded-[10px] bg-btn-primary-bg px-4 py-2 text-[14px] font-medium text-btn-primary-text transition-colors hover:bg-btn-primary-hover"
                  >
                    Invite members
                  </button>
                  <button
                    type="button"
                    onclick={enterCreatedWorkspace}
                    class="rounded-[10px] border border-edge px-3 py-2 text-[14px] text-content-muted transition-colors hover:bg-surface-alt"
                  >
                    Enter workspace
                  </button>
                </div>
              </div>
            </div>
          </div>
        {:else}
          <div class="overflow-hidden rounded-[14px]" style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);">
            <div class="px-4 pt-4">
              <!-- Progress indicator -->
              <div class="flex items-center justify-between">
                <p class="text-[15px] font-semibold text-content">Create a workspace</p>
                <span class="text-[13px] text-content-muted">Step {createStep} of 2</span>
              </div>
              <div class="mt-2 flex gap-1.5">
                <div class={cn("h-1 flex-1 rounded-full", "bg-btn-primary-bg")}></div>
                <div class={cn("h-1 flex-1 rounded-full", createStep === 2 ? "bg-btn-primary-bg" : "bg-edge")}></div>
              </div>
            </div>

            {#if createStep === 1}
              <form
                onsubmit={(e) => { e.preventDefault(); if (newName.trim()) createStep = 2; }}
                class="space-y-3 px-4 pb-4 pt-3"
              >
                <div class="space-y-1">
                  <label for="ws-name-m" class="text-[12px] font-medium text-content-muted">Name</label>
                  <input
                    id="ws-name-m"
                    bind:value={newName}
                    placeholder="e.g. Acme HQ"
                    class="w-full rounded-[10px] border border-edge bg-[color:var(--bg-base)] px-3 py-2 text-[14px] text-content placeholder:text-content-muted focus:border-btn-primary-bg focus:outline-none"
                  />
                </div>
                <div class="space-y-1">
                  <label for="ws-desc-m" class="text-[12px] font-medium text-content-muted">Description <span class="text-content-dim">(optional)</span></label>
                  <input
                    id="ws-desc-m"
                    bind:value={newDescription}
                    placeholder="What's this workspace for?"
                    class="w-full rounded-[10px] border border-edge bg-[color:var(--bg-base)] px-3 py-2 text-[14px] text-content placeholder:text-content-muted focus:border-btn-primary-bg focus:outline-none"
                  />
                </div>
                <div class="flex items-center gap-2 pt-1">
                  <button
                    type="submit"
                    disabled={!newName.trim()}
                    class="rounded-[10px] bg-btn-primary-bg px-4 py-2 text-[14px] font-medium text-btn-primary-text transition-colors hover:bg-btn-primary-hover disabled:opacity-40"
                  >
                    Next
                  </button>
                  <button
                    type="button"
                    onclick={resetCreate}
                    class="rounded-[10px] border border-edge px-3 py-2 text-[14px] text-content-muted transition-colors hover:bg-surface-alt"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            {:else}
              <form
                onsubmit={(e) => { e.preventDefault(); handleCreate(); }}
                class="space-y-3 px-4 pb-4 pt-3"
              >
                <fieldset class="space-y-2">
                  <legend class="text-[12px] font-medium text-content-muted">Visibility <span class="text-content-dim">(optional)</span></legend>
                  <label class="flex cursor-pointer items-start gap-2 rounded-[10px] border border-edge bg-[color:var(--bg-base)] px-3 py-2 text-[14px]">
                    <input type="radio" name="ws-visibility-m" value="private" bind:group={newVisibility} class="mt-0.5" />
                    <span>
                      <span class="block font-medium text-content">Private</span>
                      <span class="block text-[12px] text-content-muted">Only invited members can join.</span>
                    </span>
                  </label>
                  <label class="flex cursor-pointer items-start gap-2 rounded-[10px] border border-edge bg-[color:var(--bg-base)] px-3 py-2 text-[14px]">
                    <input type="radio" name="ws-visibility-m" value="public" bind:group={newVisibility} class="mt-0.5" />
                    <span>
                      <span class="block font-medium text-content">Public</span>
                      <span class="block text-[12px] text-content-muted">Anyone with the link can request to join.</span>
                    </span>
                  </label>
                </fieldset>
                <div class="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onclick={() => (createStep = 1)}
                    class="rounded-[10px] border border-edge px-3 py-2 text-[14px] text-content-muted transition-colors hover:bg-surface-alt"
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    disabled={creating || !newName.trim()}
                    class="rounded-[10px] bg-btn-primary-bg px-4 py-2 text-[14px] font-medium text-btn-primary-text transition-colors hover:bg-btn-primary-hover disabled:opacity-40"
                  >
                    {creating ? "Creating..." : "Create workspace"}
                  </button>
                </div>
                {#if createError}
                  <p class="text-[12px] text-danger">{createError}</p>
                {/if}
              </form>
            {/if}
          </div>
        {/if}
      {/if}

      <!-- Workspace list -->
      {#if showSkeleton}
        <!-- Loading skeleton: 3 placeholder rows while the workspace list loads. -->
        <div class="overflow-hidden rounded-[14px]" style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);">
          {#each [0, 1, 2] as i (i)}
            {#if i > 0}
              <div class="ml-[76px]" style="height: 0.5px; background: var(--hairline);"></div>
            {/if}
            <div class="flex h-[72px] items-center gap-3 px-4">
              <div class="skeleton h-12 w-12 shrink-0 rounded-[12px]"></div>
              <div class="flex flex-1 flex-col gap-2">
                <div class="skeleton h-[14px] w-2/3 rounded-[6px]"></div>
                <div class="skeleton h-[11px] w-1/3 rounded-[6px]"></div>
              </div>
              <svg class="shrink-0 text-content-dim opacity-30" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
            </div>
          {/each}
        </div>
      {:else if workspaceState.list.length > 0}
        <!-- iOS grouped card: all workspace rows in one rounded card, hairline
             separators between rows (inset to label start), border + shadow
             so the card reads as a card on a white page in light mode. -->
        <div class="overflow-hidden rounded-[14px]" style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);">
          {#each workspaceState.list as ws, i (ws.id)}
            {#if i > 0}
              <!-- Inset hairline separator: offset past the logo tile (16px pad + 48px tile + 12px gap = 76px). -->
              <div class="ml-[76px]" style="height: 0.5px; background: var(--hairline);"></div>
            {/if}
            <button
              onclick={() => handleSelect(ws)}
              disabled={selectingId !== null}
              aria-busy={selectingId === ws.id}
              class="pressable-row flex h-[72px] w-full items-center gap-3 px-4 text-left disabled:cursor-default"
              aria-label={ws.name}
            >
              <!-- 48px logo tile, rounded-[12px] per spec -->
              {#if ws.avatarUrl}
                <img src={ws.avatarUrl} alt={ws.name} class="h-12 w-12 shrink-0 rounded-[12px] object-cover" />
              {:else}
                <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px] bg-teal text-teal-contrast text-[15px] font-bold">
                  {getInitials(ws.name)}
                </div>
              {/if}

              <!-- Name + role / daemon badges -->
              <div class="flex min-w-0 flex-1 flex-col justify-center">
                <span class="truncate text-[17px] font-semibold leading-[22px] text-content">{ws.name}</span>
                <div class="mt-0.5 flex items-center gap-2">
                  <span class="text-[13px] capitalize text-content-muted">{ws.role}</span>
                  {#if daemonInfo[ws.id]}
                    {#if daemonInfo[ws.id].ownsDaemon}
                      <span class="inline-flex items-center gap-1 rounded bg-online/15 px-1.5 py-0.5 text-[10px] font-medium text-online">
                        <svg class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1" fill="currentColor"/><circle cx="6" cy="18" r="1" fill="currentColor"/></svg>
                        Daemon owner
                      </span>
                    {:else if daemonInfo[ws.id].hasAgentAccess}
                      <span class="inline-flex items-center gap-1 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                        <svg class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                        Agent access
                      </span>
                    {:else if daemonInfo[ws.id].count > 0}
                      <span class="text-[10px] text-content-dim">
                        {daemonInfo[ws.id].count} daemon{daemonInfo[ws.id].count !== 1 ? "s" : ""}
                      </span>
                    {/if}
                  {/if}
                </div>
              </div>

              <!-- Chevron, or a spinner while this workspace is being entered -->
              {#if selectingId === ws.id}
                <svg class="h-[18px] w-[18px] shrink-0 animate-spin text-content-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
              {:else}
                <svg class="shrink-0 text-content-muted" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
              {/if}
            </button>
          {/each}
        </div>
      {:else if !showCreate}
        <p class="text-[15px] text-content-muted">No workspaces yet.</p>
      {/if}

      <!-- "Create a new workspace" — plain row, same card style, NOT dashed.
           Only shown when the create form is closed. -->
      {#if !showCreate}
        <button
          onclick={() => (showCreate = true)}
          class="pressable-row flex w-full items-center gap-3 overflow-hidden rounded-[14px] px-4 text-left"
          style="height: 64px; background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);"
        >
          <!-- Plus tile: raised bg, same 48px/rounded-[12px] slot as logo tiles -->
          <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px] bg-surface-alt">
            <svg class="h-5 w-5 text-content-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </div>
          <span class="text-[16px] font-medium text-content-muted">Create a new workspace</span>
        </button>
      {/if}

    </div>
  </div>
</div>
{:else}
<!-- ── Desktop / web branch — pre-redesign design restored ──────────────────── -->
<div class="flex h-full items-center justify-center bg-surface">
  <div class="w-full max-w-md space-y-4 p-8">
    <h1 class="text-lg font-bold text-content">Your Workspaces</h1>

    <!-- Create workspace -->
    {#if showCreate}
      {#if createdWorkspace}
        <!-- Post-create success: offer to invite before entering. -->
        <div class="space-y-3 rounded-lg border border-edge bg-surface-alt/40 p-4">
          <div class="flex items-center gap-2">
            <div class="flex h-8 w-8 items-center justify-center rounded-full bg-online/15 text-online">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <div>
              <p class="text-sm font-medium text-content">You created {createdWorkspace.name}</p>
              <p class="text-xs text-content-muted">Invite teammates now, or jump straight in.</p>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              onclick={inviteToCreatedWorkspace}
              class="rounded-lg bg-btn-primary-bg px-4 py-2 text-sm font-medium text-btn-primary-text hover:bg-btn-primary-hover transition-colors"
            >
              Invite members
            </button>
            <button
              type="button"
              onclick={enterCreatedWorkspace}
              class="rounded-lg border border-edge px-3 py-2 text-sm text-content-muted hover:bg-surface-alt transition-colors"
            >
              Enter workspace
            </button>
          </div>
        </div>
      {:else}
        <div class="space-y-3 rounded-lg border border-edge bg-surface-alt/40 p-4">
          <!-- Progress indicator -->
          <div class="flex items-center justify-between">
            <p class="text-sm font-semibold text-content">Create a workspace</p>
            <span class="text-xs text-content-muted">Step {createStep} of 2</span>
          </div>
          <div class="flex gap-1.5">
            <div class={cn("h-1 flex-1 rounded-full", "bg-btn-primary-bg")}></div>
            <div class={cn("h-1 flex-1 rounded-full", createStep === 2 ? "bg-btn-primary-bg" : "bg-edge")}></div>
          </div>

          {#if createStep === 1}
            <form
              onsubmit={(e) => { e.preventDefault(); if (newName.trim()) createStep = 2; }}
              class="space-y-3"
            >
              <div class="space-y-1">
                <label for="ws-name" class="text-xs font-medium text-content-muted">Name</label>
                <input
                  id="ws-name"
                  bind:value={newName}
                  placeholder="e.g. Acme HQ"
                  class="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-content placeholder:text-content-muted focus:border-btn-primary-bg focus:outline-none"
                />
              </div>
              <div class="space-y-1">
                <label for="ws-desc" class="text-xs font-medium text-content-muted">Description <span class="text-content-dim">(optional)</span></label>
                <input
                  id="ws-desc"
                  bind:value={newDescription}
                  placeholder="What's this workspace for?"
                  class="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-content placeholder:text-content-muted focus:border-btn-primary-bg focus:outline-none"
                />
              </div>
              <div class="flex items-center gap-2 pt-1">
                <button
                  type="submit"
                  disabled={!newName.trim()}
                  class="rounded-lg bg-btn-primary-bg px-4 py-2 text-sm font-medium text-btn-primary-text hover:bg-btn-primary-hover disabled:opacity-40 transition-colors"
                >
                  Next
                </button>
                <button
                  type="button"
                  onclick={resetCreate}
                  class="rounded-lg border border-edge px-3 py-2 text-sm text-content-muted hover:bg-surface-alt transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          {:else}
            <form
              onsubmit={(e) => { e.preventDefault(); handleCreate(); }}
              class="space-y-3"
            >
              <fieldset class="space-y-2">
                <legend class="text-xs font-medium text-content-muted">Visibility <span class="text-content-dim">(optional)</span></legend>
                <label class="flex cursor-pointer items-start gap-2 rounded-lg border border-edge bg-surface px-3 py-2 text-sm">
                  <input type="radio" name="ws-visibility" value="private" bind:group={newVisibility} class="mt-0.5" />
                  <span>
                    <span class="block font-medium text-content">Private</span>
                    <span class="block text-xs text-content-muted">Only invited members can join.</span>
                  </span>
                </label>
                <label class="flex cursor-pointer items-start gap-2 rounded-lg border border-edge bg-surface px-3 py-2 text-sm">
                  <input type="radio" name="ws-visibility" value="public" bind:group={newVisibility} class="mt-0.5" />
                  <span>
                    <span class="block font-medium text-content">Public</span>
                    <span class="block text-xs text-content-muted">Anyone with the link can request to join.</span>
                  </span>
                </label>
              </fieldset>
              <div class="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onclick={() => (createStep = 1)}
                  class="rounded-lg border border-edge px-3 py-2 text-sm text-content-muted hover:bg-surface-alt transition-colors"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={creating || !newName.trim()}
                  class="rounded-lg bg-btn-primary-bg px-4 py-2 text-sm font-medium text-btn-primary-text hover:bg-btn-primary-hover disabled:opacity-40 transition-colors"
                >
                  {creating ? "Creating..." : "Create workspace"}
                </button>
              </div>
            </form>
          {/if}

          {#if createError}
            <p class="text-xs text-danger">{createError}</p>
          {/if}
        </div>
      {/if}
    {:else}
      <button
        onclick={() => (showCreate = true)}
        class="flex w-full items-center gap-3 rounded-lg border border-dashed border-edge p-4 hover:border-edge-light hover:bg-surface-alt/50 transition-colors text-left"
      >
        <div class="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-alt">
          <svg class="h-5 w-5 text-content-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </div>
        <span class="text-sm font-medium text-content-muted">Create a new workspace</span>
      </button>
    {/if}

    {#if workspaceState.list.length === 0}
      <p class="text-sm text-content-muted">No workspaces yet.</p>
    {:else}
      <div class="space-y-2">
        {#each workspaceState.list as ws (ws.id)}
          <button
            onclick={() => handleSelect(ws)}
            disabled={selectingId !== null}
            aria-busy={selectingId === ws.id}
            class="flex w-full items-center gap-3 rounded-lg bg-surface-alt border border-edge p-4 hover:border-edge-light transition-colors text-left disabled:cursor-default"
          >
            {#if ws.avatarUrl}
              <img src={ws.avatarUrl} alt={ws.name} class="h-10 w-10 rounded-lg object-cover" />
            {:else}
              <div class="flex h-10 w-10 items-center justify-center rounded-lg bg-teal text-teal-contrast font-bold text-sm">
                {getInitials(ws.name)}
              </div>
            {/if}
            <div class="flex-1 min-w-0">
              <div class="font-medium text-content text-sm">{ws.name}</div>
              <div class="flex items-center gap-2 mt-0.5">
                <span class="text-xs text-content-dim">{ws.role}</span>
                {#if daemonInfo[ws.id]}
                  {#if daemonInfo[ws.id].ownsDaemon}
                    <span class="inline-flex items-center gap-1 text-[10px] font-medium text-online bg-online/10 px-1.5 py-0.5 rounded">
                      <svg class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1" fill="currentColor"/><circle cx="6" cy="18" r="1" fill="currentColor"/></svg>
                      Daemon owner
                    </span>
                  {:else if daemonInfo[ws.id].hasAgentAccess}
                    <span class="inline-flex items-center gap-1 text-[10px] font-medium text-btn-primary-bg bg-btn-primary-bg/10 px-1.5 py-0.5 rounded">
                      <svg class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                      Agent access
                    </span>
                  {:else if daemonInfo[ws.id].count > 0}
                    <span class="text-[10px] text-content-dim">
                      {daemonInfo[ws.id].count} daemon{daemonInfo[ws.id].count !== 1 ? "s" : ""}
                    </span>
                  {/if}
                {/if}
              </div>
            </div>
            {#if selectingId === ws.id}
              <!-- Entering this workspace: spinner so the click isn't silent. -->
              <svg class="h-4 w-4 shrink-0 animate-spin text-content-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>
{/if}
