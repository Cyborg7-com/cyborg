<script lang="ts">
  import { goto } from "$app/navigation";
  import {
    workspaceState,
    daemonState,
    cyboState,
    authState,
    client,
    createAgent,
    spawnCybo,
    sendAgentPrompt,
    fetchCybos,
    fetchRecentCwds,
  } from "$lib/state/app.svelte.js";
  import { terminalSessionsState, terminalTitle } from "$lib/state/terminal-sessions.svelte.js";
  import type { Cybo, ProviderInfo } from "$lib/plugins/agents/types.js";
  import ProviderIcon from "$lib/plugins/agents/components/ProviderIcon.svelte";
  import CyborgIcon from "$lib/components/CyborgIcon.svelte";
  import ModelCombobox from "$lib/components/agents/components/ModelCombobox.svelte";
  import { cn } from "$lib/utils.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog/index.js";
  import { Tabs, TabsContent } from "$lib/components/ui/tabs/index.js";
  import * as Select from "$lib/components/ui/select/index.js";

  // Launches a SESSION: a cybo session (optionally pre-selected) or a bare
  // provider session. Creating a new cybo lives at /agent/new — this dialog only
  // launches running agents.
  let {
    open = $bindable(false),
    initialCyboId = null,
  }: { open?: boolean; initialCyboId?: string | null } = $props();

  const wsId = $derived(workspaceState.current?.id);
  const currentUserId = $derived(authState.user?.id);
  const cybos = $derived(cyboState.list);

  let tab = $state<"cybo" | "provider">("cybo");
  // Selection: a workspace cybo, or a provider id.
  let selectedCyboId = $state<string | null>(null);
  let selectedProviderId = $state<string | null>(null);
  // Terminal (#656): a fixed launcher option in the provider tab that is NOT a
  // registry provider — it starts a daemon-scoped terminal session instead of an
  // agent. Mutually exclusive with selectedProviderId.
  let selectedTerminal = $state(false);
  // Optional starting model for a bare provider session (null = provider default).
  let selectedModel = $state<string | null>(null);
  let launching = $state(false);
  let error = $state("");

  // ── Daemon: where the session runs (defaults to the global selection) ──
  let daemonId = $state<string | null>(null);
  const daemons = $derived(daemonState.list);
  const selectedDaemon = $derived(daemonId ? daemonState.byId(daemonId) : undefined);
  function daemonUsable(id: string): boolean {
    return (
      daemonState.isOnline(id) &&
      !!currentUserId &&
      daemonState.accessUserIds(id).includes(currentUserId)
    );
  }
  // Warn at the LAUNCH point when the target daemon isn't the user's own — so a
  // session/cybo is never created on a teammate's machine by accident.
  const selectedDaemonForeign = $derived(
    !!selectedDaemon && !!currentUserId && selectedDaemon.ownerId !== currentUserId,
  );
  const selectedDaemonHasAccess = $derived(
    !!daemonId && !!currentUserId && daemonState.accessUserIds(daemonId).includes(currentUserId),
  );
  const selectedDaemonOwnerName = $derived.by(() => {
    if (!selectedDaemon) return "another user";
    const m = workspaceState.members.find((mm) => mm.userId === selectedDaemon.ownerId);
    return m?.name ?? m?.email ?? "another user";
  });

  let openedOnce = $state(false);
  // Transition guard: only seed when the dialog goes closed → open. The seed
  // reads reactive daemon state (effectiveId), so without the guard any
  // background daemon-status update would re-run this and wipe the user's
  // in-dialog selections.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      // (Re)seed on every open: default daemon + optional cybo preselect.
      daemonId = daemonState.effectiveId(currentUserId);
      selectedCyboId = initialCyboId;
      selectedProviderId = null;
      selectedTerminal = false;
      selectedModel = null;
      // Mode follows the entry point: a cybo preselect launches a cybo; the bare
      // "Agent session" button (no preselect) is a provider-CLI session.
      tab = initialCyboId ? "cybo" : "provider";
      error = "";
      cwdEditorOpen = false;
      if (!openedOnce) {
        openedOnce = true;
        void fetchCybos();
      }
    }
    wasOpen = open;
  });

  // ── Providers for the selected daemon, kept LOCAL (the global providerState
  //    is owned by the Agents pane's unscoped fetch — sharing it races). ──
  let providers = $state<ProviderInfo[]>([]);
  let providersLoading = $state(false);
  let providersLoadedFor = $state<string | null>(null);
  $effect(() => {
    if (open && daemonId && providersLoadedFor !== daemonId) {
      const target = daemonId;
      providersLoadedFor = target;
      providersLoading = true;
      client
        .listProviders({ daemonId: target })
        .then((list) => {
          if (providersLoadedFor === target) providers = list;
          return;
        })
        .catch(() => {
          if (providersLoadedFor === target) providers = [];
        })
        .finally(() => {
          if (providersLoadedFor === target) providersLoading = false;
        });
    }
  });

  const hasSelection = $derived(
    tab === "cybo" ? !!selectedCyboId : !!selectedProviderId || selectedTerminal,
  );
  const canLaunch = $derived(hasSelection && !!daemonId && !launching);

  function pickTerminal() {
    selectedTerminal = true;
    selectedProviderId = null;
    selectedModel = null;
  }
  function pickProvider(id: string) {
    selectedProviderId = id;
    selectedTerminal = false;
    selectedModel = null;
  }

  function pickCybo(c: Cybo) {
    selectedCyboId = c.id;
  }

  // ── Working directory: resolved when the daemon is known (NOT silently at
  //    launch) so the user can see it and change it — the cwd decides which
  //    files the session can touch. ──
  let cwd = $state("");
  let cwdHome = $state("");
  let recentCwds = $state<string[]>([]);
  let cwdEditorOpen = $state(false);
  let cwdLoadedFor = $state<string | null>(null);
  $effect(() => {
    if (!open) {
      // Re-seed on the next open: a stale or hand-edited cwd from the previous
      // session must not leak into a new launch, and recents may have changed.
      cwdLoadedFor = null;
      return;
    }
    if (daemonId && cwdLoadedFor !== daemonId) {
      const target = daemonId;
      cwdLoadedFor = target;
      fetchRecentCwds(target)
        .then(({ home, recent }) => {
          // Paths are per-machine: switching daemons resets to that home.
          if (cwdLoadedFor === target) {
            cwdHome = home;
            recentCwds = recent;
            cwd = home || "~";
          }
          return;
        })
        .catch(() => {
          if (cwdLoadedFor === target) {
            cwdHome = "";
            recentCwds = [];
            cwd = "~";
          }
        });
    }
  });

  function shortenPath(p: string): string {
    if (!cwdHome) return p;
    if (p === cwdHome) return "~";
    // Only shorten real subpaths — a bare startsWith would turn a sibling like
    // /Users/johnson into "~son" when home is /Users/john.
    const separator = cwdHome.includes("\\") ? "\\" : "/";
    const prefix = cwdHome.endsWith(separator) ? cwdHome : cwdHome + separator;
    if (p.startsWith(prefix)) return "~" + separator + p.slice(prefix.length);
    return p;
  }

  async function launch(): Promise<void> {
    if (!canLaunch || !wsId || !daemonId) return;
    launching = true;
    error = "";
    try {
      const dir = cwd.trim() || cwdHome || "~";
      // Terminal (#656): start a daemon-scoped terminal session and route to its
      // view (TerminalView, #655) instead of the agent chat. cols/rows are a seed
      // (80×24); TerminalView sends a real resize once its xterm fit() runs.
      if (tab === "provider" && selectedTerminal) {
        const { terminalId } = await client.startTerminal(wsId, {
          daemonId,
          cwd: dir,
          cols: 80,
          rows: 24,
        });
        // Track the live (daemon-scoped, non-PG) session client-side so it shows
        // under "Terminals" in the sidebar and the user can return to it after
        // switching tabs (#701). Title = cwd basename, else "Terminal".
        terminalSessionsState.add({
          terminalId,
          daemonId,
          workspaceId: wsId,
          title: terminalTitle(dir),
          startedAt: Date.now(),
        });
        open = false;
        goto(`/workspace/${wsId}/terminal/${terminalId}?daemon=${encodeURIComponent(daemonId)}`);
        return;
      }
      let agentId: string;
      if (tab === "cybo") {
        const target = selectedCyboId ? cybos.find((c) => c.id === selectedCyboId) : undefined;
        if (!target) throw new Error("Pick a cybo first");
        // Local (disk) cybos only spawn on their home daemon (see AgentsPane
        // handleStartChat) — prefer it over the dialog's selected daemon.
        const isLocalCybo = target.isLocal || target.id.startsWith("local:");
        const cyboDaemonId = (isLocalCybo ? target.daemonId : null) ?? daemonId;
        agentId = await spawnCybo(target.slug || target.id, dir, { daemonId: cyboDaemonId });
        await sendAgentPrompt(
          agentId,
          "Introduce yourself in this workspace. Keep it short — one or two sentences in your voice.",
        );
      } else {
        if (!selectedProviderId) throw new Error("Pick a provider first");
        const agent = await createAgent(selectedProviderId, dir, {
          daemonId,
          model: selectedModel ?? undefined,
        });
        agentId = agent.agentId;
      }
      open = false;
      // For cybo launches, carry the cybo identity into the chat view (frame-0
      // identity + rollback attribution — see the agent page's ?cybo= hint).
      const cyboHint = tab === "cybo" && selectedCyboId ? `?cybo=${encodeURIComponent(selectedCyboId)}` : "";
      goto(`/workspace/${wsId}/agent/${agentId}${cyboHint}`);
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to launch agent";
    } finally {
      launching = false;
    }
  }
</script>

<Dialog bind:open>
  <!-- Mobile: pin to the viewport width and clip horizontal overflow so the
       footer / provider rows can't spill off-screen (they did — the grid tracks
       grew past the box). [&>*]:min-w-0 lets the grid children shrink. -->
  <DialogContent class="w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] sm:w-full sm:max-w-[640px] max-h-[85vh] overflow-y-auto overflow-x-hidden [&>*]:min-w-0">
    <DialogHeader>
      <DialogTitle>{tab === "cybo" ? "Start chat with a cybo" : "Create Session"}</DialogTitle>
      <DialogDescription>
        {tab === "cybo"
          ? "Start a chat session with one of your cybos."
          : "Launch a session on a provider CLI you have installed."}
      </DialogDescription>
    </DialogHeader>

    {#if selectedDaemonForeign}
      <div
        class="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px] text-warning"
        role="alert"
      >
        <svg
          class="mt-0.5 h-4 w-4 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span>
          This launches on <strong>{selectedDaemon?.label}</strong> — <strong
            >{selectedDaemonOwnerName}'s</strong
          > daemon, not yours.
          {#if selectedDaemonHasAccess}
            It runs on their machine. Switch to your own daemon below to launch on yours.
          {:else}
            You don't have access to this daemon.
          {/if}
        </span>
      </div>
    {/if}

    <Tabs bind:value={tab}>
      <TabsContent value="cybo" class="mt-3 space-y-4">
        <p class="text-[12px] text-content-dim">
          An agent with a personality and role, reusable across sessions.
        </p>
        {#if cybos.length > 0}
          <div>
            <span class="block text-[10.5px] font-bold uppercase tracking-widest text-content-muted mb-2">
              Your cybos
            </span>
            <div class="grid gap-2" style="grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));">
              {#each cybos as c (c.id)}
                <button
                  type="button"
                  onclick={() => pickCybo(c)}
                  class={cn(
                    "flex items-start gap-2.5 rounded-lg border p-2.5 text-left transition-colors cursor-pointer",
                    selectedCyboId === c.id
                      ? "border-btn-primary-bg bg-raised"
                      : "border-edge hover:border-edge-light hover:bg-hover-gray",
                  )}
                >
                  <span class="mt-0.5 shrink-0 text-content-muted"><CyborgIcon size={14} /></span>
                  <span class="min-w-0">
                    <span class="block text-[13px] font-semibold text-content truncate">{c.name}</span>
                    <span class="block text-[11px] text-content-dim leading-snug truncate">
                      {c.role ?? c.description ?? c.provider}
                    </span>
                  </span>
                </button>
              {/each}
            </div>
          </div>
        {/if}

        <p class="text-[11.5px] text-content-dim">
          Want a new persona?
          <a
            href={`/workspace/${wsId}/agent/new`}
            class="underline text-content-muted hover:text-content"
            onclick={() => { open = false; }}
          >Create a cybo</a> — it shows up here and under your cybos.
        </p>
      </TabsContent>

      <TabsContent value="provider" class="mt-3 space-y-3">
        <p class="text-[12px] text-content-dim">
          A plain session on a provider CLI — no personality, nothing saved.
        </p>
        {#if daemonId}
          <!-- Terminal (#656): a fixed option, NOT from list_providers — a raw
               shell on the daemon. Always offered when a daemon is selected. -->
          <button
            type="button"
            onclick={pickTerminal}
            class={cn(
              "flex w-full items-center gap-3 rounded-lg border px-3.5 py-2.5 text-left transition-colors cursor-pointer",
              selectedTerminal
                ? "border-btn-primary-bg bg-raised"
                : "border-edge hover:border-edge-light hover:bg-hover-gray",
            )}
          >
            <span class="shrink-0 text-content-muted">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-[13px] font-semibold text-content">Terminal</span>
              <span class="block text-[11px] text-content-dim truncate">A raw shell on this daemon's machine</span>
            </span>
          </button>
          <div class="flex items-center gap-2 pt-0.5">
            <span class="h-px flex-1 bg-edge"></span>
            <span class="text-[10px] font-medium uppercase tracking-wider text-content-dim">or a provider CLI</span>
            <span class="h-px flex-1 bg-edge"></span>
          </div>
        {/if}
        {#if providersLoading || (daemonId && providersLoadedFor !== daemonId)}
          <div class="flex items-center gap-2 py-6 justify-center">
            <div class="h-3 w-3 rounded-full border-2 border-content-muted border-t-transparent animate-spin"></div>
            <span class="text-sm text-content-muted">Detecting providers on the daemon…</span>
          </div>
        {:else if !daemonId}
          <p class="py-6 text-center text-sm text-content-muted">
            No daemon available. Start a daemon and connect it to this workspace to launch agents.
          </p>
        {:else if providers.length === 0}
          <p class="py-6 text-center text-sm text-content-muted">
            No providers detected on this daemon.
          </p>
        {:else}
          <div class="grid gap-2">
            {#each providers as p (p.id)}
              <button
                type="button"
                onclick={() => { if (p.available) pickProvider(p.id); }}
                disabled={!p.available}
                class={cn(
                  "flex items-center gap-3 rounded-lg border px-3.5 py-2.5 text-left transition-colors",
                  selectedProviderId === p.id
                    ? "border-btn-primary-bg bg-raised"
                    : "border-edge hover:border-edge-light hover:bg-hover-gray",
                  p.available ? "cursor-pointer" : "opacity-50 cursor-not-allowed",
                )}
              >
                <span class="shrink-0 text-content-muted"><ProviderIcon provider={p.id} size={18} /></span>
                <span class="min-w-0 flex-1">
                  <span class="block text-[13px] font-semibold text-content">{p.label}</span>
                  {#if p.description}
                    <span class="block text-[11px] text-content-dim truncate">{p.description}</span>
                  {/if}
                </span>
                {#if p.available}
                  <span
                    class="shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[10px] font-bold uppercase tracking-wide"
                    style="background: color-mix(in srgb, var(--color-online) 16%, transparent); color: var(--color-online);"
                  >
                    <span class="h-1.5 w-1.5 rounded-full" style="background: var(--color-online);"></span>
                    Detected
                  </span>
                {:else}
                  <span class="shrink-0 text-[10px] font-medium uppercase tracking-wide text-content-dim">
                    Not installed
                  </span>
                {/if}
              </button>
            {/each}
          </div>

          {#if selectedProviderId}
            {@const selProvider = providers.find((p) => p.id === selectedProviderId)}
            {#if selProvider && selProvider.models.length > 1}
              <div class="flex items-center justify-between gap-2 rounded-lg border border-edge px-3 py-2">
                <span class="text-[12px] text-content-muted">
                  Model <span class="text-content-dim">(optional)</span>
                </span>
                <ModelCombobox
                  models={selProvider.models}
                  value={selectedModel}
                  providerId={selProvider.id}
                  align="right"
                  placeholder="Default"
                  onSelect={(id) => { selectedModel = id; }}
                />
              </div>
            {/if}
          {/if}
        {/if}
      </TabsContent>
    </Tabs>

    {#if error}
      <p class="text-xs text-error">{error}</p>
    {/if}

    {#if cwdEditorOpen}
      <!-- Working-directory editor: recents + manual path, per the selected daemon. -->
      <div class="rounded-lg border border-edge p-3 space-y-2" style="background: var(--bg-base);">
        <Label for="session-cwd" class="text-[11px] font-medium text-content-muted">
          Working directory — what the session can see and touch
        </Label>
        {#if recentCwds.length > 0 || cwdHome}
          <div class="flex flex-wrap gap-1.5">
            {#if cwdHome}
              <button
                type="button"
                onclick={() => { cwd = cwdHome; }}
                class={cn(
                  "rounded-md px-2 py-0.5 text-[11px] font-mono transition-colors border cursor-pointer",
                  cwd === cwdHome
                    ? "border-btn-primary-bg bg-btn-primary-bg/10 text-btn-primary-bg"
                    : "border-edge text-content-muted hover:border-edge-light hover:text-content",
                )}
              >~</button>
            {/if}
            {#each recentCwds.filter((r) => r !== cwdHome) as recent (recent)}
              <button
                type="button"
                onclick={() => { cwd = recent; }}
                class={cn(
                  "rounded-md px-2 py-0.5 text-[11px] font-mono transition-colors border truncate max-w-[200px] cursor-pointer",
                  cwd === recent
                    ? "border-btn-primary-bg bg-btn-primary-bg/10 text-btn-primary-bg"
                    : "border-edge text-content-muted hover:border-edge-light hover:text-content",
                )}
                title={recent}
              >{shortenPath(recent)}</button>
            {/each}
          </div>
        {/if}
        <Input
          id="session-cwd"
          type="text"
          bind:value={cwd}
          placeholder={cwdHome || "~"}
          class="font-mono text-[12.5px]"
        />
      </div>
    {/if}

    <DialogFooter class="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-2 sm:justify-between">
      <div class="flex items-center gap-1.5 min-w-0 flex-wrap">
        {#if daemons.length > 1}
          <span class="text-[11px] text-content-muted shrink-0">Runs on</span>
          <Select.Root
            type="single"
            value={daemonId ?? undefined}
            onValueChange={(v) => { daemonId = v ?? null; }}
          >
            <Select.Trigger class="h-8 max-w-[180px] text-[12px]">
              {selectedDaemon?.label ?? "Pick a daemon"}
            </Select.Trigger>
            <Select.Content>
              {#each daemons as d (d.id)}
                <Select.Item value={d.id} label={d.label} disabled={!daemonUsable(d.id)}>
                  {d.label}{!daemonState.isOnline(d.id)
                    ? " (offline)"
                    : daemonUsable(d.id)
                      ? ""
                      : " (no access)"}
                </Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        {:else if selectedDaemon}
          <span class="text-[11px] text-content-dim truncate shrink-0">
            Runs on {selectedDaemon.label}{daemonState.isOnline(selectedDaemon.id) ? "" : " (offline)"}
          </span>
        {/if}
        {#if daemonId}
          <!-- The session's working directory — visible up front, click to change. -->
          <span class="text-[11px] text-content-dim shrink-0">· in</span>
          <button
            type="button"
            onclick={() => { cwdEditorOpen = !cwdEditorOpen; }}
            title={cwd || "Working directory"}
            class="min-w-0 truncate text-[11px] font-mono underline decoration-dotted underline-offset-2 text-content-muted hover:text-content cursor-pointer"
            style="background: transparent; border: none; padding: 0; font-family: 'JetBrains Mono', ui-monospace, monospace;"
          >
            {cwd ? shortenPath(cwd) : "…"}
          </button>
        {/if}
      </div>
      <div class="flex items-center justify-end gap-2">
        <Button variant="ghost" onclick={() => { open = false; }}>Cancel</Button>
        <Button
          onclick={launch}
          disabled={!canLaunch}
          title={canLaunch ? undefined : !daemonId ? "Connect a daemon to launch sessions" : "Pick a cybo or provider first"}
        >
          {launching
            ? "Launching…"
            : tab === "cybo"
              ? "Start chat"
              : selectedTerminal
                ? "Open terminal"
                : "Create session"}
        </Button>
      </div>
    </DialogFooter>
  </DialogContent>
</Dialog>
