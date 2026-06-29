<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { client, daemonState, daemonAccessRequestsState } from "$lib/state/app.svelte.js";
  import { authState, workspaceState } from "$lib/core/state.svelte.js";
  import { onMount } from "svelte";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import RequestDaemonAccessButton from "$lib/components/daemon/RequestDaemonAccessButton.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { roleForScopes, ROLE_META } from "$lib/daemon-scopes.js";

  interface DaemonInfo {
    id: string;
    label: string;
    ownerId: string;
    status: string;
    lastSeenAt: number | null;
    meta?: { agents?: number } | null;
  }

  interface AccessEntry {
    daemonId: string;
    userId: string;
    grantedBy: string;
    grantedAt: number;
  }

  let loading = $state(true);
  let localDaemonId = $state<string | null>(null);
  let daemons = $state<DaemonInfo[]>([]);
  let accessList = $state<AccessEntry[]>([]);
  let toggling = $state<string | null>(null);

  const currentUser = $derived(authState.user);
  const allMembers = $derived(workspaceState.members);
  const members = $derived(allMembers.filter((m) => m.role !== "viewer"));
  const viewerCount = $derived(allMembers.length - members.length);
  const workspaceId = $derived(workspaceState.current?.id ?? "");

  function isOwner(daemon: DaemonInfo): boolean {
    return daemon.ownerId === currentUser?.id;
  }

  function isDaemonOwner(daemon: DaemonInfo, userId: string): boolean {
    return daemon.ownerId === userId;
  }

  function hasAccess(daemonId: string, userId: string): boolean {
    return accessList.some((a) => a.daemonId === daemonId && a.userId === userId);
  }

  function cellKey(daemonId: string, userId: string): string {
    return `${daemonId}:${userId}`;
  }

  async function toggleAccess(daemon: DaemonInfo, userId: string): Promise<void> {
    if (!workspaceId || !isOwner(daemon) || isDaemonOwner(daemon, userId)) return;
    const key = cellKey(daemon.id, userId);
    toggling = key;
    try {
      if (hasAccess(daemon.id, userId)) {
        await client.revokeDaemonAccess(workspaceId, daemon.id, userId);
        accessList = accessList.filter((a) => !(a.daemonId === daemon.id && a.userId === userId));
      } else {
        await client.grantDaemonAccess(workspaceId, daemon.id, userId);
        const resp = await client.fetchDaemonAccess(workspaceId);
        accessList = resp.access;
      }
    } catch (err) {
      console.error("Toggle access failed:", err);
    } finally {
      toggling = null;
    }
  }

  function memberDisplay(m: { userId: string; name: string | null; email: string }): string {
    return m.name ?? m.email;
  }

  function memberInitial(m: { name: string | null; email: string }): string {
    return (m.name ?? m.email ?? "?").charAt(0).toUpperCase();
  }

  function statusDot(status: string): string {
    if (status === "online") return "bg-online";
    return "bg-content-dim/30";
  }

  // Prefer the live, broadcast-driven status (the same source the Agents view uses)
  // so this page reflects a daemon going offline in real time, instead of the
  // status frozen at the on-mount fetch. Falls back to that fetch when the global
  // daemon state doesn't track this daemon.
  function isDaemonOnline(d: { id: string; status: string }): boolean {
    if (daemonState.byId(d.id)) return daemonState.isOnline(d.id);
    return d.status === "online";
  }

  // ─── Owner inbox: pending daemon access-requests (#705) ───────────
  // Incoming requests on daemons I own, awaiting approve/deny. Reuses the global
  // live-push-populated state + the same resolve RPC as DaemonDetail, surfaced here
  // so the owner can act from the (mobile-reachable) Daemons page. The count also
  // badges the Daemons tab in MobileNav — the no-Activity-tab owner notification.
  const incomingRequests = $derived(daemonAccessRequestsState.pendingIncoming(currentUser?.id));
  let resolvingRequest = $state<string | null>(null);

  function daemonLabelById(id: string): string {
    return daemons.find((d) => d.id === id)?.label ?? "this daemon";
  }
  function requesterDisplay(req: { requesterId: string; requesterName: string | null }): string {
    return (
      req.requesterName ??
      allMembers.find((m) => m.userId === req.requesterId)?.name ??
      "Someone"
    );
  }
  function roleLabelFor(scopes: readonly string[]): string {
    const role = roleForScopes(scopes);
    return role === "custom" ? "custom access" : ROLE_META[role].label;
  }

  async function resolveRequest(requestId: string, decision: "approve" | "deny"): Promise<void> {
    if (!workspaceId || resolvingRequest) return;
    resolvingRequest = requestId;
    try {
      const { request } = await client.resolveDaemonAccessRequest(workspaceId, requestId, decision);
      // Reflect the resolution locally (pending → approved/denied) so the row drops
      // out of the inbox immediately; on approve the server ran the grant, so refresh
      // the access matrix too.
      daemonAccessRequestsState.upsert(request);
      if (decision === "approve") {
        const resp = await client.fetchDaemonAccess(workspaceId);
        accessList = resp.access;
      }
    } catch (err) {
      console.error("Resolve daemon access request failed:", err);
    } finally {
      resolvingRequest = null;
    }
  }

  onMount(async () => {
    try {
      const [daemonInfo, daemonsList, accessResp] = await Promise.all([
        client.fetchDaemonInfo(),
        workspaceId ? client.listDaemons(workspaceId) : { daemons: [] },
        workspaceId ? client.fetchDaemonAccess(workspaceId) : { access: [] },
      ]);
      localDaemonId = daemonInfo.daemonId;
      daemons = daemonsList.daemons;
      accessList = accessResp.access;
    } catch (err) {
      console.error("Failed to load daemon info:", err);
    } finally {
      loading = false;
    }
  });
</script>

<div class={viewportState.isMobile ? "px-4 pb-[calc(56px+var(--sab))] pt-3 space-y-6" : "mx-auto max-w-3xl px-6 py-8 space-y-8"}>
  {#if !viewportState.isMobile}
    <header>
      <h1 class="text-lg font-semibold text-content">Daemon</h1>
      <p class="mt-1 text-xs text-content-muted">
        Device identity, ownership, and agent access permissions
      </p>
    </header>
  {/if}

  {#if loading}
    <div class="flex items-center justify-center py-16">
      <div class="h-5 w-5 rounded-full border-2 border-content-dim border-t-transparent animate-spin"></div>
    </div>
  {:else}

  <!-- Current account -->
  <section class="space-y-3">
    <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
      Current account
    </span>
    <div class="rounded-lg border border-edge px-4 py-3.5 flex items-center gap-3">
      <div class="h-9 w-9 rounded-full bg-btn-primary-bg/10 flex items-center justify-center shrink-0">
        <span class="text-sm font-bold text-btn-primary-bg">
          {(currentUser?.name ?? currentUser?.email ?? "?").charAt(0).toUpperCase()}
        </span>
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium text-content truncate">{currentUser?.name ?? "Unknown"}</p>
        <p class="text-[11px] text-content-muted truncate">{currentUser?.email ?? ""}</p>
      </div>
      {#if localDaemonId}
        <div class="text-right shrink-0">
          <p class="text-[10px] text-content-dim uppercase tracking-wider">This daemon</p>
          <p class="text-[11px] font-mono text-content-muted">{localDaemonId}</p>
        </div>
      {/if}
    </div>
  </section>

  <!-- Owner inbox: pending access requests (#705). Reuses the live-push state +
       resolve RPC; the same count badges the Daemons tab in MobileNav. -->
  {#if incomingRequests.length > 0}
    <section class="space-y-3">
      <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
        Pending access requests
      </span>
      <div class="rounded-lg border border-edge divide-y divide-edge">
        {#each incomingRequests as req (req.id)}
          <div class="px-4 py-3 space-y-2.5">
            <p class="text-sm text-content">
              <span class="font-medium">{requesterDisplay(req)}</span> requested
              <span class="font-medium">{roleLabelFor(req.scopes)}</span> on
              <span class="font-medium">{daemonLabelById(req.daemonId)}</span>
            </p>
            <div class="flex items-center gap-2">
              <Button
                size="sm"
                class="flex-1"
                disabled={resolvingRequest === req.id}
                onclick={() => resolveRequest(req.id, "approve")}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                class="flex-1"
                disabled={resolvingRequest === req.id}
                onclick={() => resolveRequest(req.id, "deny")}
              >
                Deny
              </Button>
            </div>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <!-- Workspace daemons -->
  <section class="space-y-3">
    <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
      Workspace daemons
    </span>
    {#if daemons.length === 0}
      <div class="rounded-lg border border-edge px-4 py-6 text-center">
        <p class="text-sm text-content-dim">No daemons connected to this workspace</p>
      </div>
    {:else}
      <div class="rounded-lg border border-edge divide-y divide-edge">
        {#each daemons as daemon (daemon.id)}
          <div class="px-4 py-3">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <div class={cn("h-1.5 w-1.5 rounded-full shrink-0", statusDot(isDaemonOnline(daemon) ? "online" : "offline"))}></div>
                <span class="text-sm font-medium text-content">{daemon.label}</span>
                {#if daemon.id === localDaemonId}
                  <span class="text-[9px] font-medium text-btn-primary-bg bg-btn-primary-bg/10 px-1.5 py-0.5 rounded">THIS DEVICE</span>
                {/if}
              </div>
              <div class="flex items-center gap-2">
                {#if isOwner(daemon)}
                  <span class="text-[9px] font-medium text-online bg-online/10 px-1.5 py-0.5 rounded">OWNER</span>
                {/if}
                <span class={cn("text-[10px] font-medium", isDaemonOnline(daemon) ? "text-online" : "text-content-dim")}>
                  {isDaemonOnline(daemon) ? "Online" : "Offline"}
                </span>
              </div>
            </div>
            <div class="flex items-center gap-4 mt-1 text-[11px] text-content-dim">
              <span class="font-mono">{daemon.id}</span>
              {#if daemon.meta?.agents != null}
                <span>{daemon.meta.agents} agent{daemon.meta.agents !== 1 ? "s" : ""}</span>
              {/if}
            </div>
            {#if currentUser && !isOwner(daemon) && !hasAccess(daemon.id, currentUser.id)}
              <!-- #705 requester-side: a workspace daemon you DON'T own and have no
                   access to → request access (collapses to a disabled "Requested"
                   once a request is pending). Same affordance + flow as the Home
                   Machines list and DaemonDetail — now reachable on mobile. -->
              <div class="mt-2.5">
                <RequestDaemonAccessButton
                  {workspaceId}
                  daemonId={daemon.id}
                  daemonLabel={daemon.label}
                  variant="card"
                />
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <!-- Access matrix: Daemons vs Users -->
  {#if daemons.length > 0 && members.length > 0}
    <section class="space-y-3">
      <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
        Agent access matrix
      </span>
      <p class="text-[11px] text-content-dim leading-relaxed">
        Controls which workspace members can prompt agents on each daemon. Daemon owners always have access and can grant it to others.
      </p>
      {#if viewportState.isMobile}
        <!-- Mobile: stacked per-daemon cards (no horizontal table overflow).
             One card per daemon holding its per-member access rows — same data
             and the same owner/toggle/read-only states as the desktop table. -->
        <div class="space-y-3">
          {#each daemons as daemon (daemon.id)}
            <div class="rounded-lg border border-edge overflow-hidden">
              <div class="flex items-center justify-between gap-2 border-b border-edge px-4 py-2.5">
                <div class="flex items-center gap-1.5 min-w-0">
                  <div class={cn("h-1.5 w-1.5 rounded-full shrink-0", statusDot(isDaemonOnline(daemon) ? "online" : "offline"))}></div>
                  <span class="text-[13px] font-medium text-content truncate">{daemon.label}</span>
                  {#if daemon.id === localDaemonId}
                    <span class="text-[8px] font-medium text-btn-primary-bg bg-btn-primary-bg/10 px-1.5 py-0.5 rounded shrink-0">THIS DEVICE</span>
                  {/if}
                </div>
                {#if isOwner(daemon)}
                  <span class="text-[9px] font-medium text-online bg-online/10 px-1.5 py-0.5 rounded shrink-0">OWNER</span>
                {/if}
              </div>
              <div class="divide-y divide-edge">
                {#each members as member (member.userId)}
                  <div class="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div class="flex items-center gap-2 min-w-0">
                      <div class="h-6 w-6 rounded-full bg-btn-primary-bg/10 flex items-center justify-center shrink-0">
                        <span class="text-[10px] font-bold text-btn-primary-bg">{memberInitial(member)}</span>
                      </div>
                      <div class="min-w-0">
                        <p class="text-[12px] font-medium text-content truncate">{memberDisplay(member)}</p>
                        {#if member.userId === currentUser?.id}
                          <p class="text-[9px] text-content-dim">you</p>
                        {/if}
                      </div>
                    </div>
                    <div class="shrink-0">
                      {#if isDaemonOwner(daemon, member.userId)}
                        <!-- Owner: always has access, not toggleable -->
                        <div class="inline-flex items-center gap-1 text-[10px] font-medium text-online bg-online/10 px-2 py-1 rounded-full">
                          <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2L15 8.5 22 9.5 17 14.5 18.5 21.5 12 18 5.5 21.5 7 14.5 2 9.5 9 8.5Z"/></svg>
                          Owner
                        </div>
                      {:else if isOwner(daemon)}
                        <!-- Current user owns this daemon: show clickable toggle -->
                        <button
                          type="button"
                          onclick={() => toggleAccess(daemon, member.userId)}
                          disabled={toggling === cellKey(daemon.id, member.userId)}
                          class={cn(
                            "inline-flex items-center justify-center gap-1 text-[10px] font-medium px-2.5 py-1 rounded-full transition-all",
                            toggling === cellKey(daemon.id, member.userId)
                              ? "text-warning bg-warning/10 cursor-wait"
                              : hasAccess(daemon.id, member.userId)
                                ? "text-btn-primary-bg bg-btn-primary-bg/10 hover:bg-btn-primary-bg/20"
                                : "text-content-dim bg-surface-alt hover:bg-surface-alt/80 hover:text-content-muted",
                          )}
                        >
                          {#if toggling === cellKey(daemon.id, member.userId)}
                            <div class="h-3 w-3 rounded-full border border-warning border-t-transparent animate-spin"></div>
                          {:else if hasAccess(daemon.id, member.userId)}
                            <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                            Granted
                          {:else}
                            <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                            No access
                          {/if}
                        </button>
                      {:else}
                        <!-- Not owned by current user: read-only badge -->
                        <span class={cn(
                          "inline-flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-full",
                          hasAccess(daemon.id, member.userId)
                            ? "text-btn-primary-bg/70 bg-btn-primary-bg/5"
                            : "text-content-dim/50 bg-surface-alt/50",
                        )}>
                          {#if hasAccess(daemon.id, member.userId)}
                            <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
                            Granted
                          {:else}
                            <svg class="h-3 w-3 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="18" y1="6" x2="6" y2="18"/></svg>
                            &mdash;
                          {/if}
                        </span>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {:else}
      <div class="rounded-lg border border-edge overflow-x-auto">
        <table class="w-full text-xs">
          <thead>
            <tr class="border-b border-edge">
              <th class="text-left px-3 py-2.5 text-[10px] font-medium text-content-dim uppercase tracking-wider w-[200px]">
                Member
              </th>
              {#each daemons as daemon (daemon.id)}
                <th class="text-center px-3 py-2.5 min-w-[120px]">
                  <div class="flex flex-col items-center gap-0.5">
                    <div class="flex items-center gap-1.5">
                      <div class={cn("h-1.5 w-1.5 rounded-full", statusDot(isDaemonOnline(daemon) ? "online" : "offline"))}></div>
                      <span class="text-[11px] font-medium text-content">{daemon.label}</span>
                    </div>
                    {#if daemon.id === localDaemonId}
                      <span class="text-[8px] font-medium text-btn-primary-bg">THIS DEVICE</span>
                    {/if}
                  </div>
                </th>
              {/each}
            </tr>
          </thead>
          <tbody class="divide-y divide-edge">
            {#each members as member (member.userId)}
              <tr class="hover:bg-surface-alt/50 transition-colors">
                <td class="px-3 py-2">
                  <div class="flex items-center gap-2">
                    <div class="h-6 w-6 rounded-full bg-btn-primary-bg/10 flex items-center justify-center shrink-0">
                      <span class="text-[10px] font-bold text-btn-primary-bg">{memberInitial(member)}</span>
                    </div>
                    <div class="min-w-0">
                      <p class="text-[11px] font-medium text-content truncate">{memberDisplay(member)}</p>
                      {#if member.userId === currentUser?.id}
                        <p class="text-[9px] text-content-dim">you</p>
                      {/if}
                    </div>
                  </div>
                </td>
                {#each daemons as daemon (daemon.id)}
                  <td class="px-3 py-2 text-center">
                    {#if isDaemonOwner(daemon, member.userId)}
                      <!-- Owner: always has access, not toggleable -->
                      <div class="inline-flex items-center gap-1 text-[10px] font-medium text-online bg-online/10 px-2 py-1 rounded-full">
                        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2L15 8.5 22 9.5 17 14.5 18.5 21.5 12 18 5.5 21.5 7 14.5 2 9.5 9 8.5Z"/></svg>
                        Owner
                      </div>
                    {:else if isOwner(daemon)}
                      <!-- Current user owns this daemon: show clickable toggle -->
                      <button
                        type="button"
                        onclick={() => toggleAccess(daemon, member.userId)}
                        disabled={toggling === cellKey(daemon.id, member.userId)}
                        class={cn(
                          "inline-flex items-center justify-center gap-1 text-[10px] font-medium px-2.5 py-1 rounded-full transition-all",
                          toggling === cellKey(daemon.id, member.userId)
                            ? "text-warning bg-warning/10 cursor-wait"
                            : hasAccess(daemon.id, member.userId)
                              ? "text-btn-primary-bg bg-btn-primary-bg/10 hover:bg-btn-primary-bg/20"
                              : "text-content-dim bg-surface-alt hover:bg-surface-alt/80 hover:text-content-muted",
                        )}
                      >
                        {#if toggling === cellKey(daemon.id, member.userId)}
                          <div class="h-3 w-3 rounded-full border border-warning border-t-transparent animate-spin"></div>
                        {:else if hasAccess(daemon.id, member.userId)}
                          <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                          Granted
                        {:else}
                          <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                          No access
                        {/if}
                      </button>
                    {:else}
                      <!-- Not owned by current user: read-only badge -->
                      <span class={cn(
                        "inline-flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-full",
                        hasAccess(daemon.id, member.userId)
                          ? "text-btn-primary-bg/70 bg-btn-primary-bg/5"
                          : "text-content-dim/50 bg-surface-alt/50",
                      )}>
                        {#if hasAccess(daemon.id, member.userId)}
                          <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
                          Granted
                        {:else}
                          <svg class="h-3 w-3 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="18" y1="6" x2="6" y2="18"/></svg>
                          &mdash;
                        {/if}
                      </span>
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {/if}
      {#if daemons.some((d) => isOwner(d))}
        <p class="text-[10px] text-content-dim">
          Click a cell to grant or revoke agent access on your daemons.
        </p>
      {/if}
      {#if viewerCount > 0}
        <p class="text-[10px] text-content-dim">
          {viewerCount} viewer{viewerCount !== 1 ? "s" : ""} excluded — viewers cannot interact with agents.
        </p>
      {/if}
    </section>
  {/if}

  <!-- How it works -->
  <section class="space-y-3">
    <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
      How it works
    </span>
    <div class="rounded-lg border border-edge px-4 py-3.5 space-y-3">
      <div class="flex items-start gap-3">
        <div class="mt-0.5 shrink-0 h-5 w-5 rounded bg-surface-alt flex items-center justify-center">
          <span class="text-[10px] font-bold text-content-dim">1</span>
        </div>
        <div>
          <p class="text-sm text-content">Device identity</p>
          <p class="text-[11px] text-content-dim">Each daemon has a stable ID tied to the machine, persisted across restarts. Independent of which user is logged in.</p>
        </div>
      </div>
      <div class="flex items-start gap-3">
        <div class="mt-0.5 shrink-0 h-5 w-5 rounded bg-surface-alt flex items-center justify-center">
          <span class="text-[10px] font-bold text-content-dim">2</span>
        </div>
        <div>
          <p class="text-sm text-content">Ownership</p>
          <p class="text-[11px] text-content-dim">The first user to log in claims the daemon. The owner controls who can access agents on their device.</p>
        </div>
      </div>
      <div class="flex items-start gap-3">
        <div class="mt-0.5 shrink-0 h-5 w-5 rounded bg-surface-alt flex items-center justify-center">
          <span class="text-[10px] font-bold text-content-dim">3</span>
        </div>
        <div>
          <p class="text-sm text-content">Agent access</p>
          <p class="text-[11px] text-content-dim">Workspace members can message humans freely. To prompt agents on a specific daemon, the daemon owner must grant explicit access via the matrix above.</p>
        </div>
      </div>
    </div>
  </section>
  {/if}
</div>
