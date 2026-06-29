<script lang="ts">
  // Channel "AI" tab. Two parts:
  //   1. CHANNEL-level override (channels.slash_command_model) — editable here,
  //      reusing the shared ProviderModelSelector (provider → model).
  //   2. WORKSPACE-level config — READ-ONLY summary of the workspace's slash
  //      daemon + model, linking to the single source of truth (Settings → AI).
  //      The workspace config is NOT editable here.
  import { goto } from "$app/navigation";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import ProviderModelSelector from "$lib/components/agents/components/ProviderModelSelector.svelte";
  import {
    client,
    providerState,
    fetchProviders,
    daemonState,
    applyChannelSlashModel,
    applyChannelAutoTasks,
  } from "$lib/state/app.svelte.js";
  import type { Channel } from "$lib/core/types.js";

  let { channel }: { channel: Channel } = $props();

  const sectionHeader = "text-[11px] font-semibold uppercase tracking-wider text-content-muted mb-1";

  // ── Channel-level override ──
  let provider = $state<string | null>(null);
  let model = $state<string | null>(null);
  let seededId: string | undefined;
  $effect(() => {
    if (channel.id !== seededId) {
      seededId = channel.id;
      provider = channel.slashCommandModel?.provider ?? null;
      model = channel.slashCommandModel?.model ?? null;
    }
  });

  let setting = $state(false);
  let error = $state<string | null>(null);
  const hasOverride = $derived(!!channel.slashCommandModel);

  // Channels aren't bound to a daemon → use the aggregate provider catalog. Load
  // once (providerState has no "loaded" flag, so guard against a re-fetch loop on
  // a genuinely empty catalog).
  let attemptedFetch = false;
  $effect(() => {
    if (!attemptedFetch && providerState.list.length === 0 && !providerState.loading) {
      attemptedFetch = true;
      void fetchProviders();
    }
  });
  const providers = $derived(providerState.list);

  function pickProvider(providerId: string): void {
    // Provider alone is an incomplete selection — defer persistence until a model
    // is also chosen. Clear a now-mismatched model unless it's the saved one.
    provider = providerId;
    if (channel.slashCommandModel?.provider !== providerId) model = null;
  }

  async function pickModel(modelId: string): Promise<void> {
    if (!provider || setting) return;
    setting = true;
    error = null;
    try {
      const res = await client.setChannelSlashCommandModel(channel.workspaceId, channel.id, {
        provider,
        model: modelId,
      });
      // Reflect the saved override in the global store so reopening the tab shows
      // it (the panel reseeds from channel.slashCommandModel). Use the server's
      // authoritative response.
      applyChannelSlashModel(channel.id, res.model);
      model = res.model?.model ?? modelId;
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to set the channel AI model.";
    } finally {
      setting = false;
    }
  }

  async function resetModel(): Promise<void> {
    if (setting) return;
    setting = true;
    error = null;
    try {
      await client.setChannelSlashCommandModel(channel.workspaceId, channel.id, null);
      // Clear the override in the global store too, so reopening the tab reflects it.
      applyChannelSlashModel(channel.id, null);
      provider = null;
      model = null;
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to clear the channel AI model.";
    } finally {
      setting = false;
    }
  }

  // ── Auto-tasks (channel watcher) opt-in ──
  // OFF by default: when ON, a cybo in this channel may act autonomously on
  // un-mentioned human messages (the watcher). This is the per-channel brake, so
  // a cybo never acts without someone explicitly turning it on here.
  let autoTasksBusy = $state(false);
  let autoTasksError = $state<string | null>(null);
  const autoTasksOn = $derived(channel.autoTasksEnabled === true);

  async function toggleAutoTasks(next: boolean): Promise<void> {
    if (autoTasksBusy) return;
    autoTasksBusy = true;
    autoTasksError = null;
    try {
      const res = await client.setChannelAutoTasks(channel.workspaceId, channel.id, next);
      applyChannelAutoTasks(channel.id, res.enabled);
    } catch (err) {
      autoTasksError = err instanceof Error ? err.message : "Failed to update auto-tasks.";
    } finally {
      autoTasksBusy = false;
    }
  }

  // ── Workspace-level (read-only) ──
  const wsDaemonLabel = $derived(
    daemonState.defaultSlashDaemonId
      ? (daemonState.byId(daemonState.defaultSlashDaemonId)?.label ?? "Unknown daemon")
      : null,
  );
  const wsModel = $derived(daemonState.slashCommandModel?.model ?? null);
</script>

<div class="space-y-6">
  <section>
    <div class={sectionHeader}>This channel</div>
    <p class="mb-2 text-xs text-content-dim">
      Override the model for this channel's AI commands (<code>/summarize</code> etc.). Leave unset
      to inherit the workspace default below.
    </p>
    {#if error}
      <div class="mb-2 rounded-md bg-error/10 px-3 py-2 text-[13px] text-error">{error}</div>
    {/if}
    <div class="flex flex-wrap items-center gap-2">
      <ProviderModelSelector
        {providers}
        {provider}
        {model}
        disabled={setting}
        providerPlaceholder="Inherit default"
        modelPlaceholder="Model"
        onProviderChange={pickProvider}
        onModelChange={pickModel}
      />
      {#if hasOverride}
        <Button variant="ghost" size="sm" disabled={setting} onclick={resetModel}>
          Reset to default
        </Button>
      {/if}
    </div>
  </section>

  <section class="border-t border-edge pt-5">
    <div class={sectionHeader}>Auto-tasks</div>
    <div class="flex items-start justify-between gap-3">
      <p class="text-xs text-content-dim">
        When on, a cybo in this channel may act autonomously on messages it isn't mentioned in
        (the channel watcher). Off by default — turn it on only for channels you want agents to
        watch.
      </p>
      <Switch
        checked={autoTasksOn}
        disabled={autoTasksBusy}
        aria-label="Auto-tasks"
        onCheckedChange={toggleAutoTasks}
      />
    </div>
    {#if autoTasksError}
      <div class="mt-2 rounded-md bg-error/10 px-3 py-2 text-[13px] text-error">
        {autoTasksError}
      </div>
    {/if}
  </section>

  <section class="border-t border-edge pt-5">
    <div class={sectionHeader}>Workspace default</div>
    {#if wsDaemonLabel}
      <p class="text-sm text-content">
        {wsDaemonLabel}
        <span class="text-content-muted">· {wsModel ?? "auto"}</span>
      </p>
      <p class="text-xs text-content-dim">Used whenever this channel has no override of its own.</p>
    {:else}
      <p class="text-sm text-content-dim">No workspace slash daemon is set yet.</p>
    {/if}
    <Button
      class="mt-2"
      variant="outline"
      size="sm"
      onclick={() => goto(`/workspace/${channel.workspaceId}/settings/ai`)}
    >
      Configure in Settings → AI
    </Button>
  </section>
</div>
