<script lang="ts">
  import { untrack } from "svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { selectChannel, selectChannelPreview, listChannels, getLastChannel, authState, userStatusState, toggleReaction, editMessage, deleteMessage, closeThread, workspaceState, runCatchup } from "$lib/state/app.svelte.js";
  import ChannelHeader from "$lib/components/channel/ChannelHeader.svelte";
  import MessageList from "$lib/components/message/MessageList.svelte";
  import MessageInput from "$lib/components/message/MessageInput.svelte";
  import ChannelPreviewBanner from "$lib/components/channel/ChannelPreviewBanner.svelte";
  import ThreadPanel from "$lib/components/message/ThreadPanel.svelte";
  import CatchupSheet from "$lib/components/message/CatchupSheet.svelte";
  import PinnedPanel from "$lib/components/channel/PinnedPanel.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import ProfilePanel from "$lib/components/ProfilePanel.svelte";
  import { profilePanelState } from "$lib/profile-panel.svelte.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";

  let pinnedOpen = $state(false);
  // Live native composer height (iOS), bound from MessageInput and forwarded to
  // MessageList so the list re-pins to bottom when the native format bar expands
  // the composer (keyboard open). Floor 60 mirrors the native composer floor.
  let composerHeight = $state(60);
  // Confirm before deleting (Mattermost/Slack ask first — deletes are
  // irreversible from the UI). Hold the pending message id until confirmed.
  let pendingDeleteId = $state<string | null>(null);
  function requestDelete(messageId: string) {
    pendingDeleteId = messageId;
  }
  function confirmDelete() {
    if (pendingDeleteId) deleteMessage(pendingDeleteId);
    pendingDeleteId = null;
  }

  $effect(() => {
    const channelId = page.params.channelId;
    if (channelId) {
      // Depend ONLY on channelId. Without untrack, the effect transitively
      // tracks the reactive state selectChannel writes (activeId/messages/
      // unreadCursor/…) and re-fires several times per navigation — each re-run
      // re-froze the unread cursor after the prior run's mark-read advanced it,
      // so the "New messages" divider raced past the messages and never showed.
      untrack(() => {
        closeThread();
        pinnedOpen = false;
        profilePanelState.close();
        void openChannel(channelId);
      });
    }
  });

  // Branch joined vs preview. A member loads the channel normally (selectChannel,
  // with all the mark-read / cache side effects). A non-member reached via the
  // Browse "Preview" button (?preview=1) gets a read-only load (selectChannelPreview)
  // with NONE of those side effects. The modal seeds previewChannel before
  // navigating (warm path → repaint instantly); on a cold reload of a preview URL
  // we re-resolve the channel from listChannels and re-seed. If anything fails or
  // the channel turns out to be one we belong to, fall back to selectChannel.
  async function openChannel(channelId: string): Promise<void> {
    if (workspaceState.channels.some((c) => c.id === channelId)) {
      // Our channel list mirrors the server's memberships → we're a member. Open normally.
      selectChannel(channelId);
      return;
    }
    // Not in our list ⇒ not a member. Warm path: the Browse "Preview" button
    // already seeded previewChannel, so paint the read-only preview instantly.
    if (workspaceState.previewChannel?.id === channelId) {
      selectChannelPreview(workspaceState.previewChannel);
      return;
    }
    // Cold path (reload / deep link / "Close" landing on a non-member channel):
    // resolve membership from the server. A non-member NEVER gets the composer —
    // a public channel opens read-only (preview + Join), private/unknown bounces out.
    const wsId = page.params.id;
    try {
      const list = await listChannels();
      const found = list.find((c) => c.id === channelId);
      if (found?.isMember) {
        selectChannel(channelId);
      } else if (found && !found.isPrivate) {
        selectChannelPreview(found);
      } else if (wsId) {
        goto(`/workspace/${wsId}`);
      }
    } catch {
      if (wsId) goto(`/workspace/${wsId}`);
    }
  }

  // Item 5: contextual empty-state copy for an empty channel. Archived channels
  // get a distinct "read-only history" message; brand-new channels get
  // start-the-conversation guidance with the channel name. Use viewedChannel so a
  // previewed (non-member) channel resolves too — activeChannel is null for it.
  const viewedChannel = $derived(workspaceState.viewedChannel);
  const isPreviewing = $derived(workspaceState.isPreviewing);
  const channelName = $derived(viewedChannel?.name ?? "this channel");

  function getStatusEmoji(userId: string): string | null {
    if (userId === authState.user?.id) return userStatusState.emoji;
    return null;
  }

  function getStatusTooltip(userId: string): string | null {
    if (userId === authState.user?.id) return userStatusState.tooltip || null;
    return null;
  }

  function handleChannelDeleted() {
    goto(`/workspace/${page.params.id}`);
  }

  // Esc while previewing closes the read-only view and returns to the last
  // channel the user was actually in (preview never wrote the last-channel cache,
  // so it still points at the prior joined channel). Falls back to the workspace
  // root. Mirrors Mattermost's archived "Close Channel" → goToLastViewedChannel.
  function closePreview() {
    const wsId = page.params.id;
    if (!wsId) return;
    // Leave the read-only preview. Return to the last channel only if we're
    // actually a member of it; otherwise fall back to any joined channel, then
    // the workspace root. Never bounce back into another channel we haven't joined.
    const last = getLastChannel(wsId);
    const lastIsMember = last !== null && workspaceState.channels.some((c) => c.id === last);
    const fallback =
      workspaceState.channels.find((c) => c.id !== page.params.channelId)?.id ?? null;
    const target = lastIsMember ? last : fallback;
    goto(target ? `/workspace/${wsId}/channel/${target}` : `/workspace/${wsId}`);
  }

  $effect(() => {
    if (!isPreviewing) return;
    const onKey = (e: KeyboardEvent): void => {
      // Don't hijack Esc while typing in a field or with a dialog/menu open
      // (those own their own Esc). Only close when the preview is the focus.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      closePreview();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // "Message" button in the profile panel → open the target's conversation.
  function goToProfileTargetDm() {
    const t = profilePanelState.target;
    if (!t) return;
    profilePanelState.close();
    const route = t.kind === "agent" ? "agent" : "dm";
    goto(`/workspace/${page.params.id}/${route}/${t.id}`);
  }
</script>

<div class="relative flex h-full flex-col overflow-hidden">
  <ChannelHeader ondeleted={handleChannelDeleted} onTogglePinned={() => (pinnedOpen = !pinnedOpen)} />
  <MessageList
    {getStatusEmoji}
    {getStatusTooltip}
    {composerHeight}
    readOnly={isPreviewing}
    onReaction={isPreviewing ? undefined : toggleReaction}
    onEdit={isPreviewing ? undefined : editMessage}
    onDelete={isPreviewing ? undefined : requestDelete}
    onCatchup={isPreviewing || !workspaceState.activeChannel?.id
      ? undefined
      : () => runCatchup(workspaceState.activeChannel?.id ?? "", channelName)}
  >
    {#snippet emptyState()}
      {#if viewedChannel?.isArchived}
        <EmptyState
          variant="archived"
          title="#{channelName} is archived"
          description="This channel is read-only. Its history is preserved, but no new messages can be posted."
        />
      {:else if isPreviewing}
        <EmptyState
          variant="info"
          title="Previewing #{channelName}"
          description="No messages yet. Join the channel to start the conversation."
        />
      {:else}
        <EmptyState
          variant="new"
          title="Welcome to #{channelName}"
          description="This is the very beginning of the channel. Say hello, share an update, or @mention a teammate to get the conversation started."
        />
      {/if}
    {/snippet}
  </MessageList>
  {#if isPreviewing && viewedChannel}
    <!-- Not a member → read-only preview with a Join CTA, never a composer. -->
    <ChannelPreviewBanner channel={viewedChannel} onClose={closePreview} />
  {:else if workspaceState.activeChannel}
    <!-- Member of this channel → can post. The composer renders ONLY for an actual
         member; a non-member can never reach this branch (see openChannel). -->
    <MessageInput enableSlashCommands bind:composerHeight={composerHeight} />
  {/if}
  <ThreadPanel />
  <CatchupSheet />
  {#if pinnedOpen}
    <PinnedPanel onClose={() => (pinnedOpen = false)} />
  {/if}
  {#if profilePanelState.target}
    {#if viewportState.isMobile}
      <ProfilePanel overlay onMessage={goToProfileTargetDm} />
    {:else}
      <div class="absolute right-0 top-0 z-30 h-full">
        <ProfilePanel onMessage={goToProfileTargetDm} />
      </div>
    {/if}
  {/if}
  <ConfirmDialog
    open={pendingDeleteId !== null}
    title="Delete message?"
    message="This can't be undone. Replies in its thread are deleted too."
    confirmLabel="Delete"
    destructive
    onconfirm={confirmDelete}
    oncancel={() => (pendingDeleteId = null)}
  />
</div>
