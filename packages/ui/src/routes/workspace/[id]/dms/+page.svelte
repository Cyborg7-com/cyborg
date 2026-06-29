<script lang="ts">
  // DMs tab (mobile): segmented Humans · Agents · Sessions (mirrors the Agents
  // tab's tab control).
  //   Humans   = all teammates, recency-sorted (prod behavior, until a server
  //              "my conversations" list lands). ✎ opens a picker to jump to anyone.
  //   Agents   = your cybo ROSTER — tap to open its session (or start one).
  //   Sessions = your LIVE agent conversations (the running ones).
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { workspaceState, authState, notificationState, presenceState, sortMembersByDmRecency, dmActivityState, dmTypingState, spawnCybo, daemonState, agentStreamState, daemonStatusState, archiveAgent, deleteCybo, sessionState, restoreSession, fetchSessions, loadMoreSessions, client } from "$lib/state/app.svelte.js";
  import { sessionAlias } from "$lib/state/session-alias.svelte.js";
  import { terminalSessionsState } from "$lib/state/terminal-sessions.svelte.js";
  import { terminalAlias } from "$lib/state/terminal-alias.svelte.js";
  import { cyboState } from "$lib/plugins/agents/state.svelte.js";
  import { agentDisplayName as sharedAgentDisplayName } from "$lib/agent-display.js";
  import ConversationRow, { conversationTime } from "$lib/components/channel/ConversationRow.svelte";
  import MobileSheet from "$lib/components/MobileSheet.svelte";
  import Avatar from "$lib/components/Avatar.svelte";
  import CyboSessionAvatar from "$lib/components/CyboSessionAvatar.svelte";
  import CreateAgentDialog from "$lib/components/agent/CreateAgentDialog.svelte";
  import InviteMembersModal from "$lib/components/settings/InviteMembersModal.svelte";
  import { setNavOrigin } from "$lib/mobile/navOrigin";
  import { toast } from "svelte-sonner";

  const wsId = $derived(page.params.id);

  type DmTab = "humans" | "agents" | "sessions";
  const DM_TAB_KEY = "cyborg7-dm-tab";
  function isDmTab(v: string | null): v is DmTab {
    return v === "humans" || v === "agents" || v === "sessions";
  }
  // Open on the segment named by ?seg= when present (e.g. the cybo editor returns
  // here with ?seg=agents). Otherwise restore the LAST sub-tab the user was on
  // (persisted) so navigating away to Projects and back doesn't reset to Humans.
  // Falls back to Humans on first ever visit.
  function initialDmTab(): DmTab {
    const seg = page.url.searchParams.get("seg");
    if (isDmTab(seg)) return seg;
    if (typeof localStorage !== "undefined") {
      const stored = localStorage.getItem(DM_TAB_KEY);
      if (isDmTab(stored)) return stored;
    }
    return "humans";
  }
  let dmTab = $state<DmTab>(initialDmTab());
  // Persist the active sub-tab so it survives navigation/remounts.
  $effect(() => {
    try {
      localStorage.setItem(DM_TAB_KEY, dmTab);
    } catch {
      // intentional: best-effort persistence of the last sub-tab.
    }
  });

  // "New session" launcher (provider/cybo session) — same dialog the old Agents
  // tab used. Creating a persistent cybo is the separate /agent/new flow.
  let newSessionOpen = $state(false);

  // Invite human (moved here from the profile menu) — owners/admins only; the
  // relay enforces it, gate the affordance too.
  let inviteHumansOpen = $state(false);
  const canInvite = $derived(
    workspaceState.current?.role === "owner" || workspaceState.current?.role === "admin",
  );

  const allMembers = $derived(
    sortMembersByDmRecency(
      workspaceState.members
        .filter((m) => m.userId !== authState.user?.id)
        .sort((a, b) => (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? "")),
      wsId,
    ),
  );
  const cybos = $derived(cyboState.list);
  // Split agents by liveness so the Agents tab leads with the ones you can use
  // and tucks the (often many) offline ones behind a collapsible row — same idea
  // as Archived sessions. Online-ish = anything not "offline" (idle/busy/etc.).
  const onlineCybos = $derived(cybos.filter((c) => cyboStatusKey(c.id) !== "offline"));
  const offlineCybos = $derived(cybos.filter((c) => cyboStatusKey(c.id) === "offline"));
  let offlineAgentsOpen = $state(false);
  // Sessions = RAW provider sessions only (Claude/Codex/Terminal). Cybo-backed
  // sessions belong to their cybo, which already shows "Active session" in the
  // Agents segment — listing them here too double-counted them (Rick/Sprite).
  const sessions = $derived(workspaceState.agents.filter((a) => !a.cyboId));
  // Terminals (daemon PTY sessions) — daemon sessions too, so they belong here
  // next to agent sessions, not in the channels (Projects) tab. Sourced from the
  // shared terminal-directory store; the effect below pulls + subscribes so they
  // load even when the desktop sidebar (which usually fetches them) isn't mounted.
  const terminals = $derived(wsId ? terminalSessionsState.forWorkspace(wsId) : []);
  $effect(() => {
    const id = wsId;
    if (!id) return;
    let active = true;
    void client
      .listTerminals(id)
      .then((entries) => {
        if (active) terminalSessionsState.ingestDirectory(id, entries);
        return;
      })
      .catch((err) => {
        // intentional: older/offline daemons lack the directory RPC — just means
        // no out-of-band rows. Logged (not silenced) so a routing regression shows.
        console.debug("[dms] listTerminals directory pull failed", err);
      });
    const off = client.onTerminalsChanged((payload) => {
      if (active && payload.workspaceId === id) {
        terminalSessionsState.ingestDirectory(id, payload.terminals);
      }
    });
    return () => {
      active = false;
      off();
    };
  });
  function openTerminal(terminalId: string, daemonId: string): void {
    if (!wsId) return;
    setNavOrigin(page.url.pathname);
    goto(`/workspace/${wsId}/terminal/${terminalId}?daemon=${encodeURIComponent(daemonId)}`);
  }
  function terminalName(t: { terminalId: string; title: string }): string {
    return terminalAlias.get(t.terminalId) ?? t.title;
  }
  // Terminal kebab menu — rename (local alias, like sessions) + close (kill pty).
  let menuTerminal = $state<{ terminalId: string; daemonId: string; title: string } | null>(null);
  let terminalAliasDraft = $state("");
  function openTerminalMenu(t: { terminalId: string; daemonId: string; title: string }) {
    menuTerminal = t;
    terminalAliasDraft = terminalAlias.get(t.terminalId) ?? "";
  }
  function saveTerminalAlias() {
    if (!menuTerminal) return;
    terminalAlias.set(menuTerminal.terminalId, terminalAliasDraft, wsId);
    menuTerminal = null;
  }
  function clearTerminalAlias() {
    if (!menuTerminal) return;
    terminalAlias.clear(menuTerminal.terminalId, wsId);
    menuTerminal = null;
  }
  function closeTerminalRow() {
    if (!menuTerminal) return;
    const { terminalId, daemonId } = menuTerminal;
    menuTerminal = null;
    // Best-effort pty kill on the daemon, then stop tracking locally (dismiss
    // suppresses re-add). Mirrors the desktop sidebar's closeTerminal.
    if (wsId) {
      try {
        client.terminalSocket().send({
          type: "cyborg:kill_terminal",
          workspaceId: wsId,
          daemonId,
          terminalId,
        });
      } catch {
        // intentional: the row is dismissed regardless of the kill landing.
      }
    }
    terminalSessionsState.dismiss(terminalId);
  }
  // Archived sessions (ended sessions you can restore) — the home that got
  // dropped when the old sidebar merged into the Team tab.
  const archivedSessions = $derived(sessionState.list);

  // Per-segment unread totals → a red dot on the segment tab so you know WHERE
  // the unread is (Humans/Agents/Sessions) without scanning each.
  const humansUnread = $derived(
    wsId ? allMembers.reduce((n, m) => n + notificationState.getCount(wsId, m.userId), 0) : 0,
  );
  const sessionsUnread = $derived(
    wsId ? sessions.reduce((n, a) => n + notificationState.getCount(wsId, a.agentId), 0) : 0,
  );
  const agentsUnread = $derived(
    wsId
      ? cybos.reduce((n, c) => {
          const la = workspaceState.agents.find((a) => a.cyboId === c.id);
          return n + (la ? notificationState.getCount(wsId, la.agentId) : 0);
        }, 0)
      : 0,
  );
  let archivedOpen = $state(false);
  let restoringId = $state<string | null>(null);
  // Track the LAST fetched workspace so switching workspaces refetches archived
  // sessions (a plain `fetched` boolean would stick true and show stale data
  // from the previous workspace — Gemini).
  let lastFetchedWsId = $state<string | null>(null);
  $effect(() => {
    if (wsId && lastFetchedWsId !== wsId) {
      lastFetchedWsId = wsId;
      void fetchSessions();
    }
  });
  function archivedName(s: (typeof archivedSessions)[number]): string {
    return s.title || sharedAgentDisplayName(s, cyboState.list);
  }
  function timeAgo(ms: number): string {
    const m = Math.floor((Date.now() - ms) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }
  async function restoreArchived(s: (typeof archivedSessions)[number]) {
    if (restoringId) return;
    restoringId = s.id;
    try {
      const agentId = await restoreSession(s.id);
      archivedOpen = false;
      openAgent(agentId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't restore the session");
    } finally {
      restoringId = null;
    }
  }

  const loading = $derived(workspaceState.membersLoading && allMembers.length === 0);

  // New-message picker (start a human DM with anyone).
  let pickerOpen = $state(false);
  let pickerQuery = $state("");
  const pickerResults = $derived(
    allMembers.filter((m) => {
      const q = pickerQuery.trim().toLowerCase();
      if (!q) return true;
      return (m.name ?? "").toLowerCase().includes(q) || (m.email ?? "").toLowerCase().includes(q);
    }),
  );

  function openDm(userId: string) {
    setNavOrigin(page.url.pathname);
    goto(`/workspace/${wsId}/dm/${userId}`);
  }
  function openAgent(agentId: string) {
    setNavOrigin(page.url.pathname);
    goto(`/workspace/${wsId}/agent/${agentId}`);
  }
  // Create / manage agents — folded in from the old standalone Agents tab. Both
  // are existing routes (the cybo editor): /agent/new and /agent/new?edit=<id>.
  function newAgent() {
    setNavOrigin(page.url.pathname);
    goto(`/workspace/${wsId}/agent/new`);
  }
  function manageCybo(cyboId: string) {
    setNavOrigin(page.url.pathname);
    goto(`/workspace/${wsId}/agent/new?edit=${cyboId}`);
  }

  // Agent (cybo) kebab menu — Edit / Archive session / Delete (parity with the
  // Sessions row menu).
  let menuCybo = $state<(typeof cybos)[number] | null>(null);
  function openCyboMenu(c: (typeof cybos)[number]) {
    menuCybo = c;
  }
  function cyboLiveAgentId(cyboId: string): string | null {
    return workspaceState.agents.find((a) => a.cyboId === cyboId)?.agentId ?? null;
  }
  async function archiveCyboSession() {
    const id = menuCybo ? cyboLiveAgentId(menuCybo.id) : null;
    menuCybo = null;
    if (!id) return;
    try {
      await archiveAgent(id);
      toast.success("Session archived");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't archive the session");
    }
  }
  async function deleteCyboAction() {
    if (!menuCybo) return;
    const c = menuCybo;
    menuCybo = null;
    if (!confirm(`Delete "${c.name}"? This removes it for the whole workspace and can't be undone.`)) return;
    try {
      await deleteCybo(c.id);
      toast.success(`Deleted ${c.name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't delete the agent");
    }
  }
  function startDm(userId: string) {
    pickerOpen = false;
    pickerQuery = "";
    openDm(userId);
  }

  // Tap a cybo: open its live session if one exists, else start one.
  let startingCyboId = $state<string | null>(null);
  async function openOrStartCybo(cybo: { id: string; slug?: string; name: string }) {
    if (startingCyboId) return;
    const existing = workspaceState.agents.find((a) => a.cyboId === cybo.id);
    if (existing) {
      openAgent(existing.agentId);
      return;
    }
    startingCyboId = cybo.id;
    try {
      const daemonId = daemonState.selectedId ?? daemonState.effectiveId(authState.user?.id) ?? undefined;
      const agentId = await spawnCybo(cybo.slug || cybo.id, undefined, { daemonId });
      openAgent(agentId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Couldn't start a chat with ${cybo.name}`);
    } finally {
      startingCyboId = null;
    }
  }

  // ── Live status (mirrors the Agents pane taxonomy + palette) ──────────
  //   waiting  — paused for your approval        working — in a turn
  //   idle     — up & online, no active turn      offline — process/daemon down
  type AgentStatus = "waiting" | "working" | "idle" | "offline";
  const STATUS_META: Record<AgentStatus, { label: string; color: string }> = {
    waiting: { label: "Waiting", color: "var(--health-watching-text, #e8ab5a)" },
    working: { label: "Working", color: "var(--agent-accent, #7c3aed)" },
    idle: { label: "Idle", color: "var(--health-ok-text, #16a34a)" },
    offline: { label: "Offline", color: "var(--text-muted)" },
  };
  function agentStatusKey(a: (typeof sessions)[number]): AgentStatus {
    const daemonOnline = a.daemonId ? daemonStatusState.get(a.daemonId) === "online" : true;
    if (!daemonOnline || a.lifecycle === "closed" || a.lifecycle === "error") return "offline";
    if (agentStreamState.getPendingPermissions(a.agentId).length > 0) return "waiting";
    if (agentStreamState.getTurnStatus(a.agentId) === "running" || a.lifecycle === "running") return "working";
    return "idle";
  }
  // A cybo's status = its live session's status, or offline when it has none.
  function cyboStatusKey(cyboId: string): AgentStatus {
    const live = workspaceState.agents.find((a) => a.cyboId === cyboId);
    return live ? agentStatusKey(live) : "offline";
  }
  function agentModel(a: (typeof sessions)[number]): string | null {
    const m = agentStreamState.getModel(a.agentId) ?? a.model;
    return m ? (m.split("/").pop() ?? m) : null;
  }
  // Subtitle no longer leads with the status word — the status pill carries it.
  function sessionSubtitle(a: (typeof sessions)[number]): string | null {
    const s = [agentModel(a), a.daemonLocal === false ? "Remote" : null].filter(Boolean).join(" · ");
    return s || null;
  }
  function sessionName(a: (typeof sessions)[number]): string {
    return sessionAlias.get(a.agentId) ?? sharedAgentDisplayName(a, cyboState.list);
  }

  // Session kebab menu — same actions as the desktop session row.
  let menuSession = $state<(typeof sessions)[number] | null>(null);
  let aliasDraft = $state("");
  function openSessionMenu(a: (typeof sessions)[number]) {
    menuSession = a;
    aliasDraft = sessionAlias.get(a.agentId) ?? "";
  }
  function saveAlias() {
    if (!menuSession) return;
    sessionAlias.set(menuSession.agentId, aliasDraft);
    menuSession = null;
  }
  function clearAlias() {
    if (!menuSession) return;
    sessionAlias.clear(menuSession.agentId);
    menuSession = null;
  }
  async function archiveSession() {
    if (!menuSession) return;
    const id = menuSession.agentId;
    menuSession = null;
    try {
      await archiveAgent(id);
      toast.success("Session archived");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't archive the session");
    }
  }
</script>

<!-- Live-status presence dot overlaid on an avatar (soft ping while online). -->
{#snippet statusDot(st: AgentStatus)}
  {#if st !== "offline"}
    <span class="absolute rounded-full animate-ping" style="bottom:-1px;right:-1px;width:11px;height:11px;background:{STATUS_META[st].color};opacity:0.45;"></span>
  {/if}
  <span class="absolute rounded-full" style="bottom:-1px;right:-1px;width:11px;height:11px;border:2px solid var(--bg-base);background:{STATUS_META[st].color};"></span>
{/snippet}

<!-- Premium status tag — tinted pill beside the name (Working / Waiting / …). -->
{#snippet statusPill(st: AgentStatus)}
  <span
    class="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-[1px] text-[10.5px] font-semibold leading-none"
    style="color:{STATUS_META[st].color}; background:color-mix(in srgb, {STATUS_META[st].color} 14%, transparent);"
  >
    <span class="rounded-full" style="width:5px;height:5px;background:{STATUS_META[st].color};"></span>
    {STATUS_META[st].label}
  </span>
{/snippet}

<!-- Shared "add" row (New agent / New session / Invite human). Accent tile +
     accent label so the + is clearly visible in BOTH light and dark (the old
     accent-tint-on-dark tile washed the + out). -->
{#snippet addRow(label: string, onClick: () => void)}
  <button
    type="button"
    onclick={onClick}
    class="flex min-h-[54px] w-full items-center gap-3 px-4 text-left active:bg-raised"
  >
    <span class="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[12px] bg-raised text-accent">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </span>
    <span class="flex-1 truncate text-[16px] font-medium text-accent">{label}</span>
  </button>
{/snippet}

<!-- Archived sessions entry (opens the archived list). Muted, not an accent
     "add" action — it's a destination, not a create. -->
{#snippet cyboRow(c: (typeof cybos)[number])}
  {@const liveAgent = workspaceState.agents.find((a) => a.cyboId === c.id)}
  {@const live = !!liveAgent}
  {@const st = cyboStatusKey(c.id)}
  {@const unread = wsId && liveAgent ? notificationState.getCount(wsId, liveAgent.agentId) : 0}
  <ConversationRow
    kind="agent"
    name={c.name}
    preview={startingCyboId === c.id ? "starting…" : live ? "Active session" : "Tap to start a chat"}
    unread={unread > 0}
    unreadCount={unread}
    ariaLabel={`Chat with ${c.name}`}
    onclick={() => openOrStartCybo(c)}
  >
    {#snippet leading()}
      <span class="relative inline-flex shrink-0">
        <Avatar name={c.name} image={c.avatar} width={42} fontSize={16} borderRadius={12} />
        {@render statusDot(st)}
      </span>
    {/snippet}
    {#snippet nameAccessory()}
      {@render statusPill(st)}
    {/snippet}
    {#snippet trailing()}
      <!-- Kebab → agent actions (Edit / Archive session / Delete). -->
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-full text-content-muted active:bg-raised"
        aria-label={`Options for ${c.name}`}
        onclick={(e) => { e.stopPropagation(); openCyboMenu(c); }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" />
        </svg>
      </button>
    {/snippet}
  </ConversationRow>
{/snippet}

{#snippet archivedRow()}
  <button
    type="button"
    onclick={() => (archivedOpen = true)}
    class="flex min-h-[54px] w-full items-center gap-3 px-4 text-left active:bg-raised"
  >
    <span class="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[12px] bg-raised text-content-muted">
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
    </span>
    <span class="flex-1 truncate text-[16px] font-medium text-content-muted">Archived</span>
    <span class="text-[13px] text-content-muted tabular-nums">{archivedSessions.length}</span>
  </button>
{/snippet}

<div class="flex h-full flex-col overflow-hidden bg-surface">
  <!-- Header. Trailing action depends on the segment: Humans → new message,
       Agents → new agent (folded in from the old Agents tab). -->
  <div class="flex items-center justify-between px-4 pt-4 pb-2">
    <h1 class="text-[20px] font-bold text-content">Team</h1>
    {#if dmTab === "humans"}
      <button
        type="button"
        onclick={() => { pickerOpen = true; }}
        class="flex h-9 w-9 items-center justify-center rounded-full text-accent active:bg-raised"
        aria-label="New message"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </button>
    {:else if dmTab === "agents"}
      <button
        type="button"
        onclick={newAgent}
        class="flex h-9 w-9 items-center justify-center rounded-full text-accent active:bg-raised"
        aria-label="New agent"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    {:else if dmTab === "sessions"}
      <button
        type="button"
        onclick={() => (newSessionOpen = true)}
        class="flex h-9 w-9 items-center justify-center rounded-full text-accent active:bg-raised"
        aria-label="New session"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    {/if}
  </div>

  <!-- Segmented tabs — mirrors the Agents tab control. -->
  <div class="mx-4 mb-2 flex gap-1 rounded-[12px] bg-surface-alt p-1">
    {#each [{ key: "humans", label: "Humans", n: allMembers.length, unread: humansUnread }, { key: "agents", label: "Agents", n: cybos.length, unread: agentsUnread }, { key: "sessions", label: "Sessions", n: sessions.length, unread: sessionsUnread }] as t (t.key)}
      <button
        type="button"
        onclick={() => (dmTab = t.key as DmTab)}
        class="flex-1 rounded-[9px] py-1.5 text-[13.5px] font-semibold transition-colors {dmTab === t.key ? 'bg-raised text-content shadow-sm' : 'text-content-muted'}"
        aria-pressed={dmTab === t.key}
      >
        <span class="relative inline-flex items-center justify-center">
          {t.label} · {t.n}
          {#if t.unread > 0}
            <span class="ml-1.5 h-[7px] w-[7px] shrink-0 rounded-full bg-red-500" aria-hidden="true"></span>
          {/if}
        </span>
      </button>
    {/each}
  </div>

  <div class="flex-1 overflow-y-auto">
    {#if loading && dmTab === "humans"}
      <div aria-hidden="true" class="pt-2">
        {#each Array(6) as _, i (i)}
          <div class="flex min-h-[54px] items-center gap-3 px-4 py-1.5">
            <div class="skeleton h-[42px] w-[42px] shrink-0 rounded-full"></div>
            <div class="flex min-w-0 flex-1 flex-col gap-1.5">
              <div class="skeleton h-3.5 rounded" style="width: {50 + ((i * 17) % 35)}%"></div>
              <div class="skeleton h-3 rounded" style="width: {28 + ((i * 23) % 30)}%"></div>
            </div>
          </div>
        {/each}
      </div>

    {:else if dmTab === "humans"}
      {#if allMembers.length === 0}
        <div class="flex flex-col items-center justify-center gap-1.5 px-8 pt-20 text-center">
          <p class="text-[15px] font-semibold text-content">No conversations yet</p>
          <p class="text-[13px] leading-relaxed text-content-muted">Tap ✎ to message a teammate.</p>
        </div>
      {:else}
        {#each allMembers as m (m.userId)}
          {@const label = m.name ?? m.email?.split("@")[0] ?? "User"}
          {@const unread = wsId ? notificationState.getCount(wsId, m.userId) : 0}
          {@const active = presenceState.isOnline(m.userId) && !presenceState.isAway(m.userId)}
          <ConversationRow
            kind="dm"
            name={label}
            image={authState.getMemberImage(m.userId)}
            presence={active ? "online" : "away"}
            preview={dmTypingState.isTyping(m.userId) ? "typing…" : active ? "Active" : "Away"}
            time={conversationTime(wsId ? dmActivityState.getActivity(wsId, m.userId) : 0)}
            unread={unread > 0}
            unreadCount={unread}
            ariaLabel={`Message ${label}`}
            onclick={() => openDm(m.userId)}
          />
        {/each}
      {/if}
      <!-- Invite human row (moved from the profile menu) — owners/admins only,
           mirrors the New agent / New session affordance. -->
      {#if canInvite}
        {@render addRow("Invite human", () => (inviteHumansOpen = true))}
      {/if}

    {:else if dmTab === "agents"}
      {#if cybos.length === 0}
        <div class="flex flex-col items-center justify-center gap-1.5 px-8 pt-20 text-center">
          <p class="text-[15px] font-semibold text-content">No agents yet</p>
          <p class="text-[13px] leading-relaxed text-content-muted">Tap + to create your first agent.</p>
          <button
            type="button"
            onclick={newAgent}
            class="mt-3 rounded-full bg-accent px-4 py-2 text-[14px] font-semibold text-accent-foreground active:opacity-80"
          >
            New agent
          </button>
        </div>
      {:else}
        {#each onlineCybos as c (c.id)}
          {@render cyboRow(c)}
        {/each}
        <!-- Offline agents are collapsed behind a toggle (like Archived) so the
             list leads with the ones you can actually use right now. -->
        {#if offlineCybos.length > 0}
          <button
            type="button"
            onclick={() => (offlineAgentsOpen = !offlineAgentsOpen)}
            aria-expanded={offlineAgentsOpen}
            class="flex min-h-[48px] w-full items-center gap-2 px-4 text-left text-[13px] font-semibold uppercase tracking-[0.06em] text-content-muted active:bg-raised"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="transform: rotate({offlineAgentsOpen ? 90 : 0}deg); transition: transform 0.15s;"><polyline points="9 18 15 12 9 6"/></svg>
            <span>Offline</span>
            <span class="tabular-nums">{offlineCybos.length}</span>
          </button>
          {#if offlineAgentsOpen}
            {#each offlineCybos as c (c.id)}
              {@render cyboRow(c)}
            {/each}
          {/if}
        {/if}
        <!-- New agent row (mirrors the AgentsPane "New cybo" affordance). -->
        {@render addRow("New agent", newAgent)}
      {/if}

    {:else if sessions.length === 0 && terminals.length === 0}
      <div class="flex flex-col items-center justify-center gap-1.5 px-8 pt-20 text-center">
        <p class="text-[15px] font-semibold text-content">No active sessions</p>
        <p class="text-[13px] leading-relaxed text-content-muted">Start a session with a provider or one of your agents.</p>
        <button
          type="button"
          onclick={() => (newSessionOpen = true)}
          class="mt-3 rounded-full bg-accent px-4 py-2 text-[14px] font-semibold text-accent-foreground active:opacity-80"
        >
          New session
        </button>
      </div>
      {#if archivedSessions.length > 0}{@render archivedRow()}{/if}
    {:else}
      <div class="pb-6">
        {#each sessions as a (a.agentId)}
          {@const label = sessionName(a)}
          {@const unread = wsId ? notificationState.getCount(wsId, a.agentId) : 0}
          {@const st = agentStatusKey(a)}
          <ConversationRow
            kind="agent"
            name={label}
            preview={sessionSubtitle(a)}
            time={conversationTime(wsId ? dmActivityState.getActivity(wsId, a.agentId) : 0)}
            unread={unread > 0}
            unreadCount={unread}
            ariaLabel={`Session ${label}`}
            onclick={() => openAgent(a.agentId)}
          >
            {#snippet leading()}
              <!-- Provider icon for raw sessions (Claude/Codex…). Status reads
                   from the pill beside the name — no avatar dot (it cluttered). -->
              <CyboSessionAvatar agent={a} size={42} radius="12px" />
            {/snippet}
            {#snippet nameAccessory()}
              {@render statusPill(st)}
            {/snippet}
            {#snippet trailing()}
              <!-- Kebab → session actions (rename alias / archive). ConversationRow
                   is a <div role=button>, so this nested <button> is valid; stop
                   propagation so tapping it doesn't open the session. -->
              <button
                type="button"
                class="flex h-8 w-8 items-center justify-center rounded-full text-content-muted active:bg-raised"
                aria-label={`Options for ${label}`}
                onclick={(e) => { e.stopPropagation(); openSessionMenu(a); }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" />
                </svg>
              </button>
            {/snippet}
          </ConversationRow>
        {/each}
        <!-- New session row (mirrors the AgentsPane "New session" affordance). -->
        {@render addRow("New session", () => (newSessionOpen = true))}

        <!-- Terminals: daemon PTY sessions, grouped under the Sessions tab. -->
        {#if terminals.length > 0}
          <div class="mt-4 px-4 pb-1 text-[13px] font-semibold uppercase tracking-[0.06em] text-content-muted">
            Terminals
          </div>
          {#each terminals as t (t.terminalId)}
            <ConversationRow
              kind="agent"
              name={terminalName(t)}
              ariaLabel={`Terminal ${terminalName(t)}`}
              onclick={() => openTerminal(t.terminalId, t.daemonId)}
            >
              {#snippet leading()}
                <span class="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[12px] bg-surface-alt text-content-muted">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
                </span>
              {/snippet}
              {#snippet trailing()}
                <!-- Kebab → terminal actions (rename / close). -->
                <button
                  type="button"
                  class="flex h-8 w-8 items-center justify-center rounded-full text-content-muted active:bg-raised"
                  aria-label={`Options for terminal ${terminalName(t)}`}
                  onclick={(e) => { e.stopPropagation(); openTerminalMenu(t); }}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" />
                  </svg>
                </button>
              {/snippet}
            </ConversationRow>
          {/each}
        {/if}

        {#if archivedSessions.length > 0}{@render archivedRow()}{/if}
      </div>
    {/if}
  </div>
</div>

<!-- Agent (cybo) options: Edit / Archive session / Delete. -->
{#if menuCybo}
  {@const c = menuCybo}
  {@const liveId = cyboLiveAgentId(c.id)}
  <MobileSheet open={!!menuCybo} ariaLabel="Agent options" onclose={() => (menuCybo = null)}>
    <div class="mb-3 flex items-center gap-3 px-1">
      <span class="relative inline-flex shrink-0">
        <Avatar name={c.name} image={c.avatar} width={40} fontSize={16} borderRadius={12} />
        {@render statusDot(cyboStatusKey(c.id))}
      </span>
      <div class="min-w-0 flex-1">
        <div class="truncate text-[16px] font-bold text-content">{c.name}</div>
        <div class="truncate text-[13px] text-content-muted">{STATUS_META[cyboStatusKey(c.id)].label}</div>
      </div>
    </div>

    <div class="mb-3 overflow-hidden rounded-[12px] bg-surface-alt">
      <button
        type="button"
        onclick={() => { const id = c.id; menuCybo = null; manageCybo(id); }}
        class="flex min-h-[48px] w-full items-center px-4 text-left text-[16px] text-content active:bg-raised"
      >
        Edit agent
      </button>
      {#if liveId}
        <div class="mx-4 h-px" style="background-color: var(--hairline);"></div>
        <button
          type="button"
          onclick={archiveCyboSession}
          class="flex min-h-[48px] w-full items-center px-4 text-left text-[16px] text-content active:bg-raised"
        >
          Archive session
        </button>
      {/if}
    </div>

    <div class="overflow-hidden rounded-[12px] bg-surface-alt">
      <button
        type="button"
        onclick={deleteCyboAction}
        class="flex min-h-[48px] w-full items-center justify-center px-4 text-[16px] font-semibold text-red-500 active:bg-raised"
      >
        Delete agent
      </button>
    </div>
  </MobileSheet>
{/if}

<!-- Archived sessions: restore an ended session. -->
{#if archivedOpen}
  <MobileSheet open={archivedOpen} ariaLabel="Archived sessions" onclose={() => (archivedOpen = false)}>
    <h2 class="mb-3 px-1 text-[18px] font-bold text-content">Archived sessions</h2>
    <div class="max-h-[60vh] overflow-y-auto">
      {#if archivedSessions.length === 0}
        <p class="px-2 py-6 text-center text-[14px] text-content-muted">No archived sessions.</p>
      {:else}
        {#each archivedSessions as s (s.id)}
          <div class="flex min-h-[56px] items-center gap-3 px-2">
            <CyboSessionAvatar agent={s} size={40} radius="12px" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-[16px] text-content">{archivedName(s)}</div>
              <div class="truncate text-[13px] text-content-muted">Archived {timeAgo(s.archivedAt)}</div>
            </div>
            <button
              type="button"
              onclick={() => restoreArchived(s)}
              disabled={restoringId === s.id}
              class="shrink-0 rounded-full bg-surface-alt px-3.5 py-1.5 text-[13px] font-semibold text-accent active:opacity-70 disabled:opacity-50"
            >
              {restoringId === s.id ? "Restoring…" : "Restore"}
            </button>
          </div>
        {/each}
        {#if sessionState.nextCursor}
          <button
            type="button"
            onclick={() => void loadMoreSessions()}
            disabled={sessionState.loadingMore}
            class="mt-1 w-full rounded-lg py-2 text-[14px] text-content-muted active:opacity-70 disabled:opacity-50"
          >
            {sessionState.loadingMore ? "Loading…" : "Show more"}
          </button>
        {/if}
      {/if}
    </div>
  </MobileSheet>
{/if}

<!-- Launch a new provider/cybo session (folded in from the old Agents tab). -->
<CreateAgentDialog bind:open={newSessionOpen} />

<!-- Invite a teammate by email (moved from the profile menu). -->
<InviteMembersModal open={inviteHumansOpen} onClose={() => (inviteHumansOpen = false)} />

<!-- New-message picker: any teammate, searchable. -->
{#if pickerOpen}
  <MobileSheet open={pickerOpen} ariaLabel="New message" onclose={() => { pickerOpen = false; pickerQuery = ""; }}>
    <div class="mb-3">
      <input
        type="text"
        bind:value={pickerQuery}
        placeholder="Search teammates"
        class="h-10 w-full rounded-[12px] bg-surface-alt px-4 text-[16px] text-content outline-none placeholder:text-content-muted"
      />
    </div>
    <div class="max-h-[55vh] overflow-y-auto">
      {#if pickerResults.length === 0}
        <p class="px-2 py-6 text-center text-[14px] text-content-muted">No teammates found.</p>
      {:else}
        {#each pickerResults as m (m.userId)}
          {@const label = m.name ?? m.email?.split("@")[0] ?? "User"}
          <button
            type="button"
            onclick={() => startDm(m.userId)}
            class="flex min-h-[52px] w-full items-center gap-3 rounded-[10px] px-2 text-left active:bg-raised"
          >
            <Avatar name={label} width={36} borderRadius={18} fontSize={15} fontWeight={700} image={authState.getMemberImage(m.userId)} />
            <div class="min-w-0 flex-1">
              <div class="truncate text-[16px] text-content">{label}</div>
              {#if m.email}<div class="truncate text-[13px] text-content-muted">{m.email}</div>{/if}
            </div>
          </button>
        {/each}
      {/if}
    </div>
  </MobileSheet>
{/if}

<!-- Session options: rename via alias (per-device) + archive — same actions as
     the desktop session row. -->
{#if menuSession}
  {@const s = menuSession}
  <MobileSheet open={!!menuSession} ariaLabel="Session options" onclose={() => (menuSession = null)}>
    <div class="mb-3 flex items-center gap-3 px-1">
      <CyboSessionAvatar agent={s} size={40} radius="12px" />
      <div class="min-w-0 flex-1">
        <div class="truncate text-[16px] font-bold text-content">{sessionName(s)}</div>
        <div class="truncate text-[13px] text-content-muted">{sessionSubtitle(s)}</div>
      </div>
    </div>

    <div class="mb-2">
      <label for="dm-session-alias" class="px-1 text-[12px] font-semibold uppercase tracking-wider text-content-muted">Display name</label>
      <input
        id="dm-session-alias"
        type="text"
        bind:value={aliasDraft}
        placeholder={sharedAgentDisplayName(s, cyboState.list)}
        class="mt-1.5 h-10 w-full rounded-[12px] bg-surface-alt px-4 text-[16px] text-content outline-none placeholder:text-content-muted"
      />
    </div>

    <div class="overflow-hidden rounded-[12px] bg-surface-alt">
      <button
        type="button"
        onclick={saveAlias}
        class="flex min-h-[48px] w-full items-center justify-center px-4 text-[16px] font-semibold text-accent active:bg-raised"
      >
        Save name
      </button>
      {#if sessionAlias.get(s.agentId)}
        <div class="mx-4 h-px" style="background-color: var(--hairline);"></div>
        <button
          type="button"
          onclick={clearAlias}
          class="flex min-h-[48px] w-full items-center justify-center px-4 text-[16px] text-content-muted active:bg-raised"
        >
          Reset to default
        </button>
      {/if}
    </div>

    <div class="mt-3 overflow-hidden rounded-[12px] bg-surface-alt">
      <button
        type="button"
        onclick={archiveSession}
        class="flex min-h-[48px] w-full items-center justify-center px-4 text-[16px] font-semibold text-red-500 active:bg-raised"
      >
        Archive session
      </button>
    </div>
  </MobileSheet>
{/if}

<!-- Terminal options: rename (local alias, like sessions) + close (kill the pty). -->
{#if menuTerminal}
  {@const t = menuTerminal}
  <MobileSheet open={!!menuTerminal} ariaLabel="Terminal options" onclose={() => (menuTerminal = null)}>
    <div class="mb-3 flex items-center gap-3 px-1">
      <span class="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-[12px] bg-surface-alt text-content-muted">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
      </span>
      <div class="min-w-0 flex-1">
        <div class="truncate text-[16px] font-bold text-content">{terminalName(t)}</div>
        <div class="truncate text-[13px] text-content-muted">Terminal</div>
      </div>
    </div>

    <div class="mb-2">
      <label for="dm-terminal-alias" class="px-1 text-[12px] font-semibold uppercase tracking-wider text-content-muted">Display name</label>
      <input
        id="dm-terminal-alias"
        type="text"
        bind:value={terminalAliasDraft}
        placeholder={t.title}
        class="mt-1.5 h-10 w-full rounded-[12px] bg-surface-alt px-4 text-[16px] text-content outline-none placeholder:text-content-muted"
      />
    </div>

    <div class="overflow-hidden rounded-[12px] bg-surface-alt">
      <button
        type="button"
        onclick={saveTerminalAlias}
        class="flex min-h-[48px] w-full items-center justify-center px-4 text-[16px] font-semibold text-accent active:bg-raised"
      >
        Save name
      </button>
      {#if terminalAlias.get(t.terminalId)}
        <div class="mx-4 h-px" style="background-color: var(--hairline);"></div>
        <button
          type="button"
          onclick={clearTerminalAlias}
          class="flex min-h-[48px] w-full items-center justify-center px-4 text-[16px] text-content-muted active:bg-raised"
        >
          Reset to default
        </button>
      {/if}
    </div>

    <div class="mt-3 overflow-hidden rounded-[12px] bg-surface-alt">
      <button
        type="button"
        onclick={closeTerminalRow}
        class="flex min-h-[48px] w-full items-center justify-center px-4 text-[16px] font-semibold text-red-500 active:bg-raised"
      >
        Close terminal
      </button>
    </div>
  </MobileSheet>
{/if}
