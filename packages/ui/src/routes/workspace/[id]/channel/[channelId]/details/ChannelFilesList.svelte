<script lang="ts">
  // Mobile shared-files list for the channel details page (P5/S5). Same data
  // flow as SharedFilesPanel (cursor pagination, newest-first, signed URLs +
  // WebP thumbnail variants delivered inline) restyled to full-width iOS rows:
  // 48px thumbnail (rounded 12), 16px name, 13px meta, and ALWAYS-VISIBLE
  // trailing actions — the panel's hover-gated buttons are unusable on touch.
  // Capability parity with the dialog's Files tab: image preview, download,
  // jump-to-message (delegated to the page via onJump so it can navigate back
  // into the conversation), pagination.
  import { onDestroy } from "svelte";
  import { fetchChannelFiles } from "$lib/state/app.svelte.js";
  import { downloadFile } from "$lib/download.js";
  import { formatSize } from "$lib/utils.js";
  import type { SharedFile } from "$lib/ws-client.js";
  import ImagePreviewModal from "$lib/components/message/ImagePreviewModal.svelte";
  import ImageViewerModal from "$lib/components/message/ImageViewerModal.svelte";
  import BlurHashTile from "$lib/components/message/BlurHashTile.svelte";
  import { viewportState } from "$lib/state/viewport.svelte.js";

  let {
    channelId,
    onJump,
  }: {
    channelId: string;
    onJump: (messageId: string) => void;
  } = $props();

  const PAGE_SIZE = 20;

  let files = $state<SharedFile[]>([]);
  let hasMore = $state(false);
  let cursor = $state<string | null>(null);
  let loading = $state(true);
  let errorMsg = $state<string | null>(null);
  let previewImage = $state<{ url: string; name?: string } | null>(null);

  let sentinel = $state<HTMLDivElement | null>(null);
  let observer: IntersectionObserver | null = null;
  // Monotonic token so a stale in-flight fetch can't clobber the current list.
  let fetchToken = 0;

  async function fetchPage(before: string | null, append: boolean): Promise<void> {
    const token = ++fetchToken;
    loading = true;
    errorMsg = null;
    try {
      const page = await fetchChannelFiles(channelId, {
        before: before ?? undefined,
        limit: PAGE_SIZE,
      });
      if (token !== fetchToken) return; // superseded
      files = append ? [...files, ...page.files] : page.files;
      hasMore = page.hasMore;
      cursor = page.nextCursor;
    } catch (e) {
      if (token !== fetchToken) return;
      errorMsg = e instanceof Error ? e.message : "Failed to load files";
    } finally {
      if (token === fetchToken) loading = false;
    }
  }

  // Initial load (and reload if the route ever swaps channels in place).
  $effect(() => {
    // oxlint-disable-next-line eslint/no-unused-expressions -- reactive dependency
    channelId;
    files = [];
    cursor = null;
    hasMore = false;
    void fetchPage(null, false);
  });

  // Lazy-load the next page when the bottom sentinel scrolls into view.
  $effect(() => {
    observer?.disconnect();
    if (!sentinel || !hasMore) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting) && hasMore && !loading) {
          void fetchPage(cursor, true);
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(sentinel);
    observer = obs;
    return () => obs.disconnect();
  });

  onDestroy(() => observer?.disconnect());

  function sizeLabel(size: number): string {
    return size > 0 ? formatSize(size) : "";
  }

  function fileGlyph(type: string): string {
    if (type.startsWith("video/")) return "🎬";
    if (type.startsWith("audio/")) return "🎧";
    if (type === "application/pdf") return "📕";
    if (type.includes("zip") || type.includes("compressed")) return "🗜️";
    if (type.includes("spreadsheet") || type.includes("excel")) return "📊";
    if (type.includes("presentation") || type.includes("powerpoint")) return "📈";
    if (type.includes("word") || type.includes("document")) return "📄";
    return "📎";
  }

  function isImage(type: string): boolean {
    return type.startsWith("image/");
  }

  function thumbSrc(f: SharedFile): string {
    return f.attachment.thumbnails?.w360 ?? f.attachment.url;
  }

  // Row tap: images open the full preview; everything else downloads.
  function openFile(f: SharedFile): void {
    if (isImage(f.attachment.type)) {
      previewImage = { url: f.attachment.url, name: f.attachment.name };
    } else {
      void downloadFile(f.attachment.url, f.attachment.name);
    }
  }
</script>

{#if loading && files.length === 0}
  <p class="px-6 py-16 text-center text-[15px] text-content-muted">Loading…</p>
{:else if errorMsg}
  <div class="flex flex-col items-center px-6 py-16 text-center">
    <p class="text-[15px] text-error">Couldn't load files</p>
    <p class="mt-1 text-[13px] text-content-muted">{errorMsg}</p>
    <button
      type="button"
      class="pressable mt-4 min-h-[44px] rounded-[12px] px-4 text-[15px] font-medium text-accent focus-ring"
      onclick={() => fetchPage(null, false)}
    >
      Try again
    </button>
  </div>
{:else if files.length === 0}
  <!-- Designed empty state: centered, quiet. -->
  <div class="flex flex-col items-center px-6 py-16 text-center">
    <p class="text-[15px] text-content-muted">No files shared yet</p>
    <p class="mt-1 text-[13px] text-content-muted">
      Photos and files shared in this channel will appear here.
    </p>
  </div>
{:else}
  <div class="pt-1">
    {#each files as f (`${f.messageId}-${f.attachment.key ?? f.attachment.url}`)}
      <div class="pressable-row flex min-h-[60px] w-full items-center gap-3 px-4 py-[6px]">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-3 text-left focus-ring"
          onclick={() => openFile(f)}
          title={isImage(f.attachment.type)
            ? `Open ${f.attachment.name}`
            : `Download ${f.attachment.name}`}
        >
          {#if isImage(f.attachment.type)}
            <span class="h-[48px] w-[48px] shrink-0 overflow-hidden rounded-[12px] bg-edge">
              <BlurHashTile
                src={thumbSrc(f)}
                alt={f.attachment.name}
                blurhash={f.attachment.blurhash}
              />
            </span>
          {:else}
            <span
              class="flex h-[48px] w-[48px] shrink-0 items-center justify-center rounded-[12px] bg-surface-alt text-[22px]"
            >
              {fileGlyph(f.attachment.type)}
            </span>
          {/if}
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[16px] text-content">{f.attachment.name}</span>
            <span class="block truncate text-[13px] text-content-muted">
              {f.senderName}{sizeLabel(f.attachment.size) ? ` · ${sizeLabel(f.attachment.size)}` : ""}
            </span>
          </span>
        </button>

        <!-- Always-visible actions (touch has no hover): jump + download. -->
        <button
          type="button"
          onclick={() => onJump(f.messageId)}
          class="pressable flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-[12px] text-content-dim focus-ring"
          title="Jump to message"
          aria-label="Jump to message"
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          onclick={() => void downloadFile(f.attachment.url, f.attachment.name)}
          class="pressable flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-[12px] text-content-dim focus-ring"
          title={`Download ${f.attachment.name}`}
          aria-label={`Download ${f.attachment.name}`}
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 2v9M4 7l4 4 4-4M3 14h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    {/each}

    {#if hasMore}
      <div bind:this={sentinel} class="flex items-center justify-center py-3">
        <button
          type="button"
          onclick={() => fetchPage(cursor, true)}
          disabled={loading}
          class="pressable min-h-[44px] rounded-[12px] px-4 text-[13px] text-content-muted focus-ring disabled:opacity-50"
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      </div>
    {/if}
  </div>
{/if}

{#if viewportState.isMobile}
  <ImageViewerModal image={previewImage} onClose={() => (previewImage = null)} />
{:else}
  <ImagePreviewModal image={previewImage} onClose={() => (previewImage = null)} />
{/if}
