<script lang="ts">
  // Single channel-config dialog (Slack-style). One dialog, shadcn Tabs:
  // About · Members · Files · Settings · Integrations. The old second dialog
  // (ChannelEditForm) is gone — editing lives inline in the Settings tab
  // (ChannelSettingsForm), AI + webhooks in Integrations. The dialog stays a thin
  // router + the single source of truth for channel data, members and open state.
  import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog/index.js";
  import { Tabs, TabsList, TabsTrigger, TabsContent } from "$lib/components/ui/tabs/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
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
    authState,
    workspaceState,
    messageFocusState,
  } from "$lib/state/app.svelte.js";
  import { cyboState } from "$lib/plugins/agents/state.svelte.js";
  import { toast } from "svelte-sonner";
  import CyborgIcon from "$lib/components/CyborgIcon.svelte";
  import AddChannelMembersDialog from "./AddChannelMembersDialog.svelte";
  import EmptyState from "../EmptyState.svelte";
  import ChannelAboutArea from "./ChannelAboutArea.svelte";
  import ChannelSettingsForm from "./ChannelSettingsForm.svelte";
  import ChannelIntegrationsPanel from "./ChannelIntegrationsPanel.svelte";
  import ChannelAiPanel from "./ChannelAiPanel.svelte";
  import ChannelGlyph from "./ChannelGlyph.svelte";
  import Avatar from "$lib/components/Avatar.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import SharedFilesPanel from "$lib/components/SharedFilesPanel.svelte";
  import type { Channel, ChannelMember } from "$lib/core/types.js";

  type DetailsTab = "about" | "members" | "files" | "settings" | "integrations" | "ai";

  let {
    open = $bindable(false),
    channel,
    initialTab = "about",
    ondeleted,
  }: {
    open: boolean;
    channel: Channel;
    // Open straight to a tab — e.g. the sidebar "Edit channel" entry passes
    // "settings" so editing the name is one click (the Name field autofocuses).
    initialTab?: DetailsTab;
    ondeleted?: () => void;
  } = $props();

  let members = $state<ChannelMember[]>([]);
  let loading = $state(false);
  let showAddMembers = $state(false);
  let removing = $state<string | null>(null);
  // Cybo members (W3): ids only; details resolve from the workspace cybo roster.
  let cyboMemberIds = $state<string[]>([]);
  // Per-cybo in-flight flags so removing several quickly doesn't prematurely
  // re-enable an earlier one's button.
  let removingCybos = $state<Record<string, boolean>>({});
  const cyboMembers = $derived(cyboState.list.filter((c) => cyboMemberIds.includes(c.id)));
  let tab = $state<DetailsTab>("about");
  let fileCount = $state<number | null>(null);

  const myId = $derived(authState.user?.id);
  const wsRole = $derived(workspaceState.current?.role);
  const isWsAdmin = $derived(wsRole === "owner" || wsRole === "admin");
  let myChannelRole = $state<string | null>(null);
  const isChannelAdmin = $derived(myChannelRole === "admin" || isWsAdmin);

  // A mutation (save/archive/delete/leave) is in flight. Combined with member
  // load/remove into isBusy, used to block dialog dismissal mid-operation so an
  // accidental Esc / outside-click can't desync the focus trap or interrupt a write.
  let mutating = $state(false);
  const isBusy = $derived(
    loading || mutating || removing !== null || Object.keys(removingCybos).length > 0,
  );

  // Seed ONLY on the closed→open edge: `channel` is a $derived whose reference
  // changes on every mutation (incl. the user's own Save), so keying on it would
  // stomp the active tab mid-interaction.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      wasOpen = true;
      tab = initialTab;
      loadMembers();
      // Ensure the workspace cybo roster is loaded so cybo-members resolve and
      // the add-dialog can list cybos, even if Agents wasn't visited this session.
      void fetchCybos();
      loadRole();
      loadFileCount();
    } else if (!open && wasOpen) {
      wasOpen = false;
    }
  });

  async function loadMembers() {
    loading = true;
    try {
      members = await fetchChannelMembers(channel.id);
    } catch (err) {
      console.error("Failed to fetch channel members:", err);
    } finally {
      loading = false;
    }
    void loadCyboMembers();
  }

  // Cybo members load independently so a missing/older W3 endpoint just yields an
  // empty cybo list — the human-member section is unaffected.
  async function loadCyboMembers() {
    try {
      cyboMemberIds = await fetchChannelCybos(channel.id);
    } catch {
      cyboMemberIds = [];
    }
  }

  async function handleRemoveCybo(cyboId: string) {
    if (removingCybos[cyboId]) return;
    removingCybos[cyboId] = true;
    try {
      await removeChannelCybo(channel.id, cyboId);
      cyboMemberIds = cyboMemberIds.filter((id) => id !== cyboId);
    } catch (err) {
      console.error("Failed to remove cybo member:", err);
      const cybo = cyboState.list.find((c) => c.id === cyboId);
      toast.error(
        `Couldn't remove ${cybo ? cybo.name : "the cybo"} — check your connection and permissions.`,
      );
    } finally {
      delete removingCybos[cyboId];
    }
  }

  async function loadRole() {
    try {
      myChannelRole = await getChannelRole(channel.id);
    } catch (err) {
      console.error("Failed to fetch channel role:", err);
      myChannelRole = null;
    }
  }

  async function loadFileCount() {
    fileCount = null;
    try {
      fileCount = await getChannelFileCount(channel.id);
    } catch {
      fileCount = null; // badge just omits the number on failure
    }
  }

  // Confirm before removing a member — a destructive action that revokes their
  // access (item 3). Hold the pending member until the user confirms.
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
      await removeChannelMember(channel.id, member.userId);
      members = members.filter((m) => m.userId !== member.userId);
    } catch (err) {
      console.error("Failed to remove member:", err);
      toast.error(
        `Couldn't remove ${member.name ?? member.email} — check your connection and permissions.`,
      );
    } finally {
      removing = null;
    }
  }

  // Confirm before leaving — you'll stop receiving messages (item 3). The
  // ChannelSettingsForm's danger-zone "Leave" calls onleave (→ requestLeave),
  // which opens the confirm; the actual leave runs on confirm.
  let pendingLeave = $state(false);
  function requestLeave(): Promise<void> {
    pendingLeave = true;
    return Promise.resolve();
  }

  // The mutation handlers run inside ChannelSettingsForm's run()/save (which
  // surfaces thrown errors), so they intentionally DON'T swallow — they just
  // flip `mutating` for the dismissal guard and close on success.
  async function handleLeave() {
    pendingLeave = false;
    mutating = true;
    try {
      await leaveChannel(channel.id);
      open = false;
    } finally {
      mutating = false;
    }
  }

  async function handleSave(updates: {
    name: string;
    description: string | null;
    instructions: string | null;
    isPrivate: boolean;
  }) {
    mutating = true;
    try {
      await updateChannel(channel.id, updates);
    } finally {
      mutating = false;
    }
  }

  async function handleArchive(archived: boolean) {
    mutating = true;
    try {
      await archiveChannel(channel.id, archived);
      // Archiving drops the channel from the active sidebar list; close so the
      // user lands back in chat rather than a stale panel.
      open = false;
      if (archived) ondeleted?.();
    } finally {
      mutating = false;
    }
  }

  async function handleDelete() {
    mutating = true;
    try {
      await deleteChannel(channel.id);
      open = false;
      ondeleted?.();
    } finally {
      mutating = false;
    }
  }
</script>

<Dialog
  bind:open
  onOpenChange={(o) => {
    if (!o) open = false;
  }}
>
  <DialogContent
    class="max-h-[85dvh] min-w-0 overflow-x-hidden overflow-y-auto sm:max-w-[560px]"
    showCloseButton={true}
    escapeKeydownBehavior={isBusy ? "ignore" : "close"}
    interactOutsideBehavior={isBusy ? "ignore" : "close"}
  >
    <DialogHeader>
      <DialogTitle class="flex items-center gap-2">
        <ChannelGlyph
          kind={channel.isPrivate ? "private" : "public"}
          class={channel.isPrivate ? "w-4 h-4 text-content-muted" : "text-content-muted"}
        />
        {channel.name}
        {#if channel.isArchived}
          <Badge variant="archived">archived</Badge>
        {/if}
      </DialogTitle>
    </DialogHeader>

    <Tabs bind:value={tab} class="min-w-0">
      <TabsList class="w-full justify-start">
        <TabsTrigger value="about">About</TabsTrigger>
        <TabsTrigger value="members" class="gap-1">
          Members <span class="tabular-nums text-content-muted">{members.length + cyboMembers.length}</span>
        </TabsTrigger>
        <TabsTrigger value="files" class="gap-1">
          Files
          {#if fileCount !== null && fileCount > 0}
            <span class="tabular-nums text-content-muted">{fileCount}</span>
          {/if}
        </TabsTrigger>
        <!-- Integrations is visible to every member (read-only view of how this
             channel receives webhooks); only admins see the management controls.
             Settings is visible to every member too — admins get the full editor,
             members get just the "Leave channel" action — but only admins see AI. -->
        <TabsTrigger value="integrations">Integrations</TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
        {#if isChannelAdmin}
          <TabsTrigger value="ai">AI</TabsTrigger>
        {/if}
      </TabsList>

      <div class="min-w-0 py-2">
        <TabsContent value="about">
          <ChannelAboutArea {channel} />
        </TabsContent>

        <TabsContent value="members">
          {#if isChannelAdmin}
            <button
              type="button"
              onclick={() => (showAddMembers = true)}
              class="mb-3 flex w-full items-center gap-2 rounded-lg border border-dashed border-edge-light px-3 py-2.5 text-[13px] text-content-dim transition-colors hover:border-accent hover:bg-accent/10 hover:text-content"
            >
              <span
                class="flex h-7 w-7 items-center justify-center rounded-full bg-surface-hover text-base font-light"
                >+</span
              >
              Add members
            </button>
          {/if}
          <ScrollArea class="h-[280px]">
            {#if loading}
              <p class="py-4 text-center text-sm text-content-muted">Loading…</p>
            {:else if members.length === 0 && cyboMembers.length === 0}
              <EmptyState
                noIcon
                title="No members"
                class="py-4"
                titleClass="text-sm font-normal text-content-muted"
              />
            {:else}
              <div class="space-y-0.5">
                {#each members as member (member.userId)}
                  <div
                    class="group flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-surface-hover"
                  >
                    <Avatar
                      name={member.name ?? member.email}
                      image={authState.getMemberImage(member.userId)}
                      width={40}
                      fontSize={15}
                    />
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span class="truncate text-sm font-medium text-content"
                          >{member.name ?? member.email}</span
                        >
                        {#if member.userId === myId}
                          <Badge variant="you">you</Badge>
                        {/if}
                      </div>
                      <div class="text-xs capitalize text-content-dim">
                        {member.role ?? "member"}
                      </div>
                    </div>
                    {#if isChannelAdmin && member.userId !== myId}
                      <Button
                        variant="ghost"
                        size="sm"
                        class="h-6 px-2 text-xs text-content-muted opacity-0 transition-all hover:text-error group-hover:opacity-100"
                        onclick={() => requestRemoveMember(member)}
                        disabled={removing === member.userId}
                      >
                        Remove
                      </Button>
                    {/if}
                  </div>
                {/each}
                {#each cyboMembers as cybo (cybo.id)}
                  <div
                    class="group flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-surface-hover"
                  >
                    {#if cybo.avatar && !/^\p{Extended_Pictographic}/u.test(cybo.avatar)}
                      <Avatar name={cybo.name} image={cybo.avatar} width={40} fontSize={15} />
                    {:else}
                      <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-alt">
                        {#if cybo.avatar}{cybo.avatar}{:else}<CyborgIcon size={20} />{/if}
                      </span>
                    {/if}
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span class="truncate text-sm font-medium text-content">{cybo.name}</span>
                        <span
                          class="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent"
                          >cybo</span
                        >
                      </div>
                      <div class="text-xs text-content-dim">{cybo.role ?? cybo.provider}</div>
                    </div>
                    {#if isChannelAdmin}
                      <Button
                        variant="ghost"
                        size="sm"
                        class="h-6 px-2 text-xs text-content-muted opacity-0 transition-all hover:text-error group-hover:opacity-100"
                        onclick={() => handleRemoveCybo(cybo.id)}
                        disabled={removingCybos[cybo.id]}
                      >
                        Remove
                      </Button>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </ScrollArea>
        </TabsContent>

        <TabsContent value="files">
          <ScrollArea class="-mx-4 h-[280px]">
            <SharedFilesPanel
              source={{ kind: "channel", channelId: channel.id }}
              onJump={(messageId) => {
                messageFocusState.focus(messageId);
                open = false;
              }}
            />
          </ScrollArea>
        </TabsContent>

        <TabsContent value="integrations">
          <ChannelIntegrationsPanel {channel} isAdmin={isChannelAdmin} />
        </TabsContent>

        <!-- Settings is shown to everyone. ChannelSettingsForm gates every admin
             control (name/privacy/save, archive, delete) behind canAdmin, while
             the "Leave channel" danger-zone item renders for all roles — so a
             non-admin member sees ONLY the Leave action here. -->
        <TabsContent value="settings">
          <ChannelSettingsForm
            {channel}
            canAdmin={isChannelAdmin}
            autofocusName={initialTab === "settings"}
            onsave={handleSave}
            onarchive={handleArchive}
            ondelete={handleDelete}
            onleave={requestLeave}
          />
        </TabsContent>

        {#if isChannelAdmin}
          <TabsContent value="ai">
            <ChannelAiPanel {channel} />
          </TabsContent>
        {/if}
      </div>
    </Tabs>
  </DialogContent>
</Dialog>

<AddChannelMembersDialog
  bind:open={showAddMembers}
  channelId={channel.id}
  existingMembers={members}
  existingCyboIds={cyboMemberIds}
  onmemberadded={loadMembers}
  oncyboadded={loadCyboMembers}
/>

<!-- Item 3: confirm destructive member removal before it happens. -->
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

<!-- Item 3: confirm leaving the channel (you'll stop receiving messages). -->
<ConfirmDialog
  open={pendingLeave}
  title="Leave channel?"
  message={`You'll leave #${channel.name} and stop receiving its messages.${channel.isPrivate ? " Since it's private, you'll need a new invite to rejoin." : " You can rejoin anytime since it's public."}`}
  confirmLabel="Leave"
  destructive
  onconfirm={handleLeave}
  oncancel={() => (pendingLeave = false)}
/>
