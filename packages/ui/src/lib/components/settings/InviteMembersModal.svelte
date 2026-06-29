<script lang="ts">
  import { workspaceState, inviteMember } from "$lib/state/app.svelte.js";
  import { agentDisplayName } from "$lib/agent-display.js";
  import Avatar from "$lib/components/Avatar.svelte";

  let {
    open,
    onClose,
  }: {
    open: boolean;
    onClose: () => void;
  } = $props();

  type AccessLevel = "full" | "read_only";

  let email = $state("");
  let role = $state<"admin" | "member" | "viewer">("member");
  let sending = $state(false);
  let sent = $state(false);
  let sentEmail = $state("");
  let sentInviteUrl = $state("");
  let sentLinkCopied = $state(false);
  let error = $state("");
  // Per-agent access grant. The rewrite relay has no per-agent invite-permission
  // RPC yet (cyborg:invite_member takes only email + role), so these selections
  // are collected but NOT submitted to the backend. See the report's backend gap.
  let agentPermissions = $state<Record<string, AccessLevel>>({});

  let modalRef = $state<HTMLDivElement | null>(null);
  let emailEl = $state<HTMLInputElement | undefined>();

  const agents = $derived(workspaceState.agents as Array<{ agentId: string; cyboName?: string | null; cyboId?: string | null }>);

  function agentLabel(a: { agentId: string; cyboName?: string | null }): string {
    return agentDisplayName(a);
  }

  // Seed every agent to read-only when the list first loads.
  $effect(() => {
    if (agents.length > 0 && Object.keys(agentPermissions).length === 0) {
      const next: Record<string, AccessLevel> = {};
      for (const a of agents) next[a.agentId] = "read_only";
      agentPermissions = next;
    }
  });

  // Reset transient state whenever the modal closes.
  $effect(() => {
    if (!open) {
      sent = false;
      sentEmail = "";
      sentInviteUrl = "";
      sentLinkCopied = false;
      error = "";
      email = "";
      role = "member";
      agentPermissions = {};
    }
  });

  // Autofocus the email input on open.
  $effect(() => {
    if (open && emailEl) emailEl.focus();
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }

  function handleBackdropMouseDown(e: MouseEvent) {
    if (modalRef && !modalRef.contains(e.target as Node)) onClose();
  }

  function grantFullAccessToAll() {
    const next: Record<string, AccessLevel> = {};
    for (const a of agents) next[a.agentId] = "full";
    agentPermissions = next;
  }

  async function copyToClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const el = document.createElement("textarea");
        el.value = text;
        el.style.cssText = "position:fixed;opacity:0;pointer-events:none";
        document.body.appendChild(el);
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
        return true;
      } catch {
        return false;
      }
    }
  }

  async function handleSend() {
    if (!email.trim() || sending) return;
    const to = email.trim();
    sending = true;
    error = "";
    sent = false;
    sentEmail = "";
    sentInviteUrl = "";
    sentLinkCopied = false;
    try {
      const { inviteUrl } = await inviteMember(to, role);
      sent = true;
      sentEmail = to;
      // The relay returns the REAL shareable join link
      // (`${CYBORG_APP_URL}/invite/${token}`) — surface it directly.
      sentInviteUrl = inviteUrl;
      email = "";
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to send";
    } finally {
      sending = false;
    }
  }

  async function handleCopyLink() {
    if (await copyToClipboard(sentInviteUrl)) {
      sentLinkCopied = true;
      setTimeout(() => {
        sentLinkCopied = false;
      }, 2000);
    }
  }
</script>

<svelte:window onkeydown={open ? handleKeydown : undefined} />

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/60"
    onmousedown={handleBackdropMouseDown}
  >
    <div
      bind:this={modalRef}
      class="w-[440px] rounded-xl border border-edge shadow-2xl"
      style="background-color: var(--bg-surface);"
      role="dialog"
      aria-modal="true"
      aria-label="Invite members"
    >
      <!-- Header -->
      <div class="px-6 pt-5 pb-4">
        <div class="flex items-start justify-between">
          <div class="flex items-center gap-3">
            <div class="flex h-10 w-10 items-center justify-center rounded-lg" style="background-color: var(--bg-elevated);">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-secondary);">
                <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4-4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" />
              </svg>
            </div>
            <div>
              <h2 class="text-[17px] font-bold text-content">Invite Humans</h2>
              <p class="mt-0.5 text-[13px]" style="color: var(--text-muted);">Send an email invitation to join this workspace</p>
            </div>
          </div>
          <button
            type="button"
            onclick={onClose}
            class="mt-1 shrink-0 cursor-pointer rounded p-1 hover:bg-edge"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9b9c9e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      <div class="space-y-5 px-6 pb-6">
        <!-- Email + role + Send -->
        <div class="flex">
          <input
            bind:this={emailEl}
            bind:value={email}
            type="email"
            onkeydown={(e) => { if (e.key === "Enter") handleSend(); }}
            placeholder="colleague@example.com"
            class="flex-1 rounded-l-lg px-4 py-2.5 text-[14px] text-content outline-none placeholder:text-content-muted"
            style="background-color: var(--bg-base); border: 1px solid var(--border); border-right: none;"
          />
          <select
            bind:value={role}
            class="px-2 py-2.5 text-[14px] text-content outline-none"
            style="background-color: var(--bg-base); border: 1px solid var(--border); border-left: none; border-right: none;"
            aria-label="Invite role"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
            <option value="viewer">Viewer</option>
          </select>
          <button
            type="button"
            onclick={handleSend}
            disabled={sending || !email.trim()}
            class="shrink-0 cursor-pointer rounded-r-lg bg-btn-primary-bg px-5 py-2.5 text-[14px] font-semibold text-btn-primary-text hover:bg-btn-primary-hover disabled:opacity-40"
          >
            {sending ? "Sending..." : "Send"}
          </button>
        </div>

        <!-- Success message + copy invite link -->
        {#if sent}
          <div class="space-y-2">
            <p class="text-[13px] text-online">{"✓"} Invitation sent to {sentEmail}</p>
            {#if sentInviteUrl}
              <div class="space-y-1.5 rounded-lg px-3 py-2.5" style="background-color: var(--bg-base); border: 1px solid var(--border);">
                <p class="text-[12px]" style="color: var(--text-muted);">In case the email doesn't arrive, share this link:</p>
                <div class="flex items-center gap-2">
                  <p class="flex-1 select-all break-all font-mono text-[12px] text-content">{sentInviteUrl}</p>
                  <button
                    type="button"
                    onclick={handleCopyLink}
                    class="shrink-0 cursor-pointer rounded border border-edge px-2.5 py-1 text-[12px] text-content-muted hover:text-content hover:bg-surface-alt transition-colors"
                  >
                    {sentLinkCopied ? "✓ Copied" : "Copy"}
                  </button>
                </div>
              </div>
            {/if}
          </div>
        {/if}
        {#if error}
          <p class="text-[13px] text-error">{error}</p>
        {/if}

        <!-- Agent Access -->
        {#if agents.length > 0}
          <div>
            <div class="mb-3 flex items-center justify-between">
              <span class="text-[13px] font-semibold" style="color: var(--text-secondary);">Agent Access</span>
              <button
                type="button"
                onclick={grantFullAccessToAll}
                class="cursor-pointer text-[12px] hover:underline"
                style="color: var(--text-muted);"
              >
                Grant full access to all
              </button>
            </div>
            <div class="max-h-[252px] overflow-y-auto overflow-hidden rounded-lg" style="border: 1px solid var(--border);">
              {#each agents as agent, i (agent.agentId ?? i)}
                <div
                  class="flex items-center justify-between px-3 py-2.5"
                  style={i < agents.length - 1 ? "border-bottom: 1px solid var(--border);" : ""}
                >
                  <div class="mr-3 flex min-w-0 items-center gap-2.5">
                    <Avatar name={agentLabel(agent)} width={24} fontSize={10} />
                    <span class="truncate text-[13px] text-content">{agentLabel(agent)}</span>
                  </div>
                  <select
                    value={agentPermissions[agent.agentId] ?? "read_only"}
                    onchange={(e) => { agentPermissions = { ...agentPermissions, [agent.agentId]: (e.currentTarget as HTMLSelectElement).value as AccessLevel }; }}
                    class="cursor-pointer rounded-md px-2.5 py-1 text-[12px] text-content outline-none"
                    style="background-color: var(--bg-base); border: 1px solid var(--border);"
                  >
                    <option value="full">Full Access</option>
                    <option value="read_only">Read Only</option>
                  </select>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
