<script lang="ts">
  import {
    workspaceState,
    client,
    authState,
    daemonState,
    providerState,
    fetchProviders,
  } from "$lib/state/app.svelte.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import type { WorkspaceSlashConfig } from "$lib/core/client.js";
  import ProviderModelSelector from "$lib/components/agents/components/ProviderModelSelector.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import { cn } from "$lib/utils.js";

  // Centralized, admin-only workspace AI config: the default slash-command
  // daemon, its ordered fallbacks, and the default model for channel AI
  // commands. Consumes W2's get/set_workspace_slash_config endpoints.
  const workspace = $derived(workspaceState.current);
  const wsId = $derived(workspace?.id ?? "");
  const myRole = $derived(workspace?.role ?? "viewer");
  const canEdit = $derived(myRole === "owner" || myRole === "admin");

  const daemons = $derived(daemonState.list);
  // Only daemons the user passes the access matrix for (owner or daemon_access
  // grant) are SELECTABLE — slash commands run code on the chosen daemon, and
  // the server enforces the same gate. The full list still resolves labels so
  // a daemon another admin configured displays correctly.
  const selectableDaemons = $derived(
    daemons.filter((d) => daemonState.canAccess(d.id, authState.user?.id)),
  );
  function daemonLabel(id: string | null): string {
    if (!id) return "None";
    return daemons.find((d) => d.id === id)?.label ?? id;
  }
  function onlineSuffix(id: string): string {
    return daemonState.isOnline(id) ? "" : " (offline)";
  }

  // ── Config state: seeded from the server, edited locally, saved on demand ──
  // Global on/off for the workspace (default on). When off, the composer must not
  // process slash commands in any channel.
  let slashCommandsEnabled = $state(true);
  // Channel-watcher autonomy (default on). When off, agents in this workspace only
  // respond when @-mentioned — the automatic watcher that creates/updates tasks is
  // disabled. Saved immediately on toggle via its own relay endpoint (not the
  // slash-config round-trip), so it has no entry in the Save-changes button below.
  let agentAutonomyEnabled = $state(true);
  let autonomySaving = $state(false);
  let autonomyError = $state<string | null>(null);
  let defaultDaemonId = $state<string | null>(null);
  let fallbackDaemonIds = $state<string[]>([]);
  let model = $state<{ provider: string; model: string } | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let savedOk = $state(false);

  let seededWsId: string | undefined;
  $effect(() => {
    if (!wsId || wsId === seededWsId) return;
    seededWsId = wsId;
    const target = wsId;
    // Reset immediately so a new workspace never shows the previous one's values
    // (during load OR if the fetch fails) — no stale-data leakage across switches.
    slashCommandsEnabled = true;
    agentAutonomyEnabled = true;
    autonomyError = null;
    defaultDaemonId = null;
    fallbackDaemonIds = [];
    model = null;
    modelProviderPick = null;
    loading = true;
    loadError = null;
    let active = true;
    void (async () => {
      try {
        // Two independent reads for this workspace's AI config: the slash-config
        // round-trip and the autonomy flag. Run them together; autonomy defaults
        // on if its read fails so the control never lies "off".
        const [cfg, autonomy] = await Promise.all([
          client.getWorkspaceSlashConfig(target),
          client.getWorkspaceAutonomy(target).catch(() => ({ enabled: true })),
        ]);
        if (!active) return;
        slashCommandsEnabled = cfg.slashCommandsEnabled ?? true;
        agentAutonomyEnabled = autonomy.enabled ?? true;
        defaultDaemonId = cfg.defaultDaemonId ?? null;
        fallbackDaemonIds = [...(cfg.fallbackDaemonIds ?? [])];
        model = cfg.model ?? null;
        modelProviderPick = null;
      } catch (e: unknown) {
        if (active) loadError = e instanceof Error ? e.message : "Could not load AI settings.";
      } finally {
        if (active) loading = false;
      }
    })();
    return () => {
      active = false;
    };
  });

  // Providers for the chosen default daemon — the catalog the model selector
  // resolves against; loaded lazily when a default daemon is set + online.
  const modelProviders = $derived(
    defaultDaemonId ? providerState.forDaemon(defaultDaemonId) : [],
  );
  // Whether the default daemon's provider catalog is still being fetched, so the
  // model selector can show a loading state instead of an empty/stale picker.
  const providersLoading = $derived(
    !!defaultDaemonId && (providerState.loadingDaemons[defaultDaemonId] ?? false),
  );
  $effect(() => {
    if (
      defaultDaemonId &&
      daemonState.isOnline(defaultDaemonId) &&
      !providerState.byDaemon[defaultDaemonId]
    ) {
      void fetchProviders(defaultDaemonId);
    }
  });

  // Accessible daemons not already used as default/fallback — addable to the
  // fallback list.
  const addableDaemons = $derived(
    selectableDaemons.filter((d) => d.id !== defaultDaemonId && !fallbackDaemonIds.includes(d.id)),
  );

  function setDefaultDaemon(id: string): void {
    if (!canEdit || !daemonState.canAccess(id, authState.user?.id)) return;
    defaultDaemonId = id;
    fallbackDaemonIds = fallbackDaemonIds.filter((f) => f !== id);
    // The model belongs to the previous daemon's catalog — clear on switch.
    model = null;
    modelProviderPick = null;
  }
  function addFallback(id: string): void {
    if (!canEdit || !id || fallbackDaemonIds.includes(id) || id === defaultDaemonId) return;
    if (!daemonState.canAccess(id, authState.user?.id)) return;
    fallbackDaemonIds = [...fallbackDaemonIds, id];
  }
  function removeFallback(id: string): void {
    if (!canEdit) return;
    fallbackDaemonIds = fallbackDaemonIds.filter((f) => f !== id);
  }
  function moveFallback(index: number, dir: -1 | 1): void {
    if (!canEdit) return;
    const next = index + dir;
    if (next < 0 || next >= fallbackDaemonIds.length) return;
    const arr = [...fallbackDaemonIds];
    [arr[index], arr[next]] = [arr[next], arr[index]];
    fallbackDaemonIds = arr;
  }

  // ── Model: two-step provider → model (shared ProviderModelSelector) ──
  let modelProviderPick = $state<string | null>(null);
  const effectiveModelProvider = $derived(modelProviderPick ?? model?.provider ?? null);
  const effectiveModel = $derived(
    effectiveModelProvider === (model?.provider ?? null) ? (model?.model ?? null) : null,
  );
  function pickModelProvider(providerId: string): void {
    if (!canEdit) return;
    modelProviderPick = providerId;
    // Changing provider invalidates the saved model — clear it so we never
    // persist a model that doesn't belong to the chosen provider.
    model = null;
  }
  function pickModel(modelId: string): void {
    if (!canEdit || !effectiveModelProvider) return;
    model = { provider: effectiveModelProvider, model: modelId };
  }

  const dirty = $derived(!loading); // any local edit is saved explicitly

  async function save(): Promise<void> {
    if (!canEdit || saving || !wsId) return;
    const targetWsId = wsId;
    saving = true;
    saveError = null;
    savedOk = false;
    try {
      const cfg: WorkspaceSlashConfig = {
        slashCommandsEnabled,
        defaultDaemonId,
        fallbackDaemonIds,
        model,
      };
      const saved = await client.setWorkspaceSlashConfig(targetWsId, cfg);
      // The user may have switched workspaces mid-request — don't clobber the
      // new workspace's state with this one's response.
      if (wsId !== targetWsId) return;
      slashCommandsEnabled = saved.slashCommandsEnabled ?? true;
      defaultDaemonId = saved.defaultDaemonId ?? null;
      fallbackDaemonIds = [...(saved.fallbackDaemonIds ?? [])];
      model = saved.model ?? null;
      modelProviderPick = null;
      savedOk = true;
      setTimeout(() => {
        savedOk = false;
      }, 2000);
    } catch (e: unknown) {
      saveError = e instanceof Error ? e.message : "Failed to save.";
    } finally {
      saving = false;
    }
  }

  // Autonomy saves immediately on toggle (no Save button). Optimistic: flip the
  // switch, then reconcile from the server's authoritative `enabled`; on failure
  // roll back. The relay also fans a broadcast that patches workspaceState, so
  // the value stays in sync across this user's other devices.
  async function setAutonomy(next: boolean): Promise<void> {
    if (!canEdit || autonomySaving || !wsId) return;
    const targetWsId = wsId;
    const prev = agentAutonomyEnabled;
    agentAutonomyEnabled = next;
    autonomySaving = true;
    autonomyError = null;
    try {
      const resp = await client.setWorkspaceAutonomy(targetWsId, next);
      if (wsId !== targetWsId) return;
      agentAutonomyEnabled = resp.enabled ?? next;
    } catch (e: unknown) {
      if (wsId === targetWsId) agentAutonomyEnabled = prev;
      autonomyError = e instanceof Error ? e.message : "Failed to save.";
    } finally {
      autonomySaving = false;
    }
  }
</script>

<div class={viewportState.isMobile ? "px-4 pb-8 pt-3" : "mx-auto max-w-2xl px-6 py-6"}>
  {#if !viewportState.isMobile}
    <header class="mb-5">
      <h1 class="text-lg font-semibold text-content">AI</h1>
      <p class="mt-1 text-[13px] text-content-muted">
        Where slash commands (<code>/summarize</code>, <code>/ask</code>, …) run for this workspace,
        and the model they use by default.
      </p>
    </header>
  {:else}
    <p class="mb-5 text-[13px] text-content-muted">
      Where slash commands run for this workspace, and the model they use by default.
    </p>
  {/if}

  {#if !canEdit}
    <div class="mb-4 rounded-lg border border-edge bg-surface-alt px-3 py-2.5 text-[12px] text-content-muted">
      Only workspace owners and admins can change these settings. They're shown read-only — ask an
      admin to update them.
    </div>
  {/if}

  {#if loadError}
    <div class="mb-4 rounded-lg border border-edge bg-surface-alt px-3 py-2.5 text-[12px] text-content-muted">
      Couldn't load the saved configuration ({loadError}). You can still set values below.
    </div>
  {/if}

  {#if loading}
    <p class="py-6 text-center text-sm text-content-muted">Loading…</p>
  {:else}
    <!-- 0) Global on/off for the whole workspace -->
    <section class="mb-5 rounded-lg border border-edge p-4">
      <div class="flex items-center gap-3">
        <div class="min-w-0">
          <h2 class="text-sm font-semibold text-content">Slash commands</h2>
          <p class="mt-0.5 text-[12px] text-content-muted">
            When off, <code>/summarize</code>, <code>/ask</code> and other slash commands are
            disabled in <strong>every</strong> channel of this workspace for everyone.
          </p>
        </div>
        <Switch
          class="ml-auto shrink-0"
          checked={slashCommandsEnabled}
          disabled={!canEdit}
          onCheckedChange={(v) => {
            if (canEdit) slashCommandsEnabled = v;
          }}
        />
      </div>
      {#if !slashCommandsEnabled}
        <p class="mt-2 text-[11px] text-content-muted">
          Slash commands are turned off — the daemon and model settings below apply once you turn
          them back on.
        </p>
      {/if}
    </section>

    <!-- 0b) Agent autonomy — channel-watcher on/off for the whole workspace -->
    <section class="mb-5 rounded-lg border border-edge p-4">
      <div class="flex items-center gap-3">
        <div class="min-w-0">
          <h2 class="text-sm font-semibold text-content">Agent autonomy</h2>
          <p class="mt-0.5 text-[12px] text-content-muted">
            When off, agents in this workspace only respond when @-mentioned (the automatic channel
            watcher that creates/updates tasks is disabled).
          </p>
        </div>
        <Switch
          class="ml-auto shrink-0"
          checked={agentAutonomyEnabled}
          disabled={!canEdit || autonomySaving}
          onCheckedChange={(v) => {
            if (canEdit) void setAutonomy(v);
          }}
        />
      </div>
      {#if autonomyError}
        <p class="mt-2 text-[11px] text-error">{autonomyError}</p>
      {/if}
    </section>

    <!-- 1) Default slash-command daemon -->
    <section
      class={cn(
        "mb-5 rounded-lg border border-edge p-4 transition-opacity",
        !slashCommandsEnabled && "opacity-60",
      )}
    >
      <h2 class="text-sm font-semibold text-content">Default daemon</h2>
      <p class="mb-3 mt-0.5 text-[12px] text-content-muted">
        Slash commands run on this daemon. There is only one default per workspace.
      </p>
      <Select.Root
        type="single"
        value={defaultDaemonId ?? undefined}
        onValueChange={(v) => {
          if (v) setDefaultDaemon(v);
        }}
        disabled={!canEdit || selectableDaemons.length === 0}
      >
        <Select.Trigger class="h-9 w-full max-w-xs text-[16px] sm:text-[13px]">
          {defaultDaemonId ? daemonLabel(defaultDaemonId) + onlineSuffix(defaultDaemonId) : "Pick a daemon"}
        </Select.Trigger>
        <Select.Content>
          {#each selectableDaemons as d (d.id)}
            <Select.Item value={d.id} label={d.label}>
              {d.label}{onlineSuffix(d.id)}
            </Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      {#if daemons.length === 0}
        <p class="mt-2 text-[12px] text-content-muted">No daemons connected to this workspace yet.</p>
      {:else if selectableDaemons.length === 0}
        <p class="mt-2 text-[12px] text-content-muted">
          You don't have access to any daemon in this workspace — only daemons you own or were
          granted access to can be designated.
        </p>
      {/if}
    </section>

    <!-- 2) Fallback daemons (ordered) -->
    <section class="mb-5 rounded-lg border border-edge p-4">
      <h2 class="text-sm font-semibold text-content">Fallback daemons</h2>
      <p class="mb-3 mt-0.5 text-[12px] text-content-muted">
        If the default is offline or unavailable, slash commands fall back to these — in order, top
        first.
      </p>

      {#if fallbackDaemonIds.length === 0}
        <p class="mb-2 text-[12px] text-content-muted">No fallbacks set.</p>
      {:else}
        <ul class="mb-3 space-y-1.5">
          {#each fallbackDaemonIds as id, i (id)}
            <li class="flex items-center gap-2 rounded-md border border-edge-dim px-2.5 py-1.5 text-[13px]">
              <span class="w-5 shrink-0 text-center text-[11px] text-content-muted tabular-nums">{i + 1}</span>
              <span class={cn("min-w-0 flex-1 truncate text-content", !daemonState.isOnline(id) && "text-content-muted")}>
                {daemonLabel(id)}{onlineSuffix(id)}
              </span>
              {#if canEdit}
                <button
                  type="button"
                  class="rounded px-1 text-content-muted hover:text-content disabled:opacity-30"
                  disabled={i === 0}
                  aria-label="Move up"
                  onclick={() => moveFallback(i, -1)}>↑</button
                >
                <button
                  type="button"
                  class="rounded px-1 text-content-muted hover:text-content disabled:opacity-30"
                  disabled={i === fallbackDaemonIds.length - 1}
                  aria-label="Move down"
                  onclick={() => moveFallback(i, 1)}>↓</button
                >
                <button
                  type="button"
                  class="rounded px-1 text-content-muted hover:text-error"
                  aria-label="Remove"
                  onclick={() => removeFallback(id)}>✕</button
                >
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if canEdit && addableDaemons.length > 0}
        <Select.Root
          type="single"
          value={undefined}
          onValueChange={(v) => {
            if (v) addFallback(v);
          }}
        >
          <Select.Trigger class="h-8 w-full max-w-xs text-[12px]">＋ Add fallback daemon</Select.Trigger>
          <Select.Content>
            {#each addableDaemons as d (d.id)}
              <Select.Item value={d.id} label={d.label}>
                {d.label}{onlineSuffix(d.id)}
              </Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      {/if}
    </section>

    <!-- 3) Default model -->
    <section class="mb-5 rounded-lg border border-edge p-4">
      <h2 class="text-sm font-semibold text-content">Default model</h2>
      <p class="mb-3 mt-0.5 text-[12px] text-content-muted">
        Optional. By default the best available model is auto-resolved. Pick a provider, then a
        model (Pi included) to force one for this workspace's AI commands.
      </p>
      {#if !defaultDaemonId}
        <p class="text-[12px] text-content-muted">Pick a default daemon first to choose its models.</p>
      {:else if providersLoading && modelProviders.length === 0}
        <p class="flex items-center gap-2 text-[12px] text-content-muted">
          <span class="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-content-muted border-t-transparent"></span>
          Loading providers…
        </p>
      {:else}
        <div class="flex flex-wrap items-center gap-2">
          <ProviderModelSelector
            providers={modelProviders}
            provider={effectiveModelProvider}
            model={effectiveModel}
            disabled={!canEdit || providersLoading}
            onProviderChange={pickModelProvider}
            onModelChange={pickModel}
          />
          {#if model && canEdit}
            <Button variant="ghost" size="sm" onclick={() => { model = null; modelProviderPick = null; }}>
              Reset to auto
            </Button>
          {/if}
        </div>
      {/if}
    </section>

    {#if canEdit}
      <div class="flex items-center gap-3">
        <Button size="sm" disabled={saving || !dirty} onclick={() => save()}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
        {#if savedOk}
          <span class="text-[12px] text-online">Saved.</span>
        {:else if saveError}
          <span class="text-[12px] text-error">{saveError}</span>
        {/if}
      </div>
    {/if}
  {/if}
</div>
