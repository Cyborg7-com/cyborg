<script lang="ts">
  // Reusable session list (#706) — ONE component for the cross-surface session
  // views so the sidebar "mine" view and the daemon-detail "daemon" view never
  // drift into three divergent lists. Parameterized by `scope`:
  //
  //   scope="daemon"  — ALL users on one daemon, GROUPED by owner. Each group
  //                     leads with the owner's avatar + name (not cybo/cwd) so
  //                     the daemon owner recognizes whose session each is at a
  //                     glance — "what ran on my machine". (DaemonDetail.)
  //   scope="audit"   — the daemon-OWNER audit lens (#993): same owner-grouping as
  //                     "daemon", but fed by cyborg:list_daemon_sessions (ALL users
  //                     on the daemon, incl. ephemeral/internal summons). Rows where
  //                     `ephemeral || internal` get an "Ephemeral" badge. The list
  //                     lives in DaemonDetail's LOCAL state, never the global store.
  //   scope="mine"    — a flat list already filtered to the current user (+
  //                     shared channel cybos). Kept here so the same row markup
  //                     is reused; the chat sidebar's own rich rows (alias,
  //                     context menu, unread/permission badges) stay where they
  //                     are and just feed this with a pre-filtered list when a
  //                     plain list is wanted.
  //
  // Pure filtering/grouping lives in $lib/session-scope.ts (unit-tested); this
  // component is the thin declarative shell over it.
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { cn } from "$lib/utils.js";
  import { agentDisplayName } from "$lib/agent-display.js";
  import { authState, workspaceState, daemonStatusState } from "$lib/state/app.svelte.js";
  import type { Agent } from "$lib/plugins/agents/types.js";
  import Avatar from "$lib/components/Avatar.svelte";
  import CyboSessionAvatar from "$lib/components/CyboSessionAvatar.svelte";
  import ProviderIcon from "$lib/plugins/agents/components/ProviderIcon.svelte";
  import {
    filterByDaemon,
    filterMine,
    groupByOwner,
    type SessionOwnerGroup,
  } from "$lib/session-scope.js";

  let {
    scope,
    sessions,
    daemonId,
    emptyLabel,
  }: {
    scope: "mine" | "daemon" | "audit";
    // The full agent list to scope from (e.g. workspaceState.agents for "daemon",
    // or the audit listing from cyborg:list_daemon_sessions for "audit").
    sessions: readonly Agent[];
    // Required for scope="daemon"/"audit": which daemon to list.
    daemonId?: string;
    emptyLabel?: string;
  } = $props();

  // The daemon-grouped lenses: owner-grouped over one daemon's sessions.
  const isDaemonGrouped = $derived(scope === "daemon" || scope === "audit");

  const currentUserId = $derived(authState.user?.id);
  const members = $derived(workspaceState.members);

  function memberName(userId: string): string {
    const m = members.find((mm) => mm.userId === userId);
    return m?.name ?? m?.email?.split("@")[0] ?? userId.slice(0, 8);
  }

  // The scoped rows. daemon = all users on this daemon; mine = current user (+
  // shared cybos) across the whole list.
  const scoped = $derived.by<Agent[]>(() => {
    if (isDaemonGrouped) return daemonId ? filterByDaemon(sessions, daemonId) : [];
    return filterMine(sessions, currentUserId);
  });

  // Grouped by owner for the daemon lens (mine sorts first, then others by name,
  // unattributable last). The mine lens is a single implicit group.
  const groups = $derived.by<SessionOwnerGroup<Agent>[]>(() => {
    if (isDaemonGrouped) return groupByOwner(scoped, currentUserId, memberName);
    return scoped.length > 0 ? [{ userId: currentUserId ?? null, sessions: scoped }] : [];
  });

  // Audit-only: badge slash/mention summons (ephemeral binding) and live internal
  // agents so the daemon owner can tell a one-turn summon from a persistent session.
  function isEphemeral(agent: Agent): boolean {
    return scope === "audit" && (agent.ephemeral === true || agent.internal === true);
  }

  // A session's daemon dictates its live dot: only "online" when its daemon is.
  function dotClass(agent: Agent): string {
    const daemonOnline =
      !!agent.daemonId && daemonStatusState.get(agent.daemonId) === "online";
    if (!daemonOnline) return "bg-content-dim";
    if (agent.lifecycle === "running") return "bg-online animate-pulse";
    if (agent.lifecycle === "error") return "bg-error";
    return "bg-online";
  }

  function folderTail(cwd: string): string {
    return cwd.replace(/\/+$/, "").split("/").pop() ?? cwd;
  }

  function openSession(agentId: string): void {
    const wsId = workspaceState.current?.id ?? (page.params.id as string);
    if (wsId) goto(`/workspace/${wsId}/agent/${agentId}`);
  }
</script>

{#if scoped.length === 0}
  <div class="text-[13px] text-content-muted">{emptyLabel ?? "No sessions."}</div>
{:else}
  <div class="flex flex-col gap-3">
    {#each groups as group (group.userId ?? "__unattributed__")}
      {#if isDaemonGrouped}
        <!-- Owner header: avatar + name lead the group so the daemon owner sees
             WHOSE sessions these are before any cybo/cwd detail. -->
        {@const isMineGroup = group.userId != null && group.userId === currentUserId}
        {@const ownerName = group.userId ? memberName(group.userId) : "Unknown user"}
        <div class="flex flex-col gap-1">
          <div class="flex items-center gap-2 px-1">
            <Avatar
              name={ownerName}
              image={group.userId ? authState.getMemberImage(group.userId) : null}
              width={20}
              fontSize={9}
              borderRadius={6}
            />
            <span class="text-[12px] font-semibold text-content truncate">{ownerName}</span>
            {#if isMineGroup}
              <span class="rounded bg-surface-alt px-1 text-[10px] uppercase tracking-wide text-content-muted">You</span>
            {/if}
            <span class="ml-auto text-[11px] text-content-dim tabular-nums">{group.sessions.length}</span>
          </div>
          <div class="flex flex-col gap-1 border-l border-edge-dim pl-2">
            {#each group.sessions as agent (agent.agentId)}
              {@render sessionRow(agent)}
            {/each}
          </div>
        </div>
      {:else}
        {#each group.sessions as agent (agent.agentId)}
          {@render sessionRow(agent)}
        {/each}
      {/if}
    {/each}
  </div>
{/if}

{#snippet sessionRow(agent: Agent)}
  <button
    type="button"
    onclick={() => openSession(agent.agentId)}
    class="group/session flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] hover:bg-hover-gray transition-colors cursor-pointer"
    aria-label={`Session ${agentDisplayName(agent)} — ${agent.lifecycle}`}
  >
    <span class={cn("h-2 w-2 rounded-full shrink-0", dotClass(agent))}></span>
    <div class="shrink-0 text-content-muted">
      {#if agent.cyboId}
        <CyboSessionAvatar {agent} size={14} />
      {:else}
        <ProviderIcon provider={agent.provider} size={14} />
      {/if}
    </div>
    <span class="truncate text-content">{agentDisplayName(agent)}</span>
    {#if isEphemeral(agent)}
      <span
        class="shrink-0 rounded bg-surface-alt px-1 text-[10px] uppercase tracking-wide text-content-muted"
        title="One-turn slash/@mention summon">Ephemeral</span>
    {/if}
    {#if agent.cwd}
      <span
        class="ml-auto shrink-0 max-w-[140px] truncate rounded bg-surface-alt px-1 text-[10px] leading-[14px] text-content-muted"
        title={agent.cwd}
      >
        {folderTail(agent.cwd)}
      </span>
    {/if}
    <span class="shrink-0 text-[11px] text-content-dim">{agent.lifecycle}</span>
  </button>
{/snippet}
