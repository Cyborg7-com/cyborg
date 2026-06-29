<script lang="ts">
  // P5 (S5): mobile CHANNEL DETAILS — a pushed full-screen page replacing the
  // 560px ChannelDetailsDialog on phones (it overflowed and gave non-admins no
  // way to leave). Benchmark: WhatsApp/Telegram contact info + iOS Settings
  // grouped inset lists, all on --bg-base.
  //
  // STRUCTURE (root): back chevron row (44pt, pops to the conversation via the
  // same computeBackTarget the edge-swipe uses) → centered identity block →
  // grouped cards: [Members · Files · Pinned messages · Channel info],
  // [Edit channel · Integrations · AI] (admin), [Leave · Archive · Delete]
  // (danger; Leave for EVERY member — the dialog only exposed it inside the
  // admin-gated Settings tab).
  //
  // SUB-VIEWS are local state (`subView`), rendered as an absolutely-positioned
  // opaque layer over the root with a slide/fade `fly` — the simplest robust
  // stacked-page mechanism: the root stays mounted (counts/scroll preserved),
  // no extra routes, nothing for the swipe-back map to special-case. NOTE: the
  // hardware edge-swipe always pops the ROUTE (details → conversation) even
  // while a sub-view is open; the sub-view's own back chevron unwinds locally.
  //
  // CAPABILITY PARITY with ChannelDetailsDialog (feature loss = rejection):
  // members + cybo members load/add/remove (same confirms), shared files
  // (preview/download/jump via ChannelFilesList), About content (description/
  // instructions/created/ID — "Channel info" sub-view reusing ChannelAboutArea),
  // ChannelSettingsForm (incl. its inline danger zone), ChannelIntegrationsPanel,
  // ChannelAiPanel, archive/delete/leave with the dialog's confirm copy, and the
  // same admin gating (channel role ∪ workspace owner/admin).
  import { untrack } from "svelte";
  import { fly } from "svelte/transition";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import {
    fetchChannelMembers,
    removeChannelMember,
    fetchChannelCybos,
    removeChannelCybo,
    fetchCybos,
    leaveChannel,
    updateChannel,
    deleteChannel,
    archiveChannel,
    getChannelRole,
    getChannelFileCount,
    selectChannel,
    authState,
    workspaceState,
    channelState,
    messageFocusState,
  } from "$lib/state/app.svelte.js";
  import { cyboState } from "$lib/plugins/agents/state.svelte.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import { goBackFromConversation } from "$lib/mobile/swipeBack";
  import Avatar from "$lib/components/Avatar.svelte";
  import CyborgIcon from "$lib/components/CyborgIcon.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import ChannelGlyph from "$lib/components/channel/ChannelGlyph.svelte";
  import ChannelAboutArea from "$lib/components/channel/ChannelAboutArea.svelte";
  import ChannelSettingsForm from "$lib/components/channel/ChannelSettingsForm.svelte";
  import ChannelIntegrationsPanel from "$lib/components/channel/ChannelIntegrationsPanel.svelte";
  import ChannelAiPanel from "$lib/components/channel/ChannelAiPanel.svelte";
  import AddChannelMembersDialog from "$lib/components/channel/AddChannelMembersDialog.svelte";
  import ChatMessage from "$lib/components/message/ChatMessage.svelte";
  import ChannelFilesList from "./ChannelFilesList.svelte";
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
  } from "$lib/components/ui/dropdown-menu/index.js";
  import type { ChannelMember } from "$lib/core/types.js";

  // params are typed string | undefined; on this route they always exist —
  // the ?? "" just narrows the type (the seed effect skips an empty id).
  const wsId = $derived(page.params.id ?? "");
  const channelId = $derived(page.params.channelId ?? "");
  const channelRoute = $derived(`/workspace/${wsId}/channel/${channelId}`);
  const chatsRoute = $derived(`/workspace/${wsId}/chats`);
  const channel = $derived(workspaceState.channels.find((c) => c.id === channelId) ?? null);

  // Mobile-only route: desktop keeps the dialog. replaceState so the desktop
  // back button doesn't bounce through the redirect.
  $effect(() => {
    if (!viewportState.isMobile) void goto(channelRoute, { replaceState: true });
  });

  // ── Channel data (mirrors ChannelDetailsDialog's open-edge seeding) ──────
  let members = $state<ChannelMember[]>([]);
  let membersLoading = $state(false);
  let membersLoaded = $state(false);
  let showAddMembers = $state(false);
  let removing = $state<string | null>(null);
  // Cybo members (W3): ids only; details resolve from the workspace roster.
  let cyboMemberIds = $state<string[]>([]);
  let removingCybos = $state<Record<string, boolean>>({});
  const cyboMembers = $derived(cyboState.list.filter((c) => cyboMemberIds.includes(c.id)));
  let fileCount = $state<number | null>(null);
  let myChannelRole = $state<string | null>(null);

  const myId = $derived(authState.user?.id);
  const wsRole = $derived(workspaceState.current?.role);
  const isWsAdmin = $derived(wsRole === "owner" || wsRole === "admin");
  const isChannelAdmin = $derived(myChannelRole === "admin" || isWsAdmin);
  const memberCount = $derived(membersLoaded ? members.length + cyboMembers.length : null);

  // Pinned messages derive from the live channel window (same source as
  // PinnedPanel — pins among the LOADED messages), valid only while this
  // channel is the active one; the load effect below guarantees that.
  const pinned = $derived(
    channelState.activeId === channelId
      ? channelState.messages
          .filter((m) => m.pinnedAt)
          .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0))
      : [],
  );

  // Seed once per workspace+channel (guard key — workspaceState.current is
  // needed by every loader, and on a deep-link it arrives async).
  let seededKey: string | null = null;
  $effect(() => {
    const ws = workspaceState.current;
    const id = channelId;
    if (!ws || !id) return;
    const key = `${ws.id}/${id}`;
    if (key === seededKey) return;
    seededKey = key;
    untrack(() => {
      subView = "none";
      void loadMembers(id);
      // Workspace cybo roster so cybo-members resolve and the add-dialog can
      // list cybos even if Agents wasn't visited this session.
      void fetchCybos();
      void loadRole(id);
      void loadFileCount(id);
      // Deep-link/reload: make this channel the active conversation so the
      // pinned list has data. No-op cost when arriving from the conversation
      // (activeId already matches).
      if (channelState.activeId !== id) void selectChannel(id);
    });
  });

  async function loadMembers(id: string) {
    membersLoading = true;
    try {
      members = await fetchChannelMembers(id);
    } catch (err) {
      console.error("Failed to fetch channel members:", err);
    } finally {
      membersLoading = false;
      membersLoaded = true;
    }
    void loadCyboMembers(id);
  }

  // Cybo members load independently so a missing/older W3 endpoint just yields
  // an empty cybo list — the human-member section is unaffected.
  async function loadCyboMembers(id: string) {
    try {
      cyboMemberIds = await fetchChannelCybos(id);
    } catch {
      cyboMemberIds = [];
    }
  }

  async function loadRole(id: string) {
    try {
      myChannelRole = await getChannelRole(id);
    } catch (err) {
      console.error("Failed to fetch channel role:", err);
      myChannelRole = null;
    }
  }

  async function loadFileCount(id: string) {
    fileCount = null;
    try {
      fileCount = await getChannelFileCount(id);
    } catch {
      fileCount = null; // the cell just omits the number on failure
    }
  }

  async function handleRemoveCybo(cyboId: string) {
    if (removingCybos[cyboId]) return;
    removingCybos[cyboId] = true;
    try {
      await removeChannelCybo(channelId, cyboId);
      cyboMemberIds = cyboMemberIds.filter((id) => id !== cyboId);
    } catch (err) {
      console.error("Failed to remove cybo member:", err);
    } finally {
      delete removingCybos[cyboId];
    }
  }

  // Confirm before removing a member — same flow + copy as the dialog.
  let pendingRemove = $state<ChannelMember | null>(null);
  function requestRemoveMember(member: ChannelMember) {
    pendingRemove = member;
  }
  async function confirmRemoveMember() {
    const member = pendingRemove;
    pendingRemove = null;
    if (!member) return;
    removing = member.userId;
    try {
      await removeChannelMember(channelId, member.userId);
      members = members.filter((m) => m.userId !== member.userId);
    } catch (err) {
      console.error("Failed to remove member:", err);
    } finally {
      removing = null;
    }
  }

  // ── Danger actions (leave for EVERYONE; archive/delete admin-only) ──────
  let mutating = $state(false);
  let actionError = $state<string | null>(null);
  let pendingLeave = $state(false);
  let pendingArchive = $state(false);
  let pendingDelete = $state(false);

  // ChannelSettingsForm's danger-zone "Leave" calls onleave → this, exactly
  // like the dialog: open the confirm, leave runs on confirm.
  function requestLeave(): Promise<void> {
    pendingLeave = true;
    return Promise.resolve();
  }

  // Root-card confirms surface failures in the page banner (the ConfirmDialog
  // has no error slot). Form-driven mutations (handleSave/handleArchive/
  // handleDelete passed to ChannelSettingsForm) deliberately DON'T swallow —
  // the form's own run()/save shows them in its banner, like the dialog.
  async function runDanger(fn: () => Promise<void>): Promise<void> {
    mutating = true;
    actionError = null;
    try {
      await fn();
    } catch (err) {
      actionError = err instanceof Error ? err.message : "Action failed. Please try again.";
    } finally {
      mutating = false;
    }
  }

  async function handleLeave() {
    pendingLeave = false;
    await runDanger(async () => {
      await leaveChannel(channelId);
      // Leaving drops the channel from the sidebar — land on the Chats list.
      void goto(chatsRoute);
    });
  }

  async function confirmArchive() {
    pendingArchive = false;
    const archived = !channel?.isArchived;
    await runDanger(() => handleArchive(archived));
  }

  async function confirmDelete() {
    pendingDelete = false;
    await runDanger(() => handleDelete());
  }

  // Shared with ChannelSettingsForm (thrown errors propagate to its banner).
  async function handleSave(updates: {
    name: string;
    description: string | null;
    instructions: string | null;
    isPrivate: boolean;
  }) {
    await updateChannel(channelId, updates);
  }

  async function handleArchive(archived: boolean) {
    await archiveChannel(channelId, archived);
    // Archiving drops the channel from the active list — back to Chats.
    // Unarchiving keeps you here (the channel re-enters the list).
    if (archived) void goto(chatsRoute);
  }

  async function handleDelete() {
    await deleteChannel(channelId);
    void goto(chatsRoute);
  }

  // ── Sub-views (stacked over the root list, local state) ─────────────────
  type SubView = "none" | "members" | "files" | "pinned" | "about" | "edit" | "integrations" | "ai";
  let subView = $state<SubView>("none");
  const SUB_TITLES: Record<Exclude<SubView, "none">, string> = {
    members: "Members",
    files: "Files",
    pinned: "Pinned messages",
    about: "Channel info",
    edit: "Edit channel",
    integrations: "Integrations",
    ai: "AI",
  };

  // Shared-file "jump to message": focus survives navigation (module
  // singleton) and MessageList retries until the message renders.
  function jumpToMessage(messageId: string) {
    messageFocusState.focus(messageId);
    void goto(channelRoute);
  }
</script>

<div class="relative flex h-full flex-col overflow-hidden bg-surface">
  {#if !channel}
    <!-- Channel missing from the active list (not a member / archived deep
         link / still loading). Quiet fallback with a way out. -->
    <div class="flex h-[44px] shrink-0 items-center px-1">
      <button
        type="button"
        onclick={() => goto(chatsRoute)}
        class="pressable flex h-[44px] w-[44px] items-center justify-center rounded-[12px] text-content-dim focus-ring"
        aria-label="Back"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
      </button>
    </div>
    <div class="flex flex-1 items-center justify-center px-6">
      <p class="text-center text-[15px] text-content-muted">This channel isn't available.</p>
    </div>
  {:else}
    <!-- ── Root: back row + identity + grouped inset cards ── -->
    <div class="flex h-[44px] shrink-0 items-center px-1">
      <button
        type="button"
        onclick={goBackFromConversation}
        class="pressable flex h-[44px] w-[44px] items-center justify-center rounded-[12px] text-content-dim focus-ring"
        aria-label={`Back to #${channel.name}`}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
      </button>
    </div>

    <div class="flex-1 overflow-y-auto pb-8">
      <!-- Identity block -->
      <div class="flex flex-col items-center px-6 pb-6 pt-2 text-center">
        <div class="flex h-[64px] w-[64px] items-center justify-center rounded-[16px] bg-surface-alt">
          {#if channel.isPrivate}
            <ChannelGlyph kind="private" class="h-[28px] w-[28px] text-content-dim" />
          {:else}
            <ChannelGlyph kind="public" class="text-[28px] font-semibold leading-none text-content-dim" />
          {/if}
        </div>
        <h1 class="mt-3 max-w-full truncate text-[22px] font-bold text-content">{channel.name}</h1>
        {#if channel.isArchived}
          <span class="mt-1 rounded-full bg-content/15 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-content-dim">
            archived
          </span>
        {/if}
        {#if channel.description}
          <p class="mt-1 text-[15px] text-content-dim">{channel.description}</p>
        {/if}
        {#if memberCount !== null}
          <p class="mt-1 text-[13px] text-content-muted">
            {memberCount} member{memberCount === 1 ? "" : "s"}
          </p>
        {/if}
      </div>

      {#if actionError}
        <div class="mx-4 mb-4 rounded-[14px] bg-error/10 px-[16px] py-3 text-[13px] text-error">
          {actionError}
        </div>
      {/if}

      <div class="space-y-5 px-4">
        <!-- Card 1: content -->
        <div class="overflow-hidden rounded-[14px] bg-surface-alt">
          {@render navCell("Members", memberCount, () => (subView = "members"))}
          {@render hairline()}
          {@render navCell("Files", fileCount, () => (subView = "files"))}
          {@render hairline()}
          {@render navCell("Pinned messages", null, () => (subView = "pinned"))}
          {@render hairline()}
          {@render navCell("Channel info", null, () => (subView = "about"))}
        </div>

        <!-- Card 2: admin management -->
        {#if isChannelAdmin}
          <div class="overflow-hidden rounded-[14px] bg-surface-alt">
            {@render navCell("Edit channel", null, () => (subView = "edit"))}
            {@render hairline()}
            {@render navCell("Integrations", null, () => (subView = "integrations"))}
            {@render hairline()}
            {@render navCell("AI", null, () => (subView = "ai"))}
          </div>
        {/if}

        <!-- Card 3: danger. Leave is available to EVERY member. -->
        <div class="overflow-hidden rounded-[14px] bg-surface-alt">
          {@render dangerCell("Leave channel", () => (pendingLeave = true))}
          {#if isChannelAdmin}
            {@render hairline()}
            {@render dangerCell(channel.isArchived ? "Unarchive channel" : "Archive channel", () => (pendingArchive = true))}
            {@render hairline()}
            {@render dangerCell("Delete channel", () => (pendingDelete = true))}
          {/if}
        </div>
      </div>
    </div>

    <!-- ── Stacked sub-view: opaque layer over the root (root stays mounted) ── -->
    {#if subView !== "none"}
      <div
        class="absolute inset-0 z-10 flex flex-col bg-surface"
        transition:fly={{ x: 48, duration: 220, opacity: 0 }}
      >
        <div class="flex h-[44px] shrink-0 items-center gap-1 px-1">
          <button
            type="button"
            onclick={() => (subView = "none")}
            class="pressable flex h-[44px] w-[44px] items-center justify-center rounded-[12px] text-content-dim focus-ring"
            aria-label="Back to channel details"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
          </button>
          <span class="truncate text-[16px] font-semibold text-content">
            {SUB_TITLES[subView]}
          </span>
        </div>

        <div class="flex-1 overflow-y-auto pb-8">
          {#if subView === "members"}
            <div class="px-4 pt-2">
              <div class="overflow-hidden rounded-[14px] bg-surface-alt">
                {#if isChannelAdmin}
                  <button
                    type="button"
                    onclick={() => (showAddMembers = true)}
                    class="pressable-row flex min-h-[52px] w-full items-center gap-3 px-[16px] text-left focus-ring"
                  >
                    <span class="flex h-[32px] w-[32px] items-center justify-center rounded-full bg-accent/15 text-accent">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                    </span>
                    <span class="text-[16px] text-accent">Add members</span>
                  </button>
                {/if}
                {#if membersLoading}
                  {#if isChannelAdmin}{@render hairline()}{/if}
                  <p class="px-[16px] py-6 text-center text-[15px] text-content-muted">Loading…</p>
                {:else if members.length === 0 && cyboMembers.length === 0}
                  {#if isChannelAdmin}{@render hairline()}{/if}
                  <p class="px-[16px] py-6 text-center text-[15px] text-content-muted">No members</p>
                {:else}
                  {#each members as member, i (member.userId)}
                    {#if i > 0 || isChannelAdmin}{@render hairline()}{/if}
                    <div class="flex min-h-[52px] items-center gap-3 px-[16px] py-[6px]">
                      <Avatar
                        name={member.name ?? member.email}
                        image={authState.getMemberImage(member.userId)}
                        width={44}
                        fontSize={16}
                      />
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2">
                          <span class="truncate text-[16px] text-content">{member.name ?? member.email}</span>
                          {#if member.userId === myId}
                            <span class="rounded-full bg-content/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-content">you</span>
                          {/if}
                        </div>
                        <div class="text-[13px] capitalize text-content-muted">{member.role ?? "member"}</div>
                      </div>
                      {#if isChannelAdmin && member.userId !== myId}
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            class="pressable flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-[12px] text-content-dim focus-ring"
                            aria-label={`Actions for ${member.name ?? member.email}`}
                            disabled={removing === member.userId}
                          >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" sideOffset={2}>
                            <DropdownMenuItem
                              variant="destructive"
                              onclick={() => requestRemoveMember(member)}
                            >
                              Remove from channel
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      {/if}
                    </div>
                  {/each}
                  {#each cyboMembers as cybo, i (cybo.id)}
                    {#if i > 0 || members.length > 0 || isChannelAdmin}{@render hairline()}{/if}
                    <div class="flex min-h-[52px] items-center gap-3 px-[16px] py-[6px]">
                      {#if cybo.avatar && !/^\p{Extended_Pictographic}/u.test(cybo.avatar)}
                        <Avatar name={cybo.name} image={cybo.avatar} width={44} fontSize={16} />
                      {:else}
                        <span class="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full bg-surface-alt text-[20px]">
                          {#if cybo.avatar}{cybo.avatar}{:else}<CyborgIcon size={22} />{/if}
                        </span>
                      {/if}
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2">
                          <span class="truncate text-[16px] text-content">{cybo.name}</span>
                          <span class="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent">cybo</span>
                        </div>
                        <div class="truncate text-[13px] text-content-muted">{cybo.role ?? cybo.provider}</div>
                      </div>
                      {#if isChannelAdmin}
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            class="pressable flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-[12px] text-content-dim focus-ring"
                            aria-label={`Actions for ${cybo.name}`}
                            disabled={removingCybos[cybo.id]}
                          >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" sideOffset={2}>
                            <!-- Parity: cybo removal is direct (no confirm), like the dialog. -->
                            <DropdownMenuItem
                              variant="destructive"
                              onclick={() => handleRemoveCybo(cybo.id)}
                            >
                              Remove from channel
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      {/if}
                    </div>
                  {/each}
                {/if}
              </div>
            </div>
          {:else if subView === "files"}
            <ChannelFilesList {channelId} onJump={jumpToMessage} />
          {:else if subView === "pinned"}
            {#if pinned.length === 0}
              <p class="px-6 py-16 text-center text-[15px] text-content-muted">No pinned messages yet</p>
            {:else}
              <div class="py-1">
                {#each pinned as msg (msg.id)}
                  <ChatMessage message={msg} hideThread showHoverToolbar={false} timestampMode="always" />
                {/each}
              </div>
            {/if}
          {:else if subView === "about"}
            <div class="px-4 pb-8 pt-2">
              <ChannelAboutArea {channel} />
            </div>
          {:else if subView === "edit"}
            <div class="px-4 pb-8 pt-2">
              <ChannelSettingsForm
                {channel}
                canAdmin={isChannelAdmin}
                onsave={handleSave}
                onarchive={handleArchive}
                ondelete={handleDelete}
                onleave={requestLeave}
              />
            </div>
          {:else if subView === "integrations"}
            <div class="px-4 pb-8 pt-2">
              <ChannelIntegrationsPanel {channel} />
            </div>
          {:else if subView === "ai"}
            <div class="px-4 pb-8 pt-2">
              <ChannelAiPanel {channel} />
            </div>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</div>

{#snippet hairline()}
  <!-- Separator ONLY between cells inside a grouped card, inset 16px (iOS). -->
  <div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>
{/snippet}

{#snippet navCell(label: string, count: number | null, open: () => void)}
  <button
    type="button"
    onclick={open}
    class="pressable-row flex h-[48px] w-full items-center gap-3 px-[16px] text-left focus-ring"
  >
    <span class="min-w-0 flex-1 truncate text-[16px] text-content">{label}</span>
    {#if count !== null}
      <span class="shrink-0 text-[15px] tabular-nums text-content-muted">{count}</span>
    {/if}
    <svg class="shrink-0 text-content-muted" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
  </button>
{/snippet}

{#snippet dangerCell(label: string, act: () => void)}
  <button
    type="button"
    onclick={act}
    disabled={mutating}
    class="pressable-row flex h-[48px] w-full items-center px-[16px] text-left focus-ring disabled:opacity-50"
  >
    <span class="min-w-0 flex-1 truncate text-[16px] text-error">{label}</span>
  </button>
{/snippet}

{#if channel}
  <AddChannelMembersDialog
    bind:open={showAddMembers}
    channelId={channel.id}
    existingMembers={members}
    existingCyboIds={cyboMemberIds}
    onmemberadded={() => void loadMembers(channelId)}
    oncyboadded={() => void loadCyboMembers(channelId)}
  />

  <!-- Same confirm copy as ChannelDetailsDialog. -->
  <ConfirmDialog
    open={pendingRemove !== null}
    title="Remove member?"
    message={pendingRemove
      ? `${pendingRemove.name ?? pendingRemove.email} will be removed from #${channel.name}.${channel.isPrivate ? " They'll need a new invite to rejoin this private channel." : " They can rejoin since it's public."}`
      : ""}
    confirmLabel="Remove"
    destructive
    onconfirm={confirmRemoveMember}
    oncancel={() => (pendingRemove = null)}
  />

  <ConfirmDialog
    open={pendingLeave}
    title="Leave channel?"
    message={`You'll leave #${channel.name} and stop receiving its messages.${channel.isPrivate ? " Since it's private, you'll need a new invite to rejoin." : " You can rejoin anytime since it's public."}`}
    confirmLabel="Leave"
    destructive
    onconfirm={handleLeave}
    oncancel={() => (pendingLeave = false)}
  />

  <!-- Same decision copy as ChannelSettingsForm's inline archive/delete confirms. -->
  <ConfirmDialog
    open={pendingArchive}
    title={channel.isArchived ? "Unarchive channel?" : "Archive channel?"}
    message={channel.isArchived
      ? "Unarchive this channel? It returns to the active list."
      : "History is preserved and it can be unarchived later — the safe alternative to deleting."}
    confirmLabel={channel.isArchived ? "Unarchive" : "Archive"}
    destructive={!channel.isArchived}
    onconfirm={confirmArchive}
    oncancel={() => (pendingArchive = false)}
  />

  <ConfirmDialog
    open={pendingDelete}
    title="Delete channel?"
    message={`Delete #${channel.name}? This can't be undone. Consider archiving instead — it keeps the channel reachable in history.`}
    confirmLabel="Delete channel"
    destructive
    onconfirm={confirmDelete}
    oncancel={() => (pendingDelete = false)}
  />
{/if}
