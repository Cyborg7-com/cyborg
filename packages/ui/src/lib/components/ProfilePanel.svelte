<script lang="ts">
  // Slide-in Profile side panel — ported from cyborg7-core's
  // ProfileSidePanel.tsx. Renders a HUMAN card (avatar, name, email, role,
  // status) or an AGENT card (avatar + presence, Reports To, Managed By, last
  // heartbeat countdown, recent activity, Agent ID copy, View Full Profile +
  // Message). Resizable on wide screens; an overlay variant on narrow ones.
  //
  // NOTE: the rewrite's agent/member state does not (yet) expose reportsTo,
  // ownedByUserId, lastHeartbeatAt or heartbeatIntervalSeconds — those sections
  // degrade gracefully (hidden) when the data is missing.
  import { goto } from "$app/navigation";
  import PanelHeader from "$lib/components/PanelHeader.svelte";
  import { agentDisplayName as sharedAgentDisplayName, PROVIDER_LABELS } from "$lib/agent-display.js";
  import ProviderIcon from "$lib/plugins/agents/components/ProviderIcon.svelte";
  import { page } from "$app/state";
  import { authState, workspaceState, presenceState, workspaceUserStatusesState, messageFocusState } from "$lib/state/app.svelte.js";
  import { cyboState, daemonState } from "$lib/plugins/agents/state.svelte.js";
  import { profilePanelState } from "$lib/profile-panel.svelte.js";
  import { cn, isExternalSlack } from "$lib/utils.js";
  import Emoji from "$lib/components/Emoji.svelte";
  import Avatar from "./Avatar.svelte";
  import HeartbeatCountdown from "./HeartbeatCountdown.svelte";
  import SharedFilesPanel from "./SharedFilesPanel.svelte";
  import { isTauriIOS } from "$lib/mobile/push.js";
  import { setNativeVisibility } from "$lib/mobile/nativeComposer.js";

  let {
    onMessage,
    overlay = false,
  }: {
    onMessage?: () => void;
    overlay?: boolean;
  } = $props();

  const target = $derived(profilePanelState.target);
  const wsId = $derived(page.params.id);

  // ─── Human resolution ───
  const member = $derived(
    target?.kind === "human"
      ? workspaceState.members.find((m) => m.userId === target.id)
      : undefined,
  );

  // ─── Agent resolution ───
  // Match by agentId first, then fall back to a cybo entry (slug / id).
  const agentData = $derived(
    target?.kind === "agent"
      ? workspaceState.agents.find(
          (a: { agentId?: string; cyboId?: string }) =>
            a.agentId === target.id || a.cyboId === target.id,
        )
      : undefined,
  );
  const cybo = $derived(
    target?.kind === "agent"
      ? cyboState.list.find((c) => c.id === target.id || c.slug === target.id) ??
          (agentData?.cyboId
            ? cyboState.list.find((c) => c.id === agentData.cyboId)
            : undefined)
      : undefined,
  );

  const name = $derived.by(() => {
    if (target?.kind === "human") {
      return member?.name ?? member?.email?.split("@")[0] ?? "User";
    }
    if (agentData) return sharedAgentDisplayName(agentData, cyboState.list);
    return cybo?.name ?? target?.id ?? "Agent";
  });
  const image = $derived.by(() => {
    if (target?.kind === "human") return target ? authState.getMemberImage(target.id) : null;
    return cybo?.avatar ?? null;
  });
  const role = $derived(
    target?.kind === "human" ? (member?.role ?? null) : (cybo?.role ?? null),
  );
  const email = $derived(target?.kind === "human" ? (member?.email ?? null) : null);
  // Slash AI results attribute to "provider:<id>" and carry the daemon that ran
  // them; surface its label (resolved from the daemon list, else the raw id).
  const slashDaemonLabel = $derived.by(() => {
    const id = target?.daemonId;
    if (!id || target?.kind !== "agent" || !target.id.startsWith("provider:")) return null;
    return daemonState.byId(id)?.label ?? id;
  });
  const online = $derived(
    target?.kind === "human" && target ? presenceState.isOnline(target.id) : false,
  );
  // P2 Item 6: a human who manually set themselves away (a subset of online).
  const away = $derived(
    target?.kind === "human" && target ? presenceState.isAway(target.id) : false,
  );
  // A mirrored Slack guest: we have no real presence for them, and DMs don't
  // route to Slack — so suppress the presence dot and disable the Message button.
  const isSlackGuest = $derived(
    target?.kind === "human" && target ? isExternalSlack(target.id) : false,
  );
  // P2 #5-T2: the target human's custom status (emoji + text), synced via
  // fetch_user_statuses / user_status_changed. Self-status isn't in this map, so
  // it stays hidden on your own profile (which is expected for the side panel).
  const customStatus = $derived(
    target?.kind === "human" && target ? workspaceUserStatusesState.get(target.id) : null,
  );
  // The rewrite agent state has no server-driven heartbeat/lastSeen, so these
  // stay undefined and their sections hide.
  const lastHeartbeatAt = $derived<string | null>(null);
  const heartbeatIntervalSeconds = 300;

  const agentId = $derived(
    target?.kind === "agent" ? (agentData?.agentId ?? target.id) : undefined,
  );

  // The cybo behind this agent — drives the "full profile" navigation (the cybo
  // profile page, not the live conversation) and the clickable name. A raw
  // session (slash AI result / provider-only agent) has no cybo, so this is null
  // and we keep the old conversation-route behavior.
  const cyboId = $derived(
    target?.kind === "agent" ? (cybo?.id ?? agentData?.cyboId ?? null) : null,
  );

  // Provider + model identity row (mirrors the cybo profile's meta row). Prefer
  // the cybo's declared backend, falling back to the live agent's provider/model.
  const provider = $derived(
    target?.kind === "agent" ? (cybo?.provider ?? agentData?.provider ?? null) : null,
  );
  const providerLabel = $derived(
    provider ? (PROVIDER_LABELS[provider] ?? provider) : null,
  );
  // Short model label (drop the provider/ prefix, e.g. claude/sonnet → sonnet).
  const modelLabel = $derived.by(() => {
    const m = cybo?.model ?? agentData?.model ?? null;
    return m ? (m.split("/").pop() ?? m) : null;
  });

  let width = $state(320);
  let copied = $state(false);

  // Resize handle (wide screens only).
  let dragging = false;
  let startX = 0;
  let startW = 0;
  function onResizeStart(e: MouseEvent): void {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startW = width;
    const onMove = (ev: MouseEvent): void => {
      if (!dragging) return;
      const delta = startX - ev.clientX;
      width = Math.min(Math.max(startW + delta, 280), 600);
    };
    const onUp = (): void => {
      dragging = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  // iOS: this profile panel's overlay variant is a full-screen web sheet over
  // the chat, but the native composer pill is a window-anchored UIKit overlay
  // ABOVE the WebView, so it would bleed through on top of the sheet. Hide it
  // while the overlay sheet is open (mobile only) and restore it on close.
  // Pure visibility toggle — never touches ownership / first-responder /
  // constraints. No-op off iOS (web/desktop/Android untouched). Only the
  // `overlay` (mobile full-screen) variant hides it; the desktop side panel
  // sits beside the chat and must not.
  $effect(() => {
    if (!isTauriIOS()) return;
    const open = target != null && overlay;
    if (!open) return;
    void setNativeVisibility(false);
    return () => {
      void setNativeVisibility(true);
    };
  });

  function close(): void {
    profilePanelState.close();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
  }

  function copyAgentId(): void {
    if (!agentId) return;
    void navigator.clipboard.writeText(agentId);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  // "View Full Profile" + the clickable name. For a real cybo this goes to the
  // cybo profile page (/cybo/<id>); a raw session (no cybo) keeps the old
  // behavior of opening the live agent conversation.
  function viewFullProfile(): void {
    if (target?.kind !== "agent") return;
    // Capture BEFORE close(): cyboId/agentId/wsId-derived values read from
    // `target`, which close() nulls synchronously — reading them after would be
    // null and silently skip the navigation.
    const toCybo = cyboId;
    const toAgent = agentId;
    const ws = wsId;
    close();
    if (toCybo) {
      void goto(`/workspace/${ws}/cybo/${toCybo}`);
    } else if (toAgent) {
      void goto(`/workspace/${ws}/agent/${toAgent}`);
    }
  }
</script>

<svelte:window onkeydown={target ? onKeydown : undefined} />

{#snippet panelContent()}
  <PanelHeader title="Profile" onClose={close} closeLabel="Close profile" />

  <div class="flex-1 overflow-y-auto break-words">
    <!-- Avatar + name -->
    <div class="flex flex-col items-center pt-6 pb-4">
      <Avatar {name} {image} width={120} fontSize={36} borderRadius={16} />
      <div class="mt-4 flex items-center gap-2">
        {#if target?.kind === "agent" && (cyboId || agentId)}
          <!-- Agent name links to the full profile page (cybo profile, or the live
               conversation for a raw session). Kept as an <h3> for heading
               semantics, with a button inside as the click target. -->
          <h3 class="m-0">
            <button
              type="button"
              onclick={viewFullProfile}
              class="cursor-pointer break-words border-0 bg-transparent p-0 text-center text-[18px] font-bold text-white hover:underline"
              aria-label={`View ${name}'s full profile`}
            >{name}</button>
          </h3>
        {:else}
          <h3 class="break-words text-center text-[18px] font-bold text-white">{name}</h3>
        {/if}
        {#if target?.kind === "human"}
          {#if isSlackGuest}
            <!-- No Slack presence signal — show a muted external marker, not a
                 misleading Away/Active dot. -->
            <span class="text-[13px] text-content-muted">Slack</span>
          {:else if online && !away}
            <span class="h-2.5 w-2.5 shrink-0 rounded-full bg-online" title="Active"></span>
          {:else}
            <!-- Away = manual toggle OR offline (app/laptop closed); one grey dot. -->
            <span class="h-2.5 w-2.5 shrink-0 rounded-full bg-content-dim" title="Away"></span>
            <span class="text-[13px] text-content-muted">Away</span>
          {/if}
        {/if}
      </div>
      <!-- P2 #5-T2: custom status (emoji + text) for human targets. -->
      {#if target?.kind === "human" && customStatus && (customStatus.emoji || customStatus.text)}
        <div class="mt-1.5 flex items-center justify-center gap-1.5 px-4">
          {#if customStatus.emoji}
            <Emoji emoji={customStatus.emoji} size={15} />
          {/if}
          {#if customStatus.text}
            <span class="break-words text-center text-[13px] text-content-muted">{customStatus.text}</span>
          {/if}
        </div>
      {/if}
      {#if target?.kind === "agent"}
        <span class="mt-1 text-[13px] text-content-muted">
          {online ? "Heartbeat confirmed" : "Offline"}
        </span>
      {/if}
      {#if role}
        <span class="role-badge mt-2">{role}</span>
      {/if}
      <!-- Provider/model identity row (agents only) — matches the cybo profile's
           meta row so the panel reads consistently with the full page. -->
      {#if target?.kind === "agent" && providerLabel}
        <div class="mt-2 flex flex-wrap items-center justify-center gap-1.5 px-4 text-[12.5px] text-content-dim">
          <ProviderIcon {provider} size={14} class="text-content-dim" />
          <span class="capitalize">{providerLabel}</span>
          {#if modelLabel}
            <span class="rounded bg-edge-dim px-1.5 py-[1px] font-mono text-[11.5px] text-content-dim">{modelLabel}</span>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Action buttons -->
    <div class="flex justify-center gap-2 px-4 pb-4">
      {#if target?.kind === "agent" && agentId}
        <button type="button" onclick={viewFullProfile}
          class="cursor-pointer rounded-lg px-5 py-2 text-center text-[13px] font-bold text-white transition-colors"
          style="background-color: var(--bg-elevated);">
          View Full Profile
        </button>
      {/if}
      {#if onMessage}
        {#if isSlackGuest}
          <button type="button" disabled
            title="Replies to Slack users go through the linked channel, not DMs"
            class="cursor-not-allowed rounded-lg px-5 py-2 text-center text-[13px] font-bold text-white opacity-50"
            style="background-color: var(--bg-elevated);">
            Message
          </button>
        {:else}
          <button type="button" onclick={onMessage}
            class="cursor-pointer rounded-lg px-5 py-2 text-center text-[13px] font-bold text-white transition-colors"
            style="background-color: var(--bg-elevated);">
            Message
          </button>
        {/if}
      {/if}
    </div>

    <!-- Last Heartbeat (agents only — only when we have a heartbeat) -->
    {#if target?.kind === "agent" && lastHeartbeatAt}
      <div class="px-4 pb-4">
        <span class="mb-2 block text-[12px] font-semibold text-content-dim">Last Heartbeat</span>
        <div class="rounded-lg px-3 py-2.5" style="background-color: var(--bg-elevated); border: 1px solid var(--border);">
          <div class="flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="#10b981" stroke-width="1.2" /><path d="M5.5 8l2 2 3-3.5" stroke="#10b981" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
            <span class="text-[12px] text-online">succeeded</span>
          </div>
          <p class="mt-1.5 text-[11px] text-content-dim">Heartbeat confirmed — agent is alive and running smoothly.</p>
          <div class="mt-2 border-t border-edge pt-2">
            <HeartbeatCountdown {lastHeartbeatAt} {heartbeatIntervalSeconds} variant="compact" />
          </div>
        </div>
      </div>
    {/if}

    <!-- Email (humans only) -->
    {#if email}
      <div class="px-4 pb-4">
        <span class="mb-2 block text-[14px] font-bold text-white">Email</span>
        <div class="flex items-center gap-2">
          <span class="flex-1 truncate text-[13px] text-content-muted">{email}</span>
        </div>
      </div>
    {/if}

    <!-- Daemon (slash AI result — which daemon executed the command) -->
    {#if slashDaemonLabel}
      <div class="px-4 pb-4">
        <span class="mb-2 block text-[14px] font-bold text-white">Daemon</span>
        <div class="flex items-center gap-2">
          <span class="flex-1 truncate text-[13px] text-content-muted">{slashDaemonLabel}</span>
        </div>
      </div>
    {/if}

    <!-- Shared Files (humans only — the 1:1 DM thread with this person) -->
    {#if target?.kind === "human" && target.id !== authState.user?.id}
      <SharedFilesPanel
        source={{ kind: "dm", peerId: target.id }}
        onJump={(messageId) => {
          // Capture peerId BEFORE close() — close() sets profilePanelState.target
          // to null immediately (Svelte 5 batch.js: source.v = null inline), so
          // reading target.id after close() is a TypeError that swallows the goto.
          const peerId = target.id;
          // focus() is a module-singleton write — survives the navigation and is
          // picked up by the DM page's focus $effect after the route settles.
          messageFocusState.focus(messageId);
          close();
          // noScroll: suppress SvelteKit's own scroll-restoration on navigation so
          // the focus $effect's scrollIntoView is the single source of truth for
          // where the viewport lands.
          void goto(`/workspace/${wsId}/dm/${peerId}`, { noScroll: true });
        }}
      />
    {/if}

    <!-- Shared Files (agents) — files a human uploaded TO this agent. Backed by
         fetch_dm_files with peerId = agentId (no new RPC); the DM-files query
         matches messages either direction between the user and this peer. Does
         NOT include agent-produced images (those live inline in assistant text,
         never as structured attachments). -->
    {#if target?.kind === "agent" && agentId}
      <SharedFilesPanel
        source={{ kind: "agent", agentId }}
        onJump={() => {
          // The agent timeline (AgentStreamView) isn't message-id addressable, so
          // there's no scroll-to-message yet — a file jump just returns to the
          // agent conversation. Capture agentId before close() nulls the target.
          const id = agentId;
          close();
          void goto(`/workspace/${wsId}/agent/${id}`);
        }}
      />
    {/if}

    <!-- Agent ID -->
    {#if target?.kind === "agent" && agentId}
      <div class="px-4 pb-4">
        <span class="mb-2 block text-[14px] font-bold text-white">Agent ID</span>
        <div class="flex items-center gap-2">
          <span class="flex-1 truncate font-mono text-[13px] text-content-muted">{agentId}</span>
          <button type="button" onclick={copyAgentId}
            class={cn(
              "shrink-0 cursor-pointer rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-all duration-200",
              copied ? "scale-95 border-online/40 bg-online/10 text-online" : "border-edge text-content hover:bg-raised",
            )}>
            {copied ? "✓ Copied" : "Copy"}
          </button>
        </div>
      </div>
    {/if}
  </div>
{/snippet}

{#if target}
  {#if overlay}
    <!-- Mobile: full-screen sheet covering the chat + composer (the header's
         close button returns). Top/bottom safe-area so it clears the notch and
         home indicator. `overlay` is rendered only when viewportState.isMobile
         (see channel/dm pages), so the full-screen sheet is iOS/mobile-correct. -->
    <div class="fixed inset-0 z-[var(--z-sheet)] flex flex-col"
      style="background-color: var(--bg-base); padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom);"
      role="dialog"
      aria-modal="true"
      aria-label="Profile"
    >
      {@render panelContent()}
    </div>
  {:else}
    <div class="relative flex h-full shrink-0 flex-col border-l border-edge shadow-xl"
      style="background-color: var(--bg-base); width: {width}px;">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="absolute top-0 -left-1 z-10 h-full w-2 cursor-col-resize" onmousedown={onResizeStart}></div>
      {@render panelContent()}
    </div>
  {/if}
{/if}
