<script lang="ts">
  import {
    workspaceState,
    removeMember,
    updateMemberRole,
    inviteMember,
    listPendingInvitations,
    resendInvitation,
    cancelInvitation,
    type PendingInvitation,
  } from "$lib/state/app.svelte.js";
  import { cn } from "$lib/utils.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import InviteMembersModal from "$lib/components/settings/InviteMembersModal.svelte";

  let inviteOpen = $state(false);
  let removingId = $state<string | null>(null);
  let membersMsg = $state("");

  // Inline invite-from-email (additive to the modal). Lets admins fire off
  // invitations without leaving the members page; the modal stays available for
  // anyone who prefers it / wants the per-agent access controls.
  let inlineEmail = $state("");
  let inlineRole = $state<"admin" | "member" | "viewer">("member");
  let inlineSending = $state(false);
  let inlineError = $state("");
  let inlineSentEmail = $state("");

  // Batch actions over the pending list (resend-all). Per-row Resend/Cancel
  // remain; this just adds a one-click "resend everything still pending".
  let batchResending = $state(false);
  // Filter toggle: hide invites with >24h left so admins can focus on the ones
  // about to lapse. Off by default — the full list shows.
  let onlyExpiring = $state(false);
  // Collapse the whole pending section once invite work is done.
  let pendingCollapsed = $state(false);

  // Pending invitations are server-authoritative (cyborg:list_pending_invitations):
  // each carries its own invitationId, role and 7-day expiry, which the per-row
  // Resend (resets the expiry + re-emails) and Cancel (revokes) actions key off.
  let invitations = $state<PendingInvitation[]>([]);
  let resendingId = $state<string | null>(null);
  let cancelingId = $state<string | null>(null);

  // Tick once a minute so the expiry countdown badges stay current without a reload.
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => {
      now = Date.now();
    }, 60_000);
    return () => clearInterval(t);
  });

  const myRole = $derived(workspaceState.current?.role ?? "viewer");
  const canManage = $derived(myRole === "owner" || myRole === "admin");
  const canChangeRoles = $derived(myRole === "owner");

  // Only real (joined) members render in the members list; pending invites live
  // in their own section below, sourced from the invitations RPC.
  const members = $derived(workspaceState.members.filter((m) => m.membershipType !== "invited"));

  function flash(msg: string, ms = 2000) {
    membersMsg = msg;
    setTimeout(() => {
      membersMsg = "";
    }, ms);
  }

  // Load pending invitations on mount + whenever the active workspace changes.
  $effect(() => {
    const wsId = workspaceState.current?.id;
    if (!wsId || !canManage) {
      invitations = [];
      return;
    }
    void refreshInvitations(wsId);
  });

  async function refreshInvitations(wsId?: string): Promise<void> {
    const id = wsId ?? workspaceState.current?.id;
    if (!id) return;
    try {
      invitations = await listPendingInvitations(id);
    } catch {
      // Older relay without the invitations RPC — leave the section empty.
      invitations = [];
    }
  }

  async function handleRemove(userId: string) {
    try {
      await removeMember(userId);
      removingId = null;
      flash("Member removed");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Failed to remove member");
    }
  }

  async function handleRoleChange(userId: string, role: string) {
    try {
      await updateMemberRole(userId, role as "admin" | "member" | "viewer");
      flash("Role updated");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Failed to update role");
    }
  }

  async function handleResend(invitationId: string) {
    resendingId = invitationId;
    try {
      await resendInvitation(invitationId);
      await refreshInvitations();
      flash("Invitation resent");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Failed to resend");
    } finally {
      resendingId = null;
    }
  }

  async function handleCancel(invitationId: string) {
    cancelingId = invitationId;
    try {
      await cancelInvitation(invitationId);
      invitations = invitations.filter((i) => i.id !== invitationId);
      flash("Invitation canceled");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Failed to cancel");
    } finally {
      cancelingId = null;
    }
  }

  // Inline invite send — mirrors the modal's send, then refreshes the pending
  // list so the new invitation appears below without opening anything.
  async function handleInlineInvite() {
    const to = inlineEmail.trim();
    if (!to || inlineSending) return;
    inlineSending = true;
    inlineError = "";
    inlineSentEmail = "";
    try {
      await inviteMember(to, inlineRole);
      inlineSentEmail = to;
      inlineEmail = "";
      await refreshInvitations();
      flash(`Invitation sent to ${to}`);
    } catch (e) {
      inlineError = e instanceof Error ? e.message : "Failed to send invitation";
    } finally {
      inlineSending = false;
    }
  }

  // Resend every still-pending invitation in one action (resets each 7-day
  // expiry + re-emails). Best-effort: a single failure doesn't abort the rest.
  async function handleResendAll() {
    if (batchResending || invitations.length === 0) return;
    batchResending = true;
    let ok = 0;
    let failed = 0;
    for (const inv of invitations) {
      try {
        await resendInvitation(inv.id);
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    await refreshInvitations();
    batchResending = false;
    flash(failed > 0 ? `Resent ${ok}, ${failed} failed` : `Resent ${ok} invitation${ok !== 1 ? "s" : ""}`);
  }

  // Pending list after the "expiring <24h" filter, used by the rows + counts.
  const visibleInvitations = $derived(
    onlyExpiring ? invitations.filter((i) => i.expiresAt - now < 86_400_000) : invitations,
  );

  // Copy a pending invite's shareable link (the same `/invite/<token>` URL the
  // modal shows right after Send) so it can be retrieved any time, not just then.
  async function handleCopyLink(invitationId: string) {
    const link = `https://app.cyborg7.com/invite/${invitationId}`;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      const el = document.createElement("textarea");
      el.value = link;
      el.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand("copy");
      } catch {
        /* ignore */
      }
      document.body.removeChild(el);
    }
    flash("Invite link copied");
  }

  // The modal's Send doesn't bubble a result here, so refresh on close to pick
  // up a freshly-sent invitation.
  function handleInviteClose() {
    inviteOpen = false;
    void refreshInvitations();
  }

  // Expiry countdown: "Nd left" / "Nh left" (red when <24h) / "Expired".
  function expiryLabel(expiresAt: number): string {
    const ms = expiresAt - now;
    if (ms <= 0) return "Expired";
    const hours = Math.floor(ms / 3_600_000);
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      return `${days}d left`;
    }
    if (hours >= 1) return `${hours}h left`;
    const mins = Math.max(1, Math.floor(ms / 60_000));
    return `${mins}m left`;
  }

  function expiryBadgeClass(expiresAt: number): string {
    const ms = expiresAt - now;
    if (ms <= 0) return "bg-error/15 text-error";
    if (ms < 86_400_000) return "bg-error/15 text-error"; // <24h
    return "bg-surface-alt text-content-muted";
  }

  function roleBadgeClass(role: string): string {
    if (role === "owner") return "bg-purple-500/15 text-purple-400";
    if (role === "admin") return "bg-blue-500/15 text-blue-400";
    if (role === "viewer") return "bg-surface-alt text-content-muted";
    return "bg-surface-alt text-content-dim";
  }

  function initial(name: string | null, email: string): string {
    return (name ?? email).charAt(0).toUpperCase();
  }
</script>

{#if viewportState.isMobile}
  <!-- ── Mobile: iOS grouped inset cards ── -->
  <div class="px-4 pb-8 pt-3 space-y-6">

    <!-- Flash message -->
    {#if membersMsg}
      <div class={cn(
        "overflow-hidden rounded-[14px] px-[16px] py-[12px] text-[14px] font-medium",
        membersMsg.includes("Failed") ? "bg-error/10 text-error" : "bg-online/10 text-online",
      )}>
        {membersMsg}
      </div>
    {/if}

    <!-- Members list -->
    <div>
      <div class="mb-2 flex items-center justify-between px-[4px]">
        <p class="text-[13px] font-semibold uppercase tracking-wide text-content-muted">
          Members
          <span class="ml-1 font-normal normal-case text-content-muted">{members.length}</span>
          {#if invitations.length > 0}
            <span class="ml-1 inline-flex items-center rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning normal-case">
              {invitations.length} pending
            </span>
          {/if}
        </p>
        {#if canManage}
          <button
            type="button"
            onclick={() => (inviteOpen = true)}
            class="pressable rounded-[10px] bg-btn-primary-bg px-3 py-1.5 text-[14px] font-medium text-btn-primary-text focus-ring"
          >
            Invite
          </button>
        {/if}
      </div>

      <div class="overflow-hidden rounded-[14px] bg-surface-alt">
        {#each members as member, mi (member.userId)}
          {#if mi > 0}<div class="ml-[60px]" style="height: 0.5px; background: var(--hairline);"></div>{/if}
          <div>
            <div class="flex min-h-[56px] items-center gap-3 px-[16px] py-[8px]">
              <!-- 44pt avatar -->
              <div class="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full bg-btn-primary-bg/20 text-[17px] font-medium text-btn-primary-bg overflow-hidden">
                {#if member.imageUrl}
                  <img src={member.imageUrl} alt="" class="h-full w-full object-cover" />
                {:else}
                  {initial(member.name, member.email)}
                {/if}
              </div>

              <div class="min-w-0 flex-1">
                <div class="text-[16px] font-medium text-content truncate">
                  {member.name ?? member.email}
                </div>
                {#if member.name}
                  <div class="text-[13px] text-content-muted truncate">{member.email}</div>
                {/if}
              </div>

              {#if canChangeRoles && member.role !== "owner"}
                <select
                  value={member.role}
                  onchange={(e) => handleRoleChange(member.userId, (e.target as HTMLSelectElement).value)}
                  class="h-[36px] rounded-[8px] border border-edge bg-surface px-2 text-[14px] text-content outline-none"
                  aria-label="Member role"
                >
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                  <option value="viewer">Viewer</option>
                </select>
              {:else}
                <span class={cn("rounded-full px-2 py-0.5 text-[13px] font-medium capitalize", roleBadgeClass(member.role))}>
                  {member.role}
                </span>
              {/if}

              {#if canManage && member.role !== "owner"}
                <button
                  type="button"
                  onclick={() => (removingId = removingId === member.userId ? null : member.userId)}
                  class="pressable flex h-[36px] w-[36px] items-center justify-center rounded-full text-content-muted focus-ring"
                  aria-label="Remove member"
                >
                  <svg class="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              {/if}
            </div>

            {#if removingId === member.userId}
              <div class="flex items-center gap-3 bg-error/5 px-[16px] pb-[12px] pt-[8px]">
                <span class="min-w-0 flex-1 text-[13px] text-content-muted">
                  Remove <strong class="text-content">{member.name ?? member.email}</strong> from workspace?
                </span>
                <button
                  type="button"
                  onclick={() => handleRemove(member.userId)}
                  class="pressable rounded-[8px] bg-error px-3 py-1.5 text-[14px] font-medium text-accent-foreground focus-ring"
                >
                  Remove
                </button>
                <button
                  type="button"
                  onclick={() => (removingId = null)}
                  class="pressable rounded-[8px] border border-edge px-3 py-1.5 text-[14px] text-content-muted focus-ring"
                >
                  Cancel
                </button>
              </div>
            {/if}
          </div>
        {:else}
          <div class="px-[16px] py-[24px] text-center text-[15px] text-content-muted">
            No members yet
          </div>
        {/each}
      </div>
    </div>

    <!-- Inline invite (mobile: stacked form in a card) -->
    {#if canManage}
      <div>
        <div class="mb-2 flex items-center justify-between px-[4px]">
          <p class="text-[13px] font-semibold uppercase tracking-wide text-content-muted">Invite by Email</p>
          <button
            type="button"
            onclick={() => (inviteOpen = true)}
            class="text-[13px] text-accent"
          >
            More options
          </button>
        </div>
        <div class="overflow-hidden rounded-[14px] bg-surface-alt px-[16px] py-[12px] space-y-3">
          <form
            onsubmit={(e) => { e.preventDefault(); handleInlineInvite(); }}
            class="space-y-3"
          >
            <input
              bind:value={inlineEmail}
              type="email"
              placeholder="colleague@example.com"
              class="h-[44px] w-full rounded-[10px] border border-edge bg-surface px-3 text-[16px] text-content outline-none placeholder:text-content-muted focus:border-accent"
            />
            <div class="flex items-center gap-3">
              <select
                bind:value={inlineRole}
                class="h-[44px] flex-1 rounded-[10px] border border-edge bg-surface px-3 text-[16px] text-content outline-none"
                aria-label="Invite role"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                <option value="viewer">Viewer</option>
              </select>
              <button
                type="submit"
                disabled={inlineSending || !inlineEmail.trim()}
                class="pressable h-[44px] shrink-0 rounded-[10px] bg-btn-primary-bg px-5 text-[16px] font-medium text-btn-primary-text disabled:opacity-40 focus-ring"
              >
                {inlineSending ? "Sending…" : "Send"}
              </button>
            </div>
          </form>
          {#if inlineError}
            <p class="text-[13px] text-error">{inlineError}</p>
          {:else if inlineSentEmail}
            <p class="text-[13px] text-online">Invitation sent to {inlineSentEmail}</p>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Pending Invitations -->
    {#if canManage && invitations.length > 0}
      <div>
        <div class="mb-2 flex flex-wrap items-center gap-2 px-[4px]">
          <button
            type="button"
            onclick={() => (pendingCollapsed = !pendingCollapsed)}
            class="pressable flex items-center gap-1.5 text-[13px] font-semibold uppercase tracking-wide text-content-muted focus-ring"
            aria-expanded={!pendingCollapsed}
          >
            <svg
              class={cn("h-3.5 w-3.5 transition-transform", !pendingCollapsed && "rotate-90")}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            Pending Invitations
            <span class="font-normal normal-case">{invitations.length}</span>
          </button>

          <div class="ml-auto flex items-center gap-2">
            <button
              type="button"
              onclick={() => (onlyExpiring = !onlyExpiring)}
              class={cn(
                "pressable rounded-[8px] border px-2.5 py-1 text-[13px] transition-colors focus-ring",
                onlyExpiring
                  ? "border-error/40 bg-error/10 text-error"
                  : "border-edge text-content-muted",
              )}
              aria-pressed={onlyExpiring}
            >
              Expiring &lt;24h
            </button>
            {#if invitations.length > 1}
              <button
                type="button"
                onclick={handleResendAll}
                disabled={batchResending}
                class="pressable rounded-[8px] border border-edge px-2.5 py-1 text-[13px] text-content-muted disabled:opacity-50 focus-ring"
              >
                {batchResending ? "Resending…" : "Resend all"}
              </button>
            {/if}
          </div>
        </div>

        {#if !pendingCollapsed}
          <div class="overflow-hidden rounded-[14px] bg-surface-alt">
            {#each visibleInvitations as inv, ii (inv.id)}
              {#if ii > 0}<div class="ml-[60px]" style="height: 0.5px; background: var(--hairline);"></div>{/if}
              <div class="px-[16px] py-[10px]">
                <div class="flex items-center gap-3">
                  <div class="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full bg-warning/15 text-[17px] font-medium text-warning overflow-hidden">
                    {initial(null, inv.email)}
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-[16px] font-medium text-content">{inv.email}</div>
                    <div class="flex items-center gap-2 mt-0.5">
                      <span class="text-[13px] text-content-muted capitalize">{inv.role}</span>
                      {#if inv.createdByName}
                        <span class="truncate text-[13px] text-content-muted">by {inv.createdByName}</span>
                      {/if}
                    </div>
                  </div>
                  <span class={cn("shrink-0 rounded-full px-2 py-0.5 text-[12px] font-medium", expiryBadgeClass(inv.expiresAt))}>
                    {expiryLabel(inv.expiresAt)}
                  </span>
                </div>
                <!-- Action row: full-width tap targets -->
                <div class="mt-2 flex items-center gap-2 pl-[56px]">
                  <button
                    type="button"
                    onclick={() => handleCopyLink(inv.id)}
                    class="pressable h-[36px] rounded-[8px] border border-edge px-3 text-[13px] text-content-muted focus-ring"
                  >
                    Copy link
                  </button>
                  <button
                    type="button"
                    onclick={() => handleResend(inv.id)}
                    disabled={resendingId === inv.id}
                    class="pressable h-[36px] rounded-[8px] border border-edge px-3 text-[13px] text-content-muted disabled:opacity-50 focus-ring"
                  >
                    {resendingId === inv.id ? "Sending…" : "Resend"}
                  </button>
                  <button
                    type="button"
                    onclick={() => handleCancel(inv.id)}
                    disabled={cancelingId === inv.id}
                    class="pressable h-[36px] rounded-[8px] border border-error/40 px-3 text-[13px] text-error disabled:opacity-50 focus-ring"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            {:else}
              <div class="px-[16px] py-[24px] text-center text-[14px] text-content-muted">
                No invitations expiring within 24 hours.
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <p class="px-[4px] text-[13px] text-content-muted">
      Roles control workspace permissions. Agent access is managed per daemon in
      <a href="daemon" class="text-accent">Daemons</a>.
    </p>

  </div>
{:else}
  <!-- ── Desktop: original layout (byte-equal) ── -->
  <div class="mx-auto max-w-2xl px-6 py-8 space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-lg font-bold text-content">
          Members
          <span class="ml-2 text-sm font-normal text-content-muted">{members.length}</span>
          {#if invitations.length > 0}
            <span class="ml-2 inline-flex items-center rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning">
              {invitations.length} pending
            </span>
          {/if}
        </h2>
        <p class="text-sm text-content-muted mt-0.5">
          Roles control workspace permissions. Agent access is managed per daemon in
          <a href="daemon" class="text-link hover:underline">Daemons</a>.
        </p>
      </div>
      <div class="flex items-center gap-3">
        {#if membersMsg}
          <span class={cn("text-[13px]", membersMsg.includes("Failed") ? "text-error" : "text-online")}>
            {membersMsg}
          </span>
        {/if}
        {#if canManage}
          <button
            onclick={() => (inviteOpen = true)}
            class="rounded-md bg-btn-primary-bg px-3 py-1.5 text-sm font-medium text-btn-primary-text hover:bg-btn-primary-hover transition-colors"
          >
            Invite
          </button>
        {/if}
      </div>
    </div>

    <!-- Inline invite-from-email (additive to the modal). -->
    {#if canManage}
      <div class="rounded-lg border border-edge bg-surface-alt/40 px-4 py-3 space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-[13px] font-semibold text-content">Invite by email</span>
          <button
            type="button"
            onclick={() => (inviteOpen = true)}
            class="text-[12px] text-content-muted hover:text-content hover:underline transition-colors"
          >
            More options
          </button>
        </div>
        <form
          onsubmit={(e) => { e.preventDefault(); handleInlineInvite(); }}
          class="flex flex-col gap-2 sm:flex-row sm:items-center"
        >
          <input
            bind:value={inlineEmail}
            type="email"
            placeholder="colleague@example.com"
            class="flex-1 rounded-md border border-edge bg-surface px-3 py-2 text-sm text-content outline-none placeholder:text-content-muted focus:border-btn-primary-bg"
          />
          <select
            bind:value={inlineRole}
            class="rounded-md border border-edge bg-surface px-2 py-2 text-sm text-content outline-none"
            aria-label="Invite role"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
            <option value="viewer">Viewer</option>
          </select>
          <button
            type="submit"
            disabled={inlineSending || !inlineEmail.trim()}
            class="shrink-0 rounded-md bg-btn-primary-bg px-4 py-2 text-sm font-medium text-btn-primary-text hover:bg-btn-primary-hover disabled:opacity-40 transition-colors"
          >
            {inlineSending ? "Sending..." : "Send"}
          </button>
        </form>
        {#if inlineError}
          <p class="text-[12px] text-error">{inlineError}</p>
        {:else if inlineSentEmail}
          <p class="text-[12px] text-online">{"✓"} Invitation sent to {inlineSentEmail}</p>
        {/if}
      </div>
    {/if}

    <div class="rounded-lg border border-edge divide-y divide-edge">
      {#each members as member (member.userId)}
        <div>
          <div class="flex items-center gap-3 px-4 py-3">
            <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-btn-primary-bg/20 text-sm font-medium text-btn-primary-bg overflow-hidden">
              {#if member.imageUrl}
                <img src={member.imageUrl} alt="" class="h-full w-full object-cover" />
              {:else}
                {initial(member.name, member.email)}
              {/if}
            </div>

            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-content truncate">
                {member.name ?? member.email}
              </div>
              {#if member.name}
                <div class="text-xs text-content-muted truncate">{member.email}</div>
              {/if}
            </div>

            {#if canChangeRoles && member.role !== "owner"}
              <select
                value={member.role}
                onchange={(e) => handleRoleChange(member.userId, (e.target as HTMLSelectElement).value)}
                class="rounded-md border border-edge bg-surface px-2 py-1 text-xs text-content outline-none"
              >
                <option value="admin">Admin</option>
                <option value="member">Member</option>
                <option value="viewer">Viewer</option>
              </select>
            {:else}
              <span class={cn("rounded-full px-2 py-0.5 text-xs font-medium", roleBadgeClass(member.role))}>
                {member.role}
              </span>
            {/if}

            {#if canManage && member.role !== "owner"}
              <button
                onclick={() => (removingId = removingId === member.userId ? null : member.userId)}
                class="rounded p-1 text-content-muted hover:text-error hover:bg-error/10 transition-colors"
                title="Remove member"
              >
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            {/if}
          </div>

          {#if removingId === member.userId}
            <div class="flex items-center gap-3 border-t border-edge/50 bg-error/5 px-4 pb-3 pt-2.5">
              <span class="flex-1 text-xs text-content-dim">
                Remove <strong class="text-content">{member.name ?? member.email}</strong> from workspace?
              </span>
              <button
                onclick={() => handleRemove(member.userId)}
                class="rounded-md bg-error px-3 py-1 text-xs font-medium text-accent-foreground hover:opacity-90 transition-opacity"
              >
                Remove
              </button>
              <button
                onclick={() => (removingId = null)}
                class="rounded-md border border-edge px-3 py-1 text-xs text-content-muted hover:text-content transition-colors"
              >
                Cancel
              </button>
            </div>
          {/if}
        </div>
      {:else}
        <div class="px-4 py-8 text-center text-sm text-content-muted">
          No members yet
        </div>
      {/each}
    </div>

    <!-- Pending Invitations -->
    {#if canManage && invitations.length > 0}
      <div class="space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onclick={() => (pendingCollapsed = !pendingCollapsed)}
            class="flex items-center gap-1.5 text-sm font-semibold text-content hover:text-content"
            aria-expanded={!pendingCollapsed}
          >
            <svg
              class={cn("h-3.5 w-3.5 text-content-muted transition-transform", !pendingCollapsed && "rotate-90")}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            Pending Invitations
            <span class="text-xs font-normal text-content-muted">{invitations.length}</span>
          </button>

          <div class="ml-auto flex items-center gap-2">
            <button
              type="button"
              onclick={() => (onlyExpiring = !onlyExpiring)}
              class={cn(
                "rounded-md border px-2.5 py-1 text-xs transition-colors",
                onlyExpiring
                  ? "border-error/40 bg-error/10 text-error"
                  : "border-edge text-content-muted hover:text-content hover:bg-surface-alt",
              )}
              aria-pressed={onlyExpiring}
              title="Show only invites expiring within 24 hours"
            >
              Expiring &lt;24h
            </button>
            {#if invitations.length > 1}
              <button
                type="button"
                onclick={handleResendAll}
                disabled={batchResending}
                class="rounded-md border border-edge px-2.5 py-1 text-xs text-content-muted hover:text-content hover:bg-surface-alt transition-colors disabled:opacity-50"
                title="Resend all pending invitations"
              >
                {batchResending ? "Resending..." : "Resend all"}
              </button>
            {/if}
          </div>
        </div>

        {#if !pendingCollapsed}
        <div class="rounded-lg border border-edge divide-y divide-edge">
          {#each visibleInvitations as inv (inv.id)}
            <div class="flex items-center gap-3 px-4 py-3">
              <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning/15 text-sm font-medium text-warning overflow-hidden">
                {initial(null, inv.email)}
              </div>

              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-content truncate">{inv.email}</div>
                <div class="flex items-center gap-2 mt-0.5">
                  <span class="text-xs text-content-muted capitalize">{inv.role}</span>
                  {#if inv.createdByName}
                    <span class="text-xs text-content-dim truncate">invited by {inv.createdByName}</span>
                  {/if}
                </div>
              </div>

              <span class={cn("rounded-full px-2 py-0.5 text-xs font-medium", expiryBadgeClass(inv.expiresAt))}>
                {expiryLabel(inv.expiresAt)}
              </span>

              <button
                onclick={() => handleCopyLink(inv.id)}
                class="rounded px-2 py-1 text-xs text-content-muted hover:text-content hover:bg-surface-alt transition-colors"
                title="Copy invite link"
              >
                Copy link
              </button>

              <button
                onclick={() => handleResend(inv.id)}
                disabled={resendingId === inv.id}
                class="rounded px-2 py-1 text-xs text-content-muted hover:text-content hover:bg-surface-alt transition-colors disabled:opacity-50"
                title="Resend invitation"
              >
                {resendingId === inv.id ? "Sending..." : "Resend"}
              </button>

              <button
                onclick={() => handleCancel(inv.id)}
                disabled={cancelingId === inv.id}
                class="rounded p-1 text-content-muted hover:text-error hover:bg-error/10 transition-colors disabled:opacity-50"
                title="Cancel invitation"
              >
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          {:else}
            <div class="px-4 py-6 text-center text-xs text-content-muted">
              No invitations expiring within 24 hours.
            </div>
          {/each}
        </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<InviteMembersModal open={inviteOpen} onClose={handleInviteClose} />
