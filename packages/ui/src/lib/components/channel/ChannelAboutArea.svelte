<script lang="ts">
  // About tab — read-only overview of the channel. Editing lives in the Settings
  // tab (single source of truth), so this never duplicates the editor.
  //
  // Typographic hierarchy (one scale, applied consistently):
  //   • section header — text-[11px] font-semibold uppercase tracking-wider, muted
  //   • value         — text-sm text-content
  //   • hint / meta   — text-xs text-content-dim
  import { Button } from "$lib/components/ui/button/index.js";
  import ChannelGlyph from "./ChannelGlyph.svelte";
  import type { Channel } from "$lib/core/types.js";

  let { channel }: { channel: Channel } = $props();

  // "Show more" for long descriptions: clamp to ~4 lines, measured against the
  // clamped element so it adapts to width/wrapping.
  let descExpanded = $state(false);
  let descEl = $state<HTMLParagraphElement | null>(null);
  let descOverflows = $state(false);
  $effect(() => {
    // oxlint-disable-next-line eslint/no-unused-expressions -- reactive dep
    channel.description;
    const el = descEl;
    if (!el) {
      descOverflows = false;
      return;
    }
    if (!descExpanded) descOverflows = el.scrollHeight - el.clientHeight > 1;
  });

  let copied = $state(false);
  async function copyId(): Promise<void> {
    try {
      await navigator.clipboard.writeText(channel.id);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard blocked (insecure context) — the value stays visible to copy by hand.
    }
  }

  function formatDate(ts: number): string {
    return new Date(ts).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  const sectionHeader = "text-[11px] font-semibold uppercase tracking-wider text-content-muted mb-1";
</script>

<div class="space-y-5">
  {#if channel.isArchived}
    <div class="flex items-center gap-2 rounded-lg bg-content/5 px-3 py-2 text-xs text-content-dim">
      <ChannelGlyph kind="archive" class="w-3.5 h-3.5 shrink-0" />
      This channel is archived — its history is preserved, but it's hidden from the active list.
    </div>
  {/if}

  {#if channel.isPrivate}
    <div class="flex items-center gap-2 rounded-lg bg-content/5 px-3 py-2 text-xs text-content-dim">
      <ChannelGlyph kind="private" class="w-3.5 h-3.5 shrink-0" />
      Private channel — only invited members can see and post.
    </div>
  {/if}

  <section>
    <div class={sectionHeader}>Description</div>
    {#if channel.description}
      <p
        bind:this={descEl}
        class={["text-sm text-content whitespace-pre-wrap", !descExpanded && "line-clamp-4"]}
      >
        {channel.description}
      </p>
      {#if descOverflows || descExpanded}
        <button
          type="button"
          class="mt-1 text-xs font-medium text-accent hover:underline"
          onclick={() => (descExpanded = !descExpanded)}
        >
          {descExpanded ? "Show less" : "Show more"}
        </button>
      {/if}
    {:else}
      <p class="text-sm italic text-content-muted">No description yet</p>
    {/if}
  </section>

  {#if channel.instructions}
    <section>
      <div class={sectionHeader}>Agent instructions</div>
      <p class="text-sm text-content-dim whitespace-pre-wrap">{channel.instructions}</p>
    </section>
  {/if}

  <section>
    <div class={sectionHeader}>Details</div>
    <dl class="space-y-1.5">
      <div class="flex items-baseline justify-between gap-3">
        <dt class="text-xs text-content-dim">Created</dt>
        <dd class="text-sm text-content">{formatDate(channel.createdAt)}</dd>
      </div>
      <div class="flex items-baseline justify-between gap-3">
        <dt class="text-xs text-content-dim">Channel ID</dt>
        <dd class="flex items-center gap-1.5">
          <code class="text-xs text-content-muted">{channel.id}</code>
          <Button variant="ghost" size="sm" class="h-5 px-1.5 text-[11px]" onclick={copyId}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </dd>
      </div>
    </dl>
  </section>
</div>
