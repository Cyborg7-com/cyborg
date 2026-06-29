<script lang="ts">
  // Slack/WhatsApp-style "Shared Files" panel — ported from cyborg7-core's
  // SharedFilesPanel.tsx. Works for both 1:1 human DMs and channels: same
  // list-with-pagination, only the source endpoint differs. Files are listed
  // newest-first with images and other file types interleaved chronologically
  // (Slack mixes them too — splitting by type buries a recent PDF below older
  // photos).
  //
  // Unlike the Next.js original, this rewrite delivers signed CloudFront URLs
  // and WebP thumbnail variants inline on each attachment (the relay signs them
  // in fetch_channel_files/fetch_dm_files), so tiles render straight off
  // `attachment.thumbnails.w360 ?? attachment.url` — there is no /files/thumb
  // proxy and downloads blob the signed `url` via downloadFile (a plain
  // `<a download>` is ignored on cross-origin links and just navigates).
  import { onDestroy } from "svelte";
  import { fetchChannelFiles, fetchDmFiles, messageFocusState } from "$lib/state/app.svelte.js";
  import { downloadFile } from "$lib/download.js";
  import { formatSize } from "$lib/utils.js";
  import type { SharedFile, SharedFilesPage } from "$lib/ws-client.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import ImagePreviewModal from "./message/ImagePreviewModal.svelte";
  import ImageViewerModal from "./message/ImageViewerModal.svelte";
  import BlurHashTile from "./message/BlurHashTile.svelte";

  let {
    source,
    onJump,
  }: {
    // EITHER a DM peer, a channel, OR an agent — discriminated so the call site
    // is type-safe. The `agent` source lists files a human uploaded TO the agent;
    // those persist as messages with toId=agentId, which fetch_dm_files (peerId =
    // agentId) returns via the same getDmFiles `fromId=user AND toId=peer` clause.
    source:
      | { kind: "dm"; peerId: string }
      | { kind: "channel"; channelId: string }
      | { kind: "agent"; agentId: string };
    // Invoked when the user clicks jump. Defaults to messageFocusState.focus
    // (scroll + flash the source message in the active timeline), which is what
    // both the channel and DM message lists watch.
    onJump?: (messageId: string) => void;
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
  // Monotonic token so a stale in-flight fetch (source switched mid-request)
  // can't clobber the current list when it resolves.
  let fetchToken = 0;

  const sourceKey = $derived.by(() => {
    if (source.kind === "dm") return `dm:${source.peerId}`;
    if (source.kind === "agent") return `agent:${source.agentId}`;
    return `ch:${source.channelId}`;
  });

  async function fetchPage(before: string | null, append: boolean): Promise<void> {
    const token = ++fetchToken;
    loading = true;
    errorMsg = null;
    try {
      const opts = { before: before ?? undefined, limit: PAGE_SIZE };
      let page: SharedFilesPage;
      if (source.kind === "dm") {
        page = await fetchDmFiles(source.peerId, opts);
      } else if (source.kind === "agent") {
        // Agent files reuse fetch_dm_files with peerId = agentId — human→agent
        // prompt uploads persist as messages addressed to the agent, which the
        // DM-files query returns (it matches messages either direction between
        // the user and this peer). No new RPC.
        page = await fetchDmFiles(source.agentId, opts);
      } else {
        page = await fetchChannelFiles(source.channelId, opts);
      }
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

  function jump(messageId: string): void {
    if (onJump) onJump(messageId);
    else messageFocusState.focus(messageId);
  }

  // Reset + initial load whenever the source changes (DM↔DM or DM↔channel).
  $effect(() => {
    // Track the source identity so the effect re-runs on switch.
    // oxlint-disable-next-line eslint/no-unused-expressions -- reactive dependency
    sourceKey;
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

  // Clicking a file opens it the same way chat does: images → the lightbox,
  // anything else → download (chat has no in-app viewer for non-images).
  function openFile(f: SharedFile): void {
    if (isImage(f.attachment.type)) {
      previewImage = { url: f.attachment.url, name: f.attachment.name };
    } else {
      void downloadFile(f.attachment.url, f.attachment.name);
    }
  }
</script>

<div class="px-4 pb-4">
  <span class="mb-2 block text-[14px] font-bold text-white">Shared Files</span>

  {#if loading && files.length === 0}
    <div class="rounded-lg px-3 py-3 text-[12px] text-content-muted" style="background-color: var(--bg-elevated); border: 1px solid var(--border);">
      Loading…
    </div>
  {:else if errorMsg}
    <div class="rounded-lg px-3 py-3 text-[12px] text-error" style="background-color: var(--bg-elevated); border: 1px solid var(--border);">
      Couldn't load files: {errorMsg}
    </div>
  {:else if files.length === 0}
    <div class="rounded-lg px-3 py-3 text-[12px] text-content-muted" style="background-color: var(--bg-elevated); border: 1px solid var(--border);">
      No files shared yet.
    </div>
  {:else}
    <div class="flex flex-col gap-1">
      {#each files as f (`${f.messageId}-${f.attachment.key ?? f.attachment.url}`)}
        <div class="group relative flex items-center gap-2 rounded-md hover:bg-raised">
          {#if isImage(f.attachment.type)}
            <button
              type="button"
              onclick={() => (previewImage = { url: f.attachment.url, name: f.attachment.name })}
              class="h-12 w-12 shrink-0 cursor-pointer overflow-hidden rounded bg-edge"
              title={`Open ${f.attachment.name}`}
              tabindex="-1"
            >
              <BlurHashTile
                src={thumbSrc(f)}
                alt={f.attachment.name}
                blurhash={f.attachment.blurhash}
              />
            </button>
          {:else}
            <button
              type="button"
              onclick={() => openFile(f)}
              class="flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center rounded bg-edge text-[20px]"
              title={`Download ${f.attachment.name}`}
              tabindex="-1"
            >
              {fileGlyph(f.attachment.type)}
            </button>
          {/if}

          <button
            type="button"
            onclick={() => openFile(f)}
            class="min-w-0 flex-1 cursor-pointer py-1.5 text-left"
            title={isImage(f.attachment.type) ? `Open ${f.attachment.name}` : `Download ${f.attachment.name}`}
          >
            <span class="block truncate text-[13px] text-white">{f.attachment.name}</span>
            <span class="block truncate text-[11px] text-content-muted">
              {f.senderName}{sizeLabel(f.attachment.size) ? ` · ${sizeLabel(f.attachment.size)}` : ""}
            </span>
          </button>

          <!-- Actions are ALWAYS rendered (Mattermost's file_attachment pattern)
               so focus/keyboard can reach them — visibility is CSS-driven via
               `.file-actions` in app.css: hidden until row hover/focus on
               desktop, always shown on coarse-pointer / narrow viewports. The
               `touch-target` class lifts each to a ≥44px hit area on touch. -->
          <div class="file-actions flex items-center gap-1 pr-1.5">
            <button
              type="button"
              onclick={(e) => { e.stopPropagation(); jump(f.messageId); }}
              class="pressable-scale touch-target flex cursor-pointer items-center justify-center rounded bg-black/60 p-1 text-accent-foreground hover:bg-black/80 focus-ring"
              title="Jump to message"
              aria-label="Jump to message"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              onclick={(e) => {
                e.stopPropagation();
                void downloadFile(f.attachment.url, f.attachment.name);
              }}
              class="pressable-scale touch-target flex cursor-pointer items-center justify-center rounded bg-black/60 p-1 text-accent-foreground hover:bg-black/80 focus-ring"
              title={`Download ${f.attachment.name}`}
              aria-label={`Download ${f.attachment.name}`}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 2v9M4 7l4 4 4-4M3 14h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span class="sr-only">Download</span>
            </button>
          </div>
        </div>
      {/each}
    </div>

    {#if hasMore}
      <div bind:this={sentinel} class="flex items-center justify-center pt-3">
        <button
          type="button"
          onclick={() => fetchPage(cursor, true)}
          disabled={loading}
          class="cursor-pointer text-[12px] text-content-dim hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      </div>
    {/if}
  {/if}
</div>

{#if viewportState.isMobile}
  <ImageViewerModal image={previewImage} onClose={() => (previewImage = null)} />
{:else}
  <ImagePreviewModal image={previewImage} onClose={() => (previewImage = null)} />
{/if}
