<script lang="ts">
  // Slack integration DETAIL page — the connected-integration screen, mirroring the
  // GitHub detail page (settings/integrations/github). Sections, top to bottom:
  //   • "Back to integrations" link + the Slack header.
  //   • Connect Workspace: the install link + the connected Slack workspace row(s),
  //     each with a Disconnect (confirm → disconnectSlack).
  //   • Link a Slack channel to a Cyborg channel: pick a Cyborg channel + enter the
  //     Slack channel id → Start (linkSlackChannel). The Slack workspace (installation)
  //     is auto-used when there's one, picked when there's more than one.
  //   • Channel links: the workspace's Slack↔Cyborg links, each with Remove.
  //   • Credential-gated: when the relay's Slack secrets are absent the page renders a
  //     clear "not configured" state instead of a broken Connect button.
  //
  // Token-only styling. All Slack RPCs go through the authed client slack* helpers.
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { replaceState } from "$app/navigation";
  import { client } from "$lib/state/app.svelte.js";
  import SlackIcon from "$lib/components/SlackIcon.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { openExternalUrl } from "$lib/desktop-terminal.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import type { SlackInstallation, SlackChannelLink } from "$lib/ws-client.js";
  import type { Channel } from "$lib/core/types.js";

  const workspaceId = $derived(page.params.id ?? "");
  const integrationsHref = $derived(`/workspace/${workspaceId}/settings/integrations`);

  let config = $state<{ configured: boolean; installUrl: string | null } | null>(null);
  const notConfigured = $derived(config !== null && !config.configured);
  const installUrl = $derived(config?.installUrl ?? null);

  let installations = $state<SlackInstallation[]>([]);
  let links = $state<SlackChannelLink[]>([]);
  let channels = $state<Channel[]>([]);
  let loadingInstalls = $state(true);
  let loadingLinks = $state(true);
  let error = $state<string | null>(null);

  // Post-redirect status notes (?slack=connected | oauth_error). Transient feedback;
  // the installations list is the authoritative connected state.
  let connectedNote = $state(false);
  let oauthError = $state(false);

  // Disconnect confirmation target.
  let pendingDisconnect = $state<SlackInstallation | null>(null);
  let disconnectBusy = $state(false);

  // Unlink confirmation target.
  let pendingUnlink = $state<SlackChannelLink | null>(null);
  let unlinkBusy = $state(false);

  // Link form.
  let formInstallationId = $state("");
  let formChannelId = $state("");
  let slackChannelInput = $state("");
  let linking = $state(false);

  // Only regular, visible, non-archived channels can be bridged (group DMs / hidden /
  // archived channels are never bound).
  const linkableChannels = $derived(
    channels.filter((c) => c.type !== "group_dm" && !c.isHidden && !c.isArchived),
  );
  const selectedInstall = $derived(installations.find((i) => i.id === formInstallationId) ?? null);
  const selectedChannel = $derived(linkableChannels.find((c) => c.id === formChannelId) ?? null);
  const canLink = $derived(
    !!formInstallationId && !!formChannelId && slackChannelInput.trim().length > 0 && !linking,
  );

  // The Slack workspace label for an installation (the team name from config, else the
  // Slack team id).
  function installLabel(inst: SlackInstallation): string {
    const teamName = typeof inst.config?.teamName === "string" ? inst.config.teamName : "";
    return teamName || inst.externalId;
  }

  // The Cyborg channel name for a link's cyborgChannelId (falls back to the raw id).
  function channelName(channelId: string): string {
    return channels.find((c) => c.id === channelId)?.name ?? channelId;
  }

  async function loadConfig(): Promise<void> {
    try {
      config = await client.fetchSlackConfig(workspaceId);
    } catch {
      config = { configured: false, installUrl: null };
    }
  }

  async function loadInstallations(): Promise<void> {
    loadingInstalls = true;
    try {
      installations = await client.fetchSlackInstallations(workspaceId);
      // Default the form to the only installation when there's exactly one.
      if (installations.length === 1) formInstallationId = installations[0].id;
      else if (!installations.some((i) => i.id === formInstallationId)) formInstallationId = "";
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load Slack connections";
    } finally {
      loadingInstalls = false;
    }
  }

  async function loadLinks(): Promise<void> {
    loadingLinks = true;
    try {
      links = await client.fetchSlackChannelLinks(workspaceId);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load Slack channel links";
    } finally {
      loadingLinks = false;
    }
  }

  async function loadChannels(): Promise<void> {
    try {
      channels = await client.listChannels(workspaceId);
    } catch {
      channels = [];
    }
  }

  onMount(() => {
    const note = page.url.searchParams.get("slack");
    if (note === "connected") connectedNote = true;
    if (note === "oauth_error") oauthError = true;
    if (note) {
      const u = new URL(page.url);
      u.searchParams.delete("slack");
      replaceState(u, {});
    }
    void loadConfig();
    void loadInstallations();
    void loadLinks();
    void loadChannels();
  });

  async function confirmDisconnect(): Promise<void> {
    const target = pendingDisconnect;
    if (!target) return;
    disconnectBusy = true;
    error = null;
    try {
      await client.disconnectSlack(workspaceId, target.id);
      pendingDisconnect = null;
      await loadInstallations();
      // A disconnect cascades its channel links away — refresh that list too.
      await loadLinks();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to disconnect";
    } finally {
      disconnectBusy = false;
    }
  }

  async function submitLink(): Promise<void> {
    const inst = selectedInstall;
    if (!inst || !formChannelId || !slackChannelInput.trim()) return;
    linking = true;
    error = null;
    try {
      await client.linkSlackChannel({
        workspaceId,
        installationId: inst.id,
        cyborgChannelId: formChannelId,
        slackChannelId: slackChannelInput.trim(),
        slackTeamId: inst.externalId,
      });
      // Reset the per-link fields (keep the chosen workspace) + refresh.
      formChannelId = "";
      slackChannelInput = "";
      await loadLinks();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to link the channel";
    } finally {
      linking = false;
    }
  }

  async function confirmUnlink(): Promise<void> {
    const target = pendingUnlink;
    if (!target) return;
    unlinkBusy = true;
    error = null;
    try {
      await client.unlinkSlackChannel(workspaceId, target.id);
      pendingUnlink = null;
      await loadLinks();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to remove the link";
    } finally {
      unlinkBusy = false;
    }
  }
</script>

<div class="mx-auto max-w-2xl px-6 py-8 space-y-8">
  <!-- Back link -->
  <a
    href={integrationsHref}
    class="inline-flex items-center gap-1.5 text-[13px] text-content-muted transition-colors hover:text-content"
  >
    <svg
      class="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
    Back to integrations
  </a>

  <!-- Header -->
  <header class="flex items-start gap-4">
    <div
      class="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-edge bg-surface"
    >
      <SlackIcon size={24} />
    </div>
    <div class="min-w-0">
      <h1 class="text-lg font-semibold text-content">Slack</h1>
      <p class="mt-0.5 text-[13px] text-content-muted">
        Connect and sync your Slack customer channels
      </p>
    </div>
  </header>

  {#if connectedNote}
    <p class="rounded-md border border-edge bg-surface-alt px-3 py-2 text-[12px] text-success">
      Slack connected. Link a Slack channel to a Cyborg channel below.
    </p>
  {/if}
  {#if oauthError}
    <p class="rounded-md border border-edge bg-surface-alt px-3 py-2 text-[12px] text-error">
      We couldn't complete the Slack connection. Please try again.
    </p>
  {/if}
  {#if error}
    <p
      class="rounded-md border border-edge bg-surface-alt px-3 py-2 text-[12px] text-error"
      role="alert"
    >
      {error}
    </p>
  {/if}

  {#if notConfigured}
    <!-- Credential-gated: the relay's Slack secrets aren't set. -->
    <p class="rounded-md border border-dashed border-edge px-3 py-4 text-[13px] text-content-muted">
      Slack isn't configured on this server yet. Once the Slack app credentials are set, you'll be
      able to connect a Slack workspace and bridge channels here.
    </p>
  {:else}
    <!-- Connect Workspace -->
    <section class="space-y-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="text-[15px] font-semibold text-content">Connect Workspace</h2>
          <p class="mt-0.5 text-[13px] text-content-muted">
            Connect your Slack workspace to mirror customer channels
          </p>
        </div>
        {#if installUrl}
          <Button size="sm" onclick={() => { if (installUrl) openExternalUrl(installUrl); }}>Connect Slack</Button>
        {:else}
          <Button size="sm" disabled title="Checking Slack configuration…">Connect Slack</Button>
        {/if}
      </div>

      {#if loadingInstalls}
        <p class="text-[13px] text-content-muted">Loading…</p>
      {:else if installations.length === 0}
        <p
          class="rounded-md border border-dashed border-edge px-3 py-4 text-[13px] text-content-muted"
        >
          No Slack workspaces connected yet.
        </p>
      {:else}
        <ul class="divide-y divide-edge overflow-hidden rounded-md border border-edge">
          {#each installations as inst (inst.id)}
            <li class="flex items-center justify-between gap-3 bg-surface-alt px-3 py-2.5">
              <div class="flex min-w-0 items-center gap-2.5">
                <SlackIcon size={18} />
                <span class="truncate text-[13px] font-medium text-content">
                  {installLabel(inst)}
                </span>
                <span
                  class="rounded-full border border-edge bg-surface px-2 py-0.5 text-[11px] text-content-muted"
                >
                  {inst.externalId}
                </span>
              </div>
              <Button
                size="sm"
                variant="destructive"
                disabled={disconnectBusy}
                onclick={() => (pendingDisconnect = inst)}
              >
                Disconnect
              </Button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Link a Slack channel to a Cyborg channel -->
    <section class="space-y-3">
      <div class="min-w-0">
        <h2 class="text-[15px] font-semibold text-content">Link a Slack channel</h2>
        <p class="mt-0.5 text-[13px] text-content-muted">
          Bridge a Slack channel to a Cyborg channel so messages mirror both ways
        </p>
      </div>

      {#if installations.length === 0}
        <p
          class="rounded-md border border-dashed border-edge px-3 py-4 text-[13px] text-content-muted"
        >
          Connect a Slack workspace first.
        </p>
      {:else}
        <div class="space-y-3 rounded-md border border-edge bg-surface-alt p-3">
          <!-- Slack workspace (only when more than one is connected) -->
          {#if installations.length > 1}
            <div class="flex flex-col gap-1.5">
              <span class="text-[12px] text-content-dim" id="slk-link-ws-label">Slack workspace</span>
              <Select.Root
                type="single"
                value={formInstallationId}
                onValueChange={(v) => (formInstallationId = v)}
              >
                <Select.Trigger aria-labelledby="slk-link-ws-label">
                  {#if selectedInstall}
                    {installLabel(selectedInstall)}
                  {:else}
                    <span class="text-content-muted">Choose workspace...</span>
                  {/if}
                </Select.Trigger>
                <Select.Content>
                  {#each installations as i (i.id)}
                    <Select.Item value={i.id} label={installLabel(i)}>{installLabel(i)}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
            </div>
          {/if}

          <!-- Cyborg channel -->
          <div class="flex flex-col gap-1.5">
            <span class="text-[12px] text-content-dim" id="slk-link-channel-label">Cyborg channel</span>
            <Select.Root
              type="single"
              value={formChannelId}
              onValueChange={(v) => (formChannelId = v)}
              disabled={linkableChannels.length === 0}
            >
              <Select.Trigger aria-labelledby="slk-link-channel-label">
                {#if selectedChannel}
                  #{selectedChannel.name}
                {:else}
                  <span class="text-content-muted">Choose channel...</span>
                {/if}
              </Select.Trigger>
              <Select.Content>
                {#each linkableChannels as c (c.id)}
                  <Select.Item value={c.id} label={c.name}>#{c.name}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>

          <!-- Slack channel id -->
          <div class="flex flex-col gap-1.5">
            <span class="text-[12px] text-content-dim" id="slk-link-slackid-label">Slack channel ID</span>
            <Input
              bind:value={slackChannelInput}
              placeholder="C0123ABCDEF"
              aria-labelledby="slk-link-slackid-label"
            />
            <p class="text-[12px] text-content-dim">
              Add the Cyborg bot to the Slack channel, then paste its channel ID (Slack → channel
              details → bottom).
            </p>
          </div>

          <div class="flex justify-end">
            <Button size="sm" disabled={!canLink} onclick={submitLink}>
              {linking ? "Linking…" : "Start"}
            </Button>
          </div>
        </div>
      {/if}
    </section>

    <!-- Channel links -->
    <section class="space-y-3">
      <div class="min-w-0">
        <h2 class="text-[15px] font-semibold text-content">Channel links</h2>
        <p class="mt-0.5 text-[13px] text-content-muted">Slack channels bridged to Cyborg channels</p>
      </div>

      {#if loadingLinks}
        <p class="text-[13px] text-content-muted">Loading…</p>
      {:else if links.length === 0}
        <p
          class="rounded-md border border-dashed border-edge px-3 py-4 text-[13px] text-content-muted"
        >
          No channel links yet.
        </p>
      {:else}
        <ul class="divide-y divide-edge overflow-hidden rounded-md border border-edge">
          {#each links as link (link.id)}
            <li class="flex items-center justify-between gap-3 bg-surface-alt px-3 py-2.5">
              <div class="flex min-w-0 items-center gap-2 text-[13px]">
                <span class="truncate font-medium text-content">#{channelName(link.cyborgChannelId)}</span>
                <svg
                  class="h-3.5 w-3.5 shrink-0 text-content-dim"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
                <span class="inline-flex items-center gap-1.5 truncate text-content-muted">
                  <SlackIcon size={14} />
                  {link.slackChannelId}
                </span>
              </div>
              <Button
                size="sm"
                variant="destructive"
                disabled={unlinkBusy}
                onclick={() => (pendingUnlink = link)}
              >
                Remove
              </Button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

<ConfirmDialog
  open={pendingDisconnect !== null}
  title="Disconnect Slack"
  message={pendingDisconnect
    ? `Disconnect ${installLabel(pendingDisconnect)}? This removes its channel links from this workspace.`
    : ""}
  confirmLabel="Disconnect"
  cancelLabel="Cancel"
  destructive
  onconfirm={confirmDisconnect}
  oncancel={() => (pendingDisconnect = null)}
/>

<ConfirmDialog
  open={pendingUnlink !== null}
  title="Remove channel link"
  message={pendingUnlink
    ? `Remove the link to Slack channel ${pendingUnlink.slackChannelId}? Messages will stop mirroring.`
    : ""}
  confirmLabel="Remove"
  cancelLabel="Cancel"
  destructive
  onconfirm={confirmUnlink}
  oncancel={() => (pendingUnlink = null)}
/>
