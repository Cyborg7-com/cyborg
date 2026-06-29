<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { agentDisplayName as sharedAgentDisplayName, providerBrandColor } from "$lib/agent-display.js";
  import ProviderIcon from "$lib/plugins/agents/components/ProviderIcon.svelte";
  import CyboSessionAvatar from "$lib/components/CyboSessionAvatar.svelte";
  import {
    workspaceState,
    agentStreamState,
    authState,
    cyboState,
    activityState,
    dmActivityState,
    presenceState,
    daemonState,
  } from "$lib/state/app.svelte.js";
  import type { ActivityItem, ActivityEventType } from "$lib/state/app.svelte.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import { setNavOrigin } from "$lib/mobile/navOrigin";
  import ConversationRow, { conversationTime } from "$lib/components/channel/ConversationRow.svelte";
  import { cn } from "$lib/utils.js";
  import { visibleChannels } from "$lib/channel-visibility.js";
  import { relativeTime } from "$lib/utils/datetime.js";
  import Avatar from "../Avatar.svelte";
  import FirstRunWelcome from "./FirstRunWelcome.svelte";
  import HomeMissionControl from "./HomeMissionControl.svelte";

  let { workspaceId }: { workspaceId: string } = $props();

  const userName = $derived(
    authState.user?.name ?? authState.user?.email?.split("@")[0] ?? "there",
  );

  const agents = $derived(workspaceState.agents);

  // A cybo agent must show its cybo name (e.g. "Apex"), not its provider
  // ("opencode-go"). Mirrors ChannelSidebar.agentDisplayName: prefer the
  // server-denormalized cyboName, fall back to cyboState, then the provider.
  function agentDisplayName(agent: (typeof agents)[number]): string {
    return sharedAgentDisplayName(agent, cyboState.list);
  }

  // ─── First-run welcome (empty-workspace takeover) ─────────────────
  // Pillars of a "set up" workspace: a machine online, an agent created, and the
  // team invited. A brand-new company has none of these and gets the stepped
  // "Get started" checklist instead of the data-empty Home dashboard.
  const hasDaemonOnline = $derived(daemonState.online.length > 0);
  const hasAgents = $derived(agents.length > 0);
  const hasTeammates = $derived(workspaceState.members.length > 1);
  const isSetUp = $derived(hasDaemonOnline && hasAgents && hasTeammates);
  const userFirstName = $derived(authState.user?.name?.split(" ")[0] ?? null);
  const dismissKey = $derived(`cyborg7_welcome_dismissed_${workspaceId}`);

  let dismissed = $state(false);

  function dismissWelcome(): void {
    dismissed = true;
    try {
      localStorage.setItem(dismissKey, "1");
    } catch {
      // intentional: best-effort persistence of the welcome dismissal; the banner
      // is already hidden in-session via `dismissed`.
    }
  }

  // Single effect: read the persisted dismissal for THIS workspace first, then
  // auto-dismiss once all setup pillars exist. Both reads happen together so a
  // workspace switch can't evaluate auto-dismiss against the previous
  // workspace's `dismissed`. The auto-dismiss is also gated on the loaded data
  // actually belonging to this pane's workspaceId — during a switch,
  // `workspaceId` updates before `selectWorkspace` refreshes agents/members, so
  // without this gate a fresh (empty) workspace could get a dismissal persisted
  // from the previous workspace's signals and never show the welcome.
  $effect(() => {
    try {
      dismissed = localStorage.getItem(dismissKey) === "1";
    } catch {
      dismissed = false;
    }
    if (workspaceState.current?.id === workspaceId && isSetUp && !dismissed) {
      dismissWelcome();
    }
  });

  const showWelcome = $derived(!dismissed && !isSetUp);
  const runningCount = $derived(agents.filter((a) => a.lifecycle === "running").length);

  const pendingPermCount = $derived.by(() => {
    let count = 0;
    for (const a of agents) {
      count += agentStreamState.getPendingPermissions(a.agentId).length;
    }
    return count;
  });

  const totalCost = $derived.by(() => {
    let total = 0;
    for (const a of agents) {
      const usage = agentStreamState.getUsage(a.agentId);
      if (usage?.totalCostUsd) total += usage.totalCostUsd;
    }
    return total;
  });

  // Recent Activity = a compact mirror of the Activity tab. Same user-scoped
  // source (activityState — mentions, DMs to you, etc.), so it can never surface
  // other users' private DMs (the previous logState/getRecentActivity firehose
  // did). Newest first, top 6.
  const recentActivity = $derived(
    // createdAt is an ISO string — parse before comparing (string subtraction is
    // NaN, which silently made the sort a no-op and surfaced the OLDEST six).
    activityState.items
      .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 6),
  );

  function activityHeaderLabel(eventType: ActivityEventType): string {
    switch (eventType) {
      case "mention":
        return "Mentioned you";
      case "thread_reply":
        return "Replied to your thread";
      case "dm_received":
        return "Sent you a message";
      case "task_assigned":
        return "Assigned you a task";
      case "task_review_requested":
        return "Requested your review";
      case "reaction":
        return "Reacted to your message";
      case "permission_request":
        return "Needs permission";
      case "agent_error":
        return "Error";
      default:
        return eventType;
    }
  }

  function activityAccent(eventType: ActivityEventType): string {
    if (eventType === "permission_request" || eventType === "agent_error") return "#ef4444";
    if (eventType === "mention" || eventType === "thread_reply") return "#6366f1";
    if (eventType === "dm_received") return "var(--color-success)";
    return "var(--content-dim)";
  }

  function handleActivityClick(item: ActivityItem): void {
    activityState.markRead(item.id);
    if (item.channelId) {
      goto(`/workspace/${workspaceId}/channel/${item.channelId}`);
    } else if (item.eventType === "dm_received" && item.actorId) {
      goto(`/workspace/${workspaceId}/dm/${item.actorId}`);
    } else {
      goto(`/workspace/${workspaceId}/activity`);
    }
  }

  function todayLabel(): string {
    return new Date().toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }

  function lifecycleColor(lc: string): string {
    if (lc === "running") return "var(--color-success)";
    if (lc === "error") return "#ef4444";
    return "#6b7280";
  }

  function lifecycleLabel(lc: string): string {
    if (lc === "running") return "Running";
    if (lc === "error") return "Error";
    return "Idle";
  }

  function getUsageLabel(agentId: string): string | null {
    const usage = agentStreamState.getUsage(agentId);
    if (!usage?.totalCostUsd) return null;
    return `$${usage.totalCostUsd < 0.01 ? usage.totalCostUsd.toFixed(4) : usage.totalCostUsd.toFixed(2)}`;
  }


  function formatCost(v: number): string {
    if (v < 0.01) return "$0.00";
    return `$${v.toFixed(2)}`;
  }

  // ─── Mobile dashboard (S3 Home, v2 — web-home parity) ──────────────
  // Everything below feeds ONLY the viewportState.isMobile branch — the desktop
  // markup is untouched. v2 mirrors the desktop home's CONTENT (stats strip,
  // Agent sessions, Recent Activity — all unconditional) so the screen is never
  // empty; only "Jump back in" stays data-gated. DATA RULE: built strictly from
  // state already wired in this file (workspaceState, agentStreamState,
  // activityState, dmActivityState recency, presence).

  // "Good morning/afternoon/evening" from local time. Computed per render —
  // a stale daypart across a long-lived session is acceptable for v1.
  const greeting = $derived.by(() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  });
  const greetingName = $derived(
    authState.user?.name?.split(" ")[0] ?? authState.user?.email?.split("@")[0] ?? "there",
  );

  interface MobileRecentItem {
    kind: "dm" | "agent";
    id: string;
    name: string;
    image: string | null;
    agent: (typeof agents)[number] | null;
    presence: "online" | "away" | null;
    ts: number;
  }

  // "Jump back in": top 3 conversations by the EXISTING recency signal —
  // dmActivityState covers human DMs and agent DMs. Channels carry no
  // last-message timestamp client-side, so they are not ranked here (recorded
  // in the phase NOTES rather than inventing an ordering).
  const jumpBackIn = $derived.by<MobileRecentItem[]>(() => {
    const out: MobileRecentItem[] = [];
    for (const m of workspaceState.members) {
      if (m.userId === authState.user?.id) continue;
      const ts = dmActivityState.getActivity(workspaceId, m.userId);
      if (ts <= 0) continue;
      out.push({
        kind: "dm",
        id: m.userId,
        name: m.name ?? m.email?.split("@")[0] ?? "User",
        image: authState.getMemberImage(m.userId),
        agent: null,
        presence: presenceState.isOnline(m.userId) && !presenceState.isAway(m.userId) ? "online" : "away",
        ts,
      });
    }
    for (const a of agents) {
      const ts = dmActivityState.getActivity(workspaceId, a.agentId);
      if (ts <= 0) continue;
      out.push({ kind: "agent", id: a.agentId, name: agentDisplayName(a), image: null, agent: a, presence: null, ts });
    }
    return out.toSorted((x, y) => y.ts - x.ts).slice(0, 3);
  });

  // Stats strip: the same four numbers as the desktop home, always rendered.
  // "Cost" (not "Session Cost") so four 11px uppercase labels fit one phone row.
  const mobileStats = $derived([
    { label: "Agents", value: String(agents.length), color: "text-content" },
    { label: "Humans", value: String(workspaceState.members.length), color: "text-content" },
    { label: "Running", value: String(runningCount), color: runningCount > 0 ? "text-online" : "text-content" },
    { label: "Cost", value: formatCost(totalCost), color: "text-content" },
  ]);

  // Agent-session status line, mirroring the desktop card's meta row:
  // lifecycle · model · Remote (when the session lives on another daemon).
  function agentStatusLine(agent: (typeof agents)[number]): string {
    return [
      lifecycleLabel(agent.lifecycle),
      agentStreamState.getModel(agent.agentId),
      agent.daemonLocal === false ? "Remote" : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  // Recent Activity (mobile) = the SAME user-scoped feed as the desktop branch
  // (recentActivity above), capped at 5 rows.
  const mobileActivity = $derived(recentActivity.slice(0, 5));

  // Activity rows push into a conversation — record the origin so mobile back
  // (swipe + button) returns to Home. Reuses the shared click handler
  // (mark-read + route resolution) used by the desktop feed.
  function openActivityItem(item: ActivityItem): void {
    setNavOrigin(page.url.pathname);
    handleActivityClick(item);
  }

  // Initial hydration window only (same gate the sidebar skeletons use) — a
  // cached/seeded open never flashes shimmer rows.
  const mobileLoading = $derived(
    workspaceState.membersLoading && workspaceState.members.length === 0 && agents.length === 0,
  );

  // List→conversation entry points record the origin so mobile back (swipe +
  // button) returns to Home, not the static parent list.
  function openMobileItem(kind: "channel" | "dm" | "agent", id: string): void {
    setNavOrigin(page.url.pathname);
    if (kind === "channel") goto(`/workspace/${workspaceId}/channel/${id}`);
    else if (kind === "dm") goto(`/workspace/${workspaceId}/dm/${id}`);
    else goto(`/workspace/${workspaceId}/agent/${id}`);
  }
</script>

<div class="h-full overflow-y-auto bg-surface">
  {#if showWelcome}
    <FirstRunWelcome
      {workspaceId}
      workspaceName={workspaceState.current?.name ?? "your workspace"}
      {userFirstName}
      {hasDaemonOnline}
      {hasAgents}
      {hasTeammates}
      onDismiss={dismissWelcome}
    />
  {:else if viewportState.isMobile}
    <!-- ── Mobile dashboard (S3 Home, v2): greeting → permission banner →
         Jump back in (conditional) → stats strip → Agent sessions → Recent
         Activity. Same content as the desktop home below, iOS-shaped (Slack
         "Catch up" / widget-stack). Desktop renders the untouched branch. ── -->
    <div class="flex flex-col pb-8">
      <header class="px-4 pb-1 pt-5">
        <h1 class="text-[32px] font-bold leading-[1.15] tracking-[-0.015em] text-content">{greeting}, {greetingName}</h1>
        <p class="mt-1 text-[13px] text-content-dim">
          {workspaceState.current?.name ?? "Workspace"} &mdash; {todayLabel()}
        </p>
      </header>

      <!-- Pending permission approvals: too important to trim on mobile. -->
      {#if pendingPermCount > 0}
        <button
          type="button"
          onclick={() => {
            const first = agents.find((a) => agentStreamState.getPendingPermissions(a.agentId).length > 0);
            if (first) {
              setNavOrigin(page.url.pathname);
              goto(`/workspace/${workspaceId}/agent/${first.agentId}`);
            }
          }}
          class="pressable mx-4 mt-3 flex min-h-[48px] items-center justify-between gap-3 rounded-[12px] px-4 py-3 text-left"
          style="background-color: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.25);"
        >
          <div class="flex items-center gap-2.5">
            <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style="background: rgba(245,158,11,0.2);">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
              </svg>
            </span>
            <span class="text-[15px] text-content">
              <span class="font-semibold">{pendingPermCount}</span>
              permission{pendingPermCount > 1 ? "s" : ""} pending approval
            </span>
          </div>
          <span class="shrink-0 text-[13px] font-semibold text-warning">Review</span>
        </button>
      {/if}

      {#if mobileLoading}
        <!-- Initial hydration: shimmer shaped like the dashboard below. -->
        <div aria-hidden="true" class="pt-5">
          <div class="skeleton mx-4 h-[62px] rounded-[14px]"></div>
          <div class="skeleton mx-4 mb-2 mt-6 h-3.5 w-28 rounded"></div>
          {#each Array(4) as _, i (i)}
            <div class="flex min-h-[54px] items-center gap-3 px-4 py-1.5">
              <div class="skeleton h-[42px] w-[42px] shrink-0 rounded-[12px]"></div>
              <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                <div class="skeleton h-3.5 rounded" style="width: {50 + ((i * 17) % 35)}%"></div>
                <div class="skeleton h-3 rounded" style="width: {28 + ((i * 23) % 30)}%"></div>
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <!-- Jump back in: top 3 conversations by existing recency data. -->
        {#if jumpBackIn.length > 0}
          <div class="flex min-h-[36px] items-end px-4 pb-1 pt-4 text-[13px] font-semibold uppercase tracking-[0.06em] text-content-muted">
            Jump back in
          </div>
          {#each jumpBackIn as item (item.id)}
            {@const recentAgent = item.agent}
            {#if recentAgent}
              <ConversationRow
                kind="agent"
                name={item.name}
                time={conversationTime(item.ts)}
                onclick={() => openMobileItem(item.kind, item.id)}
              >
                {#snippet leading()}
                  <div class="relative flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[12px] bg-surface-alt text-content-muted">
                    <CyboSessionAvatar agent={recentAgent} size={28} radius="9px" />
                  </div>
                {/snippet}
              </ConversationRow>
            {:else}
              <ConversationRow
                kind="dm"
                name={item.name}
                image={item.image}
                presence={item.presence}
                time={conversationTime(item.ts)}
                onclick={() => openMobileItem(item.kind, item.id)}
              />
            {/if}
          {/each}
        {/if}

        <!-- Stats strip: one grouped widget card, four cells, hairline-divided.
             Same numbers as the desktop stats strip; always renders. -->
        <div class="mx-4 mt-5 flex rounded-[14px] bg-surface-alt">
          {#each mobileStats as stat, i (stat.label)}
            <div
              class="flex flex-1 flex-col items-center gap-1 py-3"
              style={i > 0 ? "border-left: 1px solid var(--hairline);" : ""}
            >
              <span class={cn("text-[20px] font-bold leading-none tabular-nums", stat.color)}>{stat.value}</span>
              <span class="text-[11px] font-semibold uppercase tracking-[0.06em] text-content-muted">{stat.label}</span>
            </div>
          {/each}
        </div>

        <!-- Agent sessions: the desktop card grid as iOS rows. -->
        <div class="flex items-center justify-between px-4 pb-1 pt-5">
          <h2 class="text-[13px] font-semibold uppercase tracking-[0.06em] text-content-muted">Agent sessions</h2>
          {#if agents.length > 0}
            <button
              type="button"
              onclick={() => goto(`/workspace/${workspaceId}/agents`)}
              class="pressable -my-[14px] -mr-2 flex min-h-[44px] items-center px-2 text-[13px] font-semibold text-accent"
            >
              See all
            </button>
          {/if}
        </div>
        {#if agents.length === 0}
          <!-- Designed empty state: never a blank section. -->
          <div class="mx-4 flex flex-col items-center gap-3 rounded-[14px] bg-surface-alt px-6 py-7 text-center">
            <span class="flex h-[48px] w-[48px] items-center justify-center rounded-[14px] bg-accent/12 text-accent" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" />
              </svg>
            </span>
            <div class="flex flex-col gap-1">
              <span class="text-[16px] font-semibold text-content">Spin up your first agent</span>
              <span class="text-[13px] text-content-muted">Agents work in this workspace and report back here.</span>
            </div>
            <button
              type="button"
              onclick={() => goto(`/workspace/${workspaceId}/agent/new`)}
              class="pressable flex h-[44px] w-full items-center justify-center rounded-[12px] bg-accent text-[15px] font-semibold text-accent-foreground"
            >
              New agent
            </button>
          </div>
        {:else}
          {#each agents as agent (agent.agentId)}
            {@const perms = agentStreamState.getPendingPermissions(agent.agentId).length}
            <ConversationRow
              kind="agent"
              name={agentDisplayName(agent)}
              preview={agentStatusLine(agent)}
              onclick={() => openMobileItem("agent", agent.agentId)}
            >
              {#snippet leading()}
                <div class="relative flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[12px] bg-surface-alt text-content-muted">
                  <CyboSessionAvatar {agent} size={28} radius="9px" />
                  {#if agent.lifecycle === "running"}
                    <span class="absolute animate-ping rounded-full" style="bottom: -2px; right: -2px; width: 10px; height: 10px; background: var(--color-success); opacity: 0.45;"></span>
                  {/if}
                  <span class="absolute rounded-full" style="bottom: -2px; right: -2px; width: 10px; height: 10px; border: 2px solid var(--bg-base); background: {lifecycleColor(agent.lifecycle)};"></span>
                </div>
              {/snippet}
              {#snippet trailing()}
                {#if perms > 0}
                  <span
                    class="flex h-[19px] min-w-[19px] items-center justify-center rounded-full px-[6px] text-[12px] font-bold leading-none"
                    style="background: color-mix(in srgb, var(--warning) 18%, transparent); color: var(--warning);"
                  >{perms}</span>
                {/if}
              {/snippet}
            </ConversationRow>
          {/each}
          <button
            type="button"
            onclick={() => goto(`/workspace/${workspaceId}/agent/new`)}
            class="pressable-row flex w-full min-h-[54px] cursor-pointer items-center gap-3 px-4 text-left"
          >
            <span class="flex h-[42px] w-[42px] shrink-0 items-center justify-center text-content-muted" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </span>
            <span class="flex-1 truncate text-[16px] font-medium text-content-muted">New agent</span>
          </button>
        {/if}

        <!-- Recent Activity: same user-scoped feed as the desktop branch. -->
        <div class="flex items-center justify-between px-4 pb-1 pt-5">
          <h2 class="text-[13px] font-semibold uppercase tracking-[0.06em] text-content-muted">Recent Activity</h2>
          {#if mobileActivity.length > 0}
            <button
              type="button"
              onclick={() => goto(`/workspace/${workspaceId}/activity`)}
              class="pressable -my-[14px] -mr-2 flex min-h-[44px] items-center px-2 text-[13px] font-semibold text-accent"
            >
              See all
            </button>
          {/if}
        </div>
        {#if mobileActivity.length === 0}
          <div class="flex min-h-[44px] items-center px-4 text-[13px] text-content-muted">
            No activity yet &mdash; mentions, replies and DMs to you land here.
          </div>
        {:else}
          {#each mobileActivity as item (item.id)}
            {@const detail = item.preview?.trim() || null}
            <ConversationRow
              kind="dm"
              name={item.actorName}
              preview={[
                activityHeaderLabel(item.eventType) + (item.channelName ? ` in #${item.channelName}` : ""),
                detail,
              ]
                .filter(Boolean)
                .join(" — ")}
              time={relativeTime(item.createdAt)}
              onclick={() => openActivityItem(item)}
            >
              {#snippet leading()}
                <Avatar
                  name={item.actorName}
                  image={item.actorType === "human" && item.actorId ? authState.getMemberImage(item.actorId as string) : null}
                  width={42}
                  fontSize={16}
                />
              {/snippet}
            </ConversationRow>
          {/each}
        {/if}
      {/if}
    </div>
  {:else}
    <!-- DESIGN PREVIEW: new Mission Control home (mock data). The previous
         desktop home is kept inert below in {#if false} so helpers stay used and
         this is trivially reversible. -->
    <HomeMissionControl userName={userName} {workspaceId} />
  {#if false}
  <div class="mx-auto max-w-[var(--content-max)] px-6 py-6 flex flex-col gap-5">

    <!-- Header -->
    <header>
      <h1 class="font-bold text-[22px] text-content leading-tight">
        Welcome back, {userName}
      </h1>
      <p class="text-[13px] text-content-dim mt-0.5">
        {workspaceState.current?.name ?? "Workspace"} &mdash; {todayLabel()}
      </p>
    </header>

    <!-- Stats strip -->
    <div class="grid gap-3 grid-cols-2 md:grid-cols-4">
      {#each [
        { label: "Agents", value: String(agents.length), color: "text-content" },
        { label: "Humans", value: String(workspaceState.members.length), color: "text-content" },
        { label: "Running", value: String(runningCount), color: runningCount > 0 ? "text-online" : "text-content" },
        { label: "Session Cost", value: formatCost(totalCost), color: "text-content" },
      ] as stat (stat.label)}
        <div
          class="rounded-lg p-4 flex flex-col gap-1.5 border border-edge bg-surface-alt"
        >
          <span class="text-[10px] font-bold uppercase tracking-wider text-content-muted">{stat.label}</span>
          <span class={cn("font-bold text-[24px] leading-none", stat.color)}>{stat.value}</span>
        </div>
      {/each}
    </div>

    <!-- Permission banner -->
    {#if pendingPermCount > 0}
      <button
        type="button"
        onclick={() => {
          const first = agents.find((a) => agentStreamState.getPendingPermissions(a.agentId).length > 0);
          if (first) goto(`/workspace/${workspaceId}/agent/${first.agentId}`);
        }}
        class="rounded-lg px-4 py-3 flex items-center justify-between gap-3 transition-opacity hover:opacity-90 cursor-pointer text-left w-full"
        style="background-color: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.25);"
      >
        <div class="flex items-center gap-2.5">
          <span
            class="flex h-6 w-6 items-center justify-center rounded-md"
            style="background: rgba(245,158,11,0.2);"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
            </svg>
          </span>
          <span class="text-[13px] text-content">
            <span class="font-semibold">{pendingPermCount}</span>
            permission{pendingPermCount > 1 ? "s" : ""} pending approval
          </span>
        </div>
        <span class="text-[12px] font-semibold text-warning shrink-0">
          Review
          <svg class="inline ml-0.5 -mt-px" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
        </span>
      </button>
    {/if}

    <!-- Agents section -->
    <section class="flex flex-col gap-3">
      <h2 class="font-bold text-[16px] text-content">Agent sessions</h2>

      {#if agents.length === 0}
        <div
          class="rounded-lg p-8 flex flex-col items-center text-center gap-2 border border-dashed border-edge bg-surface-alt"
        >
          <svg class="text-content-muted mb-1" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
            <line x1="9" y1="9" x2="9.01" y2="9"/>
            <line x1="15" y1="9" x2="15.01" y2="9"/>
          </svg>
          <span class="text-[14px] text-content-dim">No agents yet</span>
          <span class="text-[12px] text-content-muted">Launch an agent from the sidebar to get started.</span>
        </div>
      {:else}
        <div class="grid gap-2 grid-cols-1 sm:grid-cols-2">
          {#each agents as agent (agent.agentId)}
            {@const perms = agentStreamState.getPendingPermissions(agent.agentId).length}
            {@const costLabel = getUsageLabel(agent.agentId)}
            {@const model = agentStreamState.getModel(agent.agentId)}
            <button
              type="button"
              onclick={() => goto(`/workspace/${workspaceId}/agent/${agent.agentId}`)}
              class="text-left rounded-lg p-4 flex flex-col gap-2.5 transition-colors cursor-pointer"
              style="background-color: var(--bg-surface); border: 1px solid var(--border);"
              onmouseenter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "var(--hover-gray)"; }}
              onmouseleave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "var(--bg-surface)"; }}
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2.5">
                  <!-- Provider avatar (brand color) with a live presence dot -->
                  <div class="relative shrink-0">
                    {#if agent.cyboId}
                      <CyboSessionAvatar {agent} size={26} radius="8px" />
                    {:else}
                      <div class="flex items-center justify-center" style="width: 26px; height: 26px; border-radius: 8px; background: color-mix(in srgb, {providerBrandColor(agent.provider) ?? 'var(--border-dim)'} 14%, transparent); color: {providerBrandColor(agent.provider) ?? 'var(--border-dim)'};">
                        <ProviderIcon provider={agent.provider} size={14} />
                      </div>
                    {/if}
                    {#if agent.lifecycle !== "stopped" && agent.lifecycle !== "error"}
                      <span class="absolute rounded-full animate-ping" style="bottom: -2px; right: -2px; width: 9px; height: 9px; background: {lifecycleColor(agent.lifecycle)}; opacity: 0.45;"></span>
                    {/if}
                    <span class="absolute rounded-full" style="bottom: -2px; right: -2px; width: 9px; height: 9px; border: 2px solid var(--bg-surface); background: {lifecycleColor(agent.lifecycle)};"></span>
                  </div>
                  <span class="font-semibold text-[14px] text-content">{agentDisplayName(agent)}</span>
                </div>
                <div class="flex items-center gap-1.5">
                  {#if perms > 0}
                    <Badge variant="permission">
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                      {perms}
                    </Badge>
                  {/if}
                  {#if agent.daemonLocal === false}
                    <span class="rounded px-1.5 py-0.5 text-[10px] font-medium bg-warning/15 text-warning">Remote</span>
                  {/if}
                </div>
              </div>

              <div class="flex items-center gap-2 text-[11px] text-content-muted flex-wrap">
                <span class="capitalize">{lifecycleLabel(agent.lifecycle)}</span>
                {#if model}
                  <span class="text-content-muted">·</span>
                  <span class="truncate max-w-[140px]">{model}</span>
                {/if}
                {#if costLabel}
                  <span class="text-content-muted">·</span>
                  <span>{costLabel}</span>
                {/if}
              </div>

              {#if agent.cwd}
                <span class="text-[11px] text-content-muted font-mono truncate">{agent.cwd}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Recent Activity -->
    <section class="flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <h2 class="font-bold text-[16px] text-content">Recent Activity</h2>
        {#if recentActivity.length > 0}
          <button
            type="button"
            onclick={() => goto(`/workspace/${workspaceId}/activity`)}
            class="text-[12px] font-semibold text-content-dim hover:text-content cursor-pointer transition-colors"
          >
            View all
            <svg class="inline ml-0.5 -mt-px" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
          </button>
        {/if}
      </div>

      {#if recentActivity.length === 0}
        <div
          class="rounded-lg p-6 flex flex-col items-center text-center gap-1 border border-dashed border-edge bg-surface-alt"
        >
          <span class="text-[13px] text-content-dim">No activity yet</span>
          <span class="text-[12px] text-content-muted">Mentions, replies and DMs to you show up here.</span>
        </div>
      {:else}
        <div
          class="rounded-lg divide-y divide-edge overflow-hidden border border-edge bg-surface-alt"
        >
          {#each recentActivity as item (item.id)}
            <button
              type="button"
              onclick={() => handleActivityClick(item)}
              class="flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-hover-gray cursor-pointer"
            >
              <span
                class="shrink-0 mt-1.5 h-1.5 w-1.5 rounded-full"
                style="background-color: {activityAccent(item.eventType)};"
              ></span>
              <div class="mt-0.5 shrink-0">
                <!-- Show the actor's real photo when it's a human with one;
                     otherwise the Avatar falls back to its name-hashed color
                     (never a flat grey). Mirrors ActivityPane's actor avatar. -->
                <Avatar
                  name={item.actorName}
                  image={item.actorType === "human" && item.actorId ? authState.getMemberImage(item.actorId as string) : null}
                  width={28}
                  fontSize={11}
                  borderRadius={6}
                />
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 text-[12px]">
                  <span class="font-semibold text-content truncate">{item.actorName}</span>
                  <span class="text-content-muted truncate">{activityHeaderLabel(item.eventType)}</span>
                  {#if item.channelName}
                    <span class="text-content-dim truncate">#{item.channelName}</span>
                  {/if}
                  <span class="ml-auto shrink-0 text-[11px] text-content-muted">{relativeTime(item.createdAt)}</span>
                </div>
                {#if item.preview?.trim()}
                  <p class="text-[13px] text-content-dim truncate mt-0.5">{item.preview}</p>
                {/if}
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Workspace info -->
    <div class="flex items-center gap-4 text-[12px] text-content-muted pb-4">
      <span class="flex items-center gap-1.5">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9h16M4 15h16M10 3l-2 18M16 3l-2 18"/></svg>
        {visibleChannels(workspaceState.channels).length} channels
      </span>
      <span class="flex items-center gap-1.5">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        {workspaceState.members.length} members
      </span>
      <span class="flex items-center gap-1.5">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        {workspaceState.tasks.length} tasks
      </span>
    </div>
  </div>
  {/if}
  {/if}
</div>
