<script lang="ts">
  import { goto } from "$app/navigation";
  import { relativeTime } from "$lib/utils/datetime.js";
  import {
    threadsState,
    fetchThreads,
    openThread,
    markThreadRead,
    messageFocusState,
    workspaceState,
    cyboState,
    type ThreadSummary,
  } from "$lib/state/app.svelte.js";
  import Avatar from "../Avatar.svelte";

  const threads = $derived(threadsState.list);
  const wsId = $derived(workspaceState.current?.id);

  // Resolve a participant's avatar image by display name (participants are stored
  // as names on the thread summary). Best-effort lookup against workspace members;
  // falls back to initials when no image is known.
  function participantImage(name: string): string | null {
    const member = workspaceState.members.find((m) => m.name === name);
    return member?.image ?? member?.imageUrl ?? null;
  }

  // One-shot fetch on mount (and when the workspace changes).
  let fetchedFor = $state<string | null>(null);
  $effect(() => {
    if (wsId && fetchedFor !== wsId) {
      fetchedFor = wsId;
      void fetchThreads();
    }
  });

  function rootName(t: ThreadSummary): string {
    const root = t.root;
    if (!root) return "Thread";
    if (root.fromType === "agent" && root.fromId) {
      const cybo = cyboState.list.find((c) => c.id === root.fromId);
      if (cybo) return cybo.name;
    }
    return root.fromName ?? "Someone";
  }


  function open(t: ThreadSummary): void {
    const root = t.root;
    if (!root || !wsId) return;
    markThreadRead(root.id);
    if (root.channelId) {
      goto(`/workspace/${wsId}/channel/${root.channelId}`);
      void openThread(root);
      // Jump the channel to the thread's root + flash it (MessageList watches).
      messageFocusState.focus(root.id);
    }
  }
</script>

<div class="h-full overflow-y-auto bg-surface">
  <div class="mx-auto flex max-w-[var(--content-max)] flex-col gap-3 px-6 py-6">
    <header class="flex items-center justify-between">
      <h1 class="text-[20px] font-bold text-content">Threads</h1>
      {#if threadsState.counts.totalUnreadMentions > 0}
        <span
          class="flex h-[20px] min-w-[20px] items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-accent-foreground"
        >
          {threadsState.counts.totalUnreadMentions}
        </span>
      {/if}
    </header>

    {#if threadsState.loading && threads.length === 0}
      <p class="text-[13px] text-content-muted">Loading threads…</p>
    {:else if threads.length === 0}
      <div class="rounded-lg p-8 text-center" style="background-color: var(--surface-alt);">
        <p class="text-[14px] text-content-dim">No threads yet</p>
        <p class="mt-1 text-[12px] text-content-muted">
          Reply to a message to start a thread — followed threads show up here.
        </p>
      </div>
    {:else}
      <div class="flex flex-col gap-1.5">
        {#each threads as t (t.root?.id)}
          {@const unread = t.unreadReplies > 0 || t.unreadMentions > 0}
          <button
            type="button"
            onclick={() => open(t)}
            class="flex w-full flex-col gap-1 rounded-lg border border-edge px-4 py-3 text-left transition-colors hover:bg-hover-gray"
            class:border-l-2={unread}
            class:border-l-red-500={unread}
          >
            <div class="flex items-center justify-between gap-2">
              <span class="truncate text-[14px] font-semibold text-content">{rootName(t)}</span>
              <div class="flex shrink-0 items-center gap-2">
                {#if t.unreadMentions > 0}
                  <span
                    class="flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-accent-foreground"
                  >
                    {t.unreadMentions}
                  </span>
                {:else if t.unreadReplies > 0}
                  <span class="h-2 w-2 rounded-full bg-red-500"></span>
                {/if}
                <span class="text-[11px] text-content-muted">{relativeTime(t.lastReplyAt)}</span>
              </div>
            </div>
            {#if t.root?.text}
              <span class="line-clamp-2 text-[13px] text-content-dim">{t.root.text}</span>
            {/if}
            <!-- Thread metadata: reply count, last-reply time, participant avatars + count -->
            <div class="mt-1 flex items-center gap-2 text-[12px]">
              <span class="font-semibold text-link">
                {t.replyCount}
                {t.replyCount === 1 ? "reply" : "replies"}
              </span>
              <span class="text-content-muted">Last reply {relativeTime(t.lastReplyAt)}</span>
              {#if t.participants.length > 0}
                <div class="ml-auto flex items-center">
                  <div class="flex -space-x-1">
                    {#each t.participants.slice(0, 3) as p (p)}
                      <Avatar
                        name={p}
                        image={participantImage(p)}
                        width={18}
                        fontSize={8}
                        borderRadius={4}
                        class="ring-1 ring-[var(--bg-base)]"
                      />
                    {/each}
                  </div>
                  {#if t.participants.length > 3}
                    <span class="ml-1 text-[10px] text-content-muted">+{t.participants.length - 3}</span>
                  {/if}
                </div>
              {/if}
            </div>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>
