<script lang="ts">
  import { Dialog, DialogContent, DialogHeader, DialogTitle } from "$lib/components/ui/dialog/index.js";
  import { catchupState, runCatchup } from "$lib/state/app.svelte.js";
  import { renderMarkdownToHtml } from "$lib/render-markdown.js";

  // Personal /catchup digest overlay. The digest is ephemeral — it lives only in
  // catchupState and is never persisted. Opened by the unread-divider button or
  // a /catchup composer submit; the result streams in via the catchup_result
  // event (see app.svelte.ts).
  const digestHtml = $derived(
    catchupState.status === "ready" ? renderMarkdownToHtml(catchupState.digest) : "",
  );
</script>

<Dialog
  bind:open={catchupState.open}
  onOpenChange={(o) => {
    if (!o) catchupState.close();
  }}
>
  <DialogContent
    class="sm:max-w-[560px]"
    showCloseButton={true}
    escapeKeydownBehavior={catchupState.status === "loading" ? "ignore" : "close"}
    interactOutsideBehavior={catchupState.status === "loading" ? "ignore" : "close"}
  >
    <DialogHeader>
      <DialogTitle>
        Catch up{catchupState.channelName ? ` — #${catchupState.channelName}` : ""}
      </DialogTitle>
    </DialogHeader>

    {#if catchupState.status === "loading"}
      <div class="flex items-center gap-2 py-6 text-[13px] text-content-muted">
        <span class="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"></span>
        Summarizing what you missed…
      </div>
    {:else if catchupState.status === "empty"}
      <div class="py-6 text-center text-[14px] text-content-muted">
        {catchupState.errorText || "You're all caught up. ✨"}
      </div>
    {:else if catchupState.status === "error"}
      <div class="py-4 text-[13px] text-error">
        {catchupState.errorText || "/catchup failed."}
        <button
          type="button"
          class="mt-3 block underline hover:opacity-80"
          onclick={() => {
            if (catchupState.channelId)
              void runCatchup(catchupState.channelId, catchupState.channelName);
          }}
        >Try again</button>
      </div>
    {:else}
      <div class="max-h-[60vh] overflow-y-auto">
        {#if catchupState.unreadCount > 0}
          <p class="mb-2 text-[11px] uppercase tracking-wide text-content-dim">
            {catchupState.unreadCount} new message{catchupState.unreadCount === 1 ? "" : "s"}
          </p>
        {/if}
        <!-- Digest markdown. Same renderer the channel messages use. -->
        <div class="prose-chat text-[14px] leading-[1.55] text-content">
          {@html digestHtml}
        </div>
      </div>
    {/if}
  </DialogContent>
</Dialog>
