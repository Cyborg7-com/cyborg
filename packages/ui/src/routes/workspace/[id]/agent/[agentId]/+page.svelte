<script lang="ts">
  import { untrack } from "svelte";
  import { agentDisplayName as sharedAgentDisplayName, providerBrandColor } from "$lib/agent-display.js";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { workspaceState, agentStreamState, attentionState, client, userStatusState, authState, cyboState, connectionState, notificationState, daemonState, fetchProviders } from "$lib/state/app.svelte.js";
  import { fetchAgentTimeline } from "$lib/plugins/agents/state.svelte.js";
  import { rewindAgent } from "$lib/state/app.svelte.js";
  import AgentStreamView from "$lib/plugins/agents/components/AgentStreamView.svelte";
  import AgentComposer from "$lib/plugins/agents/components/AgentComposer.svelte";
  import PendingPermissionsPanel from "$lib/plugins/agents/components/PendingPermissionsPanel.svelte";
  import ProviderIcon from "$lib/plugins/agents/components/ProviderIcon.svelte";
  import Avatar from "$lib/components/Avatar.svelte";
  import ProfilePanel from "$lib/components/ProfilePanel.svelte";
  import SessionResumePicker from "$lib/components/channel/SessionResumePicker.svelte";
  import { profilePanelState } from "$lib/profile-panel.svelte.js";
  import { resolveCyboChatIdentity } from "$lib/cybo-chat-identity.js";
  import { toast } from "svelte-sonner";
  import { cn } from "$lib/utils.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import { goBackFromConversation } from "$lib/mobile/swipeBack";

  const agent = $derived(
    workspaceState.agents.find((a) => a.agentId === page.params.agentId),
  );
  const workspaceId = $derived(workspaceState.current?.id);
  const pendingPermissions = $derived(
    agent ? agentStreamState.getPendingPermissions(agent.agentId) : [],
  );
  const turnStatus = $derived(
    agent ? agentStreamState.getTurnStatus(agent.agentId) : "idle",
  );
  const usage = $derived(
    agent ? agentStreamState.getUsage(agent.agentId) : null,
  );
  const runtimeInfo = $derived(
    agent ? agentStreamState.getRuntimeInfo(agent.agentId) : null,
  );

  const cybo = $derived(
    agent?.cyboId ? cyboState.list.find((c) => c.id === agent.cyboId) : undefined,
  );
  // Navigation hint (?cybo=<id>, appended by Start chat / the create dialog):
  // the cybo's identity from the client's OWN roster, available from frame 0 —
  // before the agents-list row settles and independent of server denorm. This
  // is what kills the ghost-chat placeholders (Cyborg logo / bot icon).
  const hintedCybo = $derived.by(() => {
    const id = page.url.searchParams.get("cybo");
    return id ? cyboState.list.find((c) => c.id === id) : undefined;
  });
  const chatIdentity = $derived(
    resolveCyboChatIdentity({ agent: agent ?? null, rosterCybo: cybo, hintedCybo }),
  );
  const agentDisplayName = $derived(
    chatIdentity.name ??
      (agent ? sharedAgentDisplayName(agent, cyboState.list) : (hintedCybo?.name ?? "Agent")),
  );
  const agentAvatar = $derived(chatIdentity.image);
  const isCyboSession = $derived(chatIdentity.isCybo);

  // The REAL daemon this session runs on. The registered label is the host's
  // name (the daemon reports os.hostname()); fall back to the owner's name, and
  // only then to a generic local/remote indicator. Previously this just printed
  // "Local"/"Remote" from the daemonLocal flag, hiding the actual machine.
  const sessionDaemon = $derived(
    agent?.daemonId ? daemonState.byId(agent.daemonId) : undefined,
  );
  const sessionDaemonOwnerName = $derived(
    sessionDaemon
      ? (workspaceState.members?.find((m) => m.userId === sessionDaemon.ownerId)?.name ?? null)
      : null,
  );
  const daemonName = $derived(
    sessionDaemon?.label ||
      sessionDaemonOwnerName ||
      (agent?.daemonLocal === false ? "Remote daemon" : "Local daemon"),
  );

  // In-flight guard, keyed by the session's daemonId, so rapid double-clicks on
  // "Re-check" don't fan out concurrent heavy provider refreshes against the
  // same daemon. (`__local` stands in for the no-daemon case.)
  const recheckInFlight: Record<string, boolean> = {};

  // Re-probe THIS session's daemon providers — wired to the turn-error remedy's
  // "Re-check" (rate-limit) action and the setup-terminal's onClosed (after a
  // reconnect/login, refresh so a healed provider clears the error on retry).
  async function recheckSessionProviders(): Promise<void> {
    if (!workspaceId) return;
    const daemonId = agent?.daemonId ?? undefined;
    const key = daemonId ?? "__local";
    if (recheckInFlight[key]) return;
    recheckInFlight[key] = true;
    try {
      // intentional: best-effort provider re-probe; the fetchProviders below refreshes the view, a failed probe keeps the prior snapshot.
      await client.refreshProviders(workspaceId, daemonId).catch(() => {});
      await fetchProviders(daemonId);
    } finally {
      recheckInFlight[key] = false;
    }
  }

  // 'Rewind to here' (#649): confirmed in AgentStreamView, executed here. On
  // success the wrapper re-hydrates the truncated stream; surface failures so a
  // rejected rewind (e.g. provider can't rewind to that turn) isn't silent.
  //
  // In-flight guard: rewind is destructive (it discards every turn after the
  // anchor). A rapid double-click — or clicking while a rewind is still running —
  // must NOT fan out concurrent truncations against the same session, so we
  // early-return when one is already in flight and disable the per-row Rewind
  // button below (threaded into AgentStreamView) for the duration.
  let isRewinding = $state(false);
  async function handleRewind(agentId: string, messageId: string): Promise<void> {
    if (isRewinding) return;
    isRewinding = true;
    try {
      await rewindAgent(agentId, messageId);
      toast.success("Rewound to that point.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't rewind the session.");
    } finally {
      isRewinding = false;
    }
  }

  const isArchivedView = $derived(page.url.searchParams.get("from") === "session");

  // Viewing an agent reads its conversation — clear its unread badge (agent
  // replies badge keyed by agentId, mirroring human DMs).
  $effect(() => {
    if (agent && workspaceId) notificationState.clear(workspaceId, agent.agentId);
  });

  // #591: viewing the agent also dismisses its derived "needs attention" badge
  // (finished/errored — review me). Clear the client flag immediately (the
  // falsifiable DONE) AND tell the owning daemon so the authoritative flag is
  // reset — otherwise the next list snapshot would resurrect the badge. Mirrors
  // how the unread badge clears locally + the read is sent to the relay.
  $effect(() => {
    if (!agent || !workspaceId) return;
    const agentId = agent.agentId;
    // Read + mutate the attention store inside untrack: this effect must re-run
    // only when the viewed agent/workspace changes, not when clearForView mutates
    // `reasons` (which this same effect just read — an avoidable self-retrigger).
    untrack(() => {
      if (!attentionState.requiresAttention(agentId)) return;
      attentionState.clearForView(agentId);
      if (connectionState.status === "connected") {
        client.clearAgentAttention(workspaceId, agentId);
      }
    });
  });

  let showInfoBar = $state(false);

  // Open the right-side Profile panel for this agent (mirrors the human DM
  // header). ProfilePanel resolves the agent by agentId first, then by cyboId —
  // so the ?cybo= hint's id works before the agents-list row settles.
  function openAgentProfile(): void {
    const id = agent?.agentId ?? hintedCybo?.id;
    if (id) profilePanelState.open("agent", id, agent?.daemonId ?? null);
  }

  function handleResumeSession() {
    const url = new URL(page.url);
    url.searchParams.delete("from");
    goto(url.pathname, { replaceState: true });
  }

  // Close any open Profile panel when switching agents, so a stale panel from
  // the previous agent doesn't carry across the navigation (mirrors the
  // channel/dm pages' close-on-nav). Tracks ONLY the route param; the close is
  // untracked so reading/writing the store doesn't retrigger this effect.
  $effect(() => {
    // oxlint-disable-next-line eslint/no-unused-expressions -- reactive dependency
    page.params.agentId;
    untrack(() => profilePanelState.close());
  });

  $effect(() => {
    const currentAgent = agent;
    const wsId = workspaceId;
    // Track connection: the history fetch is forwarded over the WS, so firing it
    // before we're connected (e.g. right after login) throws and was silently
    // swallowed — leaving the chat blank until a manual reload. Re-run when the
    // connection becomes ready so it retries automatically.
    const connected = connectionState.status === "connected";

    if (!currentAgent && wsId) {
      // The agent vanished (archived/removed, stale URL — or a fresh spawn that
      // died right after its ack). ROLLBACK: land on the agents list instead of
      // leaving a ghost chat. When we arrived straight from a Start chat click
      // (?cybo= hint present), say so — a silent bounce reads as "nothing
      // happened".
      if (hintedCybo) {
        toast.error(
          `Couldn't open the chat with ${hintedCybo.name} — the session didn't start.`,
        );
      }
      goto(`/workspace/${wsId}/agents`);
      return;
    }
    if (currentAgent && connected) {
      untrack(() => fetchAgentTimeline(client, currentAgent.agentId));
    }
  });

</script>

{#if agent}
  <div class="relative flex h-full flex-col overflow-hidden font-lato">
    {#if viewportState.isMobile}
      <!-- ── Mobile header (S6/P6): back chevron · avatar + name (tap opens the
           Profile panel) · chevron (toggles the info card) · single status chip
           (running / cost). The Remote/Local badge lives in the info card. ── -->
      <header class="hairline-b flex shrink-0 items-center gap-1 px-2 py-1" style="background-color: var(--bg-base);">
        <button
          type="button"
          onclick={goBackFromConversation}
          class="pressable flex h-[44px] w-[40px] shrink-0 items-center justify-center rounded-[10px]"
          aria-label="Back"
        >
          <svg class="h-[22px] w-[22px] text-content-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <button
          type="button"
          onclick={openAgentProfile}
          aria-label="View agent profile"
          class="pressable flex min-h-[44px] min-w-0 flex-1 items-center gap-2.5 rounded-[10px] px-1 text-left"
        >
          {#if agentAvatar}
            <img src={agentAvatar} alt="" class="h-[30px] w-[30px] shrink-0 rounded-full object-cover" />
          {:else if chatIdentity.emoji}
            <span class="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-surface-alt text-[18px] leading-none" aria-hidden="true">{chatIdentity.emoji}</span>
          {:else if isCyboSession}
            <Avatar name={agentDisplayName} width={30} fontSize={13} />
          {:else}
            <span class="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] bg-surface-alt">
              <ProviderIcon provider={agent.provider} size={16} class="text-content" />
            </span>
          {/if}
          <span class="min-w-0 truncate text-[17px] font-semibold leading-[22px] text-content">{agentDisplayName}</span>
        </button>
        <button
          type="button"
          onclick={() => showInfoBar = !showInfoBar}
          aria-expanded={showInfoBar}
          aria-label="Agent info"
          class="pressable flex h-[44px] w-[34px] shrink-0 items-center justify-center rounded-[10px]"
        >
          <svg
            class={cn("h-3.5 w-3.5 shrink-0 text-content-muted transition-transform", showInfoBar && "rotate-180")}
            viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
          ><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        {#if turnStatus === "running"}
          <span class="mr-1 flex h-[26px] shrink-0 items-center gap-1.5 rounded-full bg-surface-alt px-2.5 text-[13px] font-medium text-content-dim">
            <span class="h-[7px] w-[7px] rounded-full bg-online animate-pulse"></span>
            Running
          </span>
        {:else if usage?.totalCostUsd != null}
          <span class="mr-1 flex h-[26px] shrink-0 items-center rounded-full bg-surface-alt px-2.5 text-[13px] tabular-nums text-content-muted">
            ${usage.totalCostUsd < 0.01 ? usage.totalCostUsd.toFixed(4) : usage.totalCostUsd.toFixed(2)}
          </span>
        {/if}
      </header>

      <!-- Info card (same fields as the desktop info bar, iOS-shaped). -->
      {#if showInfoBar}
        <div class="shrink-0 px-4 pb-2 pt-2" style="background-color: var(--bg-base);">
          <div class="flex flex-col gap-2 rounded-[14px] bg-surface-alt px-4 py-3">
            <div class="flex items-baseline gap-3">
              <span class="w-[64px] shrink-0 text-[11px] font-semibold uppercase tracking-[0.06em] text-content-muted">ID</span>
              <span class="min-w-0 flex-1 truncate font-mono text-[13px] text-content-dim">{agent.agentId.slice(0, 16)}</span>
            </div>
            {#if agent.cwd}
              <div class="flex items-baseline gap-3">
                <span class="w-[64px] shrink-0 text-[11px] font-semibold uppercase tracking-[0.06em] text-content-muted">CWD</span>
                <span class="min-w-0 flex-1 break-all font-mono text-[13px] leading-[18px] text-content-dim">{agent.cwd}</span>
              </div>
            {/if}
            {#if runtimeInfo?.sessionId}
              <div class="flex items-baseline gap-3">
                <span class="w-[64px] shrink-0 text-[11px] font-semibold uppercase tracking-[0.06em] text-content-muted">Session</span>
                <span class="min-w-0 flex-1 truncate font-mono text-[13px] text-content-dim">{runtimeInfo.sessionId.slice(0, 12)}</span>
              </div>
            {/if}
            <div class="flex items-baseline gap-3">
              <span class="w-[64px] shrink-0 text-[11px] font-semibold uppercase tracking-[0.06em] text-content-muted">Daemon</span>
              <span class="min-w-0 flex-1 truncate text-[13px] text-content-dim">
                {daemonName} · {agent.daemonLocal === false ? "Remote" : "Local"}
              </span>
            </div>
          </div>
        </div>
      {/if}
    {:else}
    <!-- Header (desktop) — avatar + name open the right-side Profile panel
         (mirrors the human DM header). -->
    <header class="flex items-center gap-2 border-b border-edge px-6 py-2.5 shrink-0">
      <!-- Avatar is a redundant click target for the name button below; kept
           mouse-clickable but out of the tab order + a11y tree to avoid two
           focusable controls with the same action. -->
      <button
        type="button"
        onclick={openAgentProfile}
        class="flex cursor-pointer items-center border-0 bg-transparent p-0"
        tabindex="-1"
        aria-hidden="true"
      >
        {#if agentAvatar}
          <img src={agentAvatar} alt="" class="w-[18px] h-[18px] rounded-full object-cover" />
        {:else if chatIdentity.emoji}
          <span class="text-[15px] leading-none" aria-hidden="true">{chatIdentity.emoji}</span>
        {:else if isCyboSession}
          <!-- Placeholder identity is the CYBO's (its name → initials), never the
               Cyborg logo / generic bot. -->
          <Avatar name={agentDisplayName} width={18} fontSize={9} />
        {:else}
          <span
            class="flex h-[18px] w-[18px] items-center justify-center rounded"
            style="background: color-mix(in srgb, {providerBrandColor(agent.provider) ?? 'var(--border-dim)'} 14%, transparent); color: {providerBrandColor(agent.provider) ?? 'var(--border-dim)'};"
          >
            <ProviderIcon provider={agent.provider} size={12} />
          </span>
        {/if}
      </button>
      <button
        type="button"
        onclick={openAgentProfile}
        class="cursor-pointer border-0 bg-transparent p-0 text-left text-sm font-semibold text-content hover:underline"
      >{agentDisplayName}</button>

      {#if turnStatus === "running"}
        <div class="h-2 w-2 rounded-full bg-online animate-pulse"></div>
      {/if}

      <div class="ml-auto flex items-center gap-2">
        {#if usage?.totalCostUsd != null}
          <span class="text-[10px] text-content-dim">
            ${usage.totalCostUsd < 0.01 ? usage.totalCostUsd.toFixed(4) : usage.totalCostUsd.toFixed(2)}
          </span>
        {/if}

        <span class={cn(
          "rounded px-1.5 py-0.5 text-[10px] font-medium",
          agent.daemonLocal === false
            ? "bg-warning/15 text-warning"
            : "bg-surface-alt text-content-muted",
        )}>
          {agent.daemonLocal === false ? "Remote" : "Local"}
        </span>

        <button
          onclick={() => showInfoBar = !showInfoBar}
          class="rounded p-1 text-content-muted hover:text-content hover:bg-hover-gray transition-colors"
          title="Agent info"
        >
          <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="16" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
        </button>
      </div>
    </header>

    <!-- Info bar (collapsible) -->
    {#if showInfoBar}
      <div class="flex items-center gap-4 border-b border-edge bg-surface-alt px-6 py-2 text-[11px] text-content-muted shrink-0">
        <span>
          <span class="text-content-dim">ID:</span> {agent.agentId.slice(0, 16)}
        </span>
        {#if agent.cwd}
          <span>
            <span class="text-content-dim">CWD:</span>
            <span class="font-mono">{agent.cwd}</span>
          </span>
        {/if}
        {#if runtimeInfo?.sessionId}
          <span>
            <span class="text-content-dim">Session:</span>
            <span class="font-mono">{runtimeInfo.sessionId.slice(0, 12)}</span>
          </span>
        {/if}
        <span>
          <span class="text-content-dim">Daemon:</span>
          {daemonName}
        </span>
      </div>
    {/if}
    {/if}

    <AgentStreamView agentId={agent.agentId} agentName={agentDisplayName} provider={agent.provider} providerLabel={agent.provider} daemonLabel={daemonName} onRecheck={recheckSessionProviders} agentImage={agentAvatar} agentEmoji={chatIdentity.emoji} isCybo={isCyboSession} onRewind={(messageId) => handleRewind(agent.agentId, messageId)} {isRewinding} userImage={authState.user?.imageUrl ?? authState.profileImage} userStatusEmoji={userStatusState.emoji} userStatusTooltip={userStatusState.tooltip || null} />

    {#if pendingPermissions.length > 0}
      <div class="bg-surface px-6 py-3 shrink-0 max-h-64 overflow-y-auto">
        <PendingPermissionsPanel agentId={agent.agentId} />
      </div>
    {/if}

    {#if isArchivedView}
      <div class="bg-surface px-4 py-3 shrink-0">
        <div class="mx-auto max-w-3xl flex items-center justify-between gap-3 rounded-2xl border border-edge bg-surface-alt px-5 py-3">
          <div class="flex items-center gap-2 text-sm text-content-muted min-w-0">
            <svg class="shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><path d="M8 21h8"/><path d="M12 17v4"/>
            </svg>
            <span class="truncate">Archived session</span>
          </div>
          <button
            onclick={handleResumeSession}
            class="flex items-center gap-2 rounded-full bg-btn-primary-bg px-4 py-1.5 text-[13px] font-medium text-btn-primary-text transition-colors hover:bg-btn-primary-hover shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>
              <path d="M21 3v5h-5"/>
            </svg>
            Resume session
          </button>
        </div>
      </div>
    {:else}
      <AgentComposer {agent} />
    {/if}

    <!-- Right-side Profile panel (desktop) / full-screen overlay (mobile),
         mirroring the channel/dm pages. viewFullProfile inside the panel routes
         to the cybo profile, so no onMessage handler is needed here. -->
    {#if profilePanelState.target}
      {#if viewportState.isMobile}
        <ProfilePanel overlay />
      {:else}
        <div class="absolute right-0 top-0 z-30 h-full">
          <ProfilePanel />
        </div>
      {/if}
    {/if}

    <!-- /resume session picker (opened from the agent composer's /status·/resume
         builtins). Driven by resumePickerState; mirrors the channel page mount. -->
    <SessionResumePicker />
  </div>
{:else}
  <div class="flex h-full items-center justify-center text-sm text-content-muted">
    Agent not found
  </div>
{/if}
