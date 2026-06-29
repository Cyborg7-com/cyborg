<script lang="ts">
  // Slack-style right-click context menu for a message attachment. Modeled on
  // ChannelContextMenu (fixed, positioned at {x,y}, theme tokens, shadcn-svelte
  // look). Net-new vs. the original — Mattermost has no copy-image-binary.
  //
  // Self-contained close behavior: outside-click, Escape, scroll, resize, and
  // blur all dismiss the menu (the parent just toggles `att`/`x`/`y` and passes
  // `onClose`). Portaled to <body> so the fixed overlay escapes any transformed
  // ancestor (PullToRefresh) — same fix ImagePreviewModal uses.
  import { toast } from "svelte-sonner";
  import { downloadFile } from "$lib/download.js";
  import { copyImageToClipboard, copyLinkToClipboard } from "$lib/media/clipboard.js";
  import {
    isTauriIOS,
    saveImageToPhotos,
    saveVideoToPhotos,
    saveFile,
    copyImageToClipboardNative,
  } from "$lib/mobile/push.js";
  import { portal } from "$lib/actions/portal.js";

  // Minimal attachment shape — only what the menu needs (decoupled from the full
  // Attachment interface so the lightbox could reuse it too if desired).
  let {
    url,
    type,
    name,
    x,
    y,
    onClose,
  }: {
    url: string;
    type: string;
    name: string;
    x: number;
    y: number;
    onClose: () => void;
  } = $props();

  const isImage = $derived(type.startsWith("image/"));
  // iOS Tauri shell: the web ClipboardItem / blob-download paths are no-ops in a
  // WKWebView, so Copy image + Download route to native plugin commands instead.
  const onIos = isTauriIOS();

  async function handleCopyImage(): Promise<void> {
    try {
      if (onIos) {
        const ok = await copyImageToClipboardNative(url);
        if (ok) toast.success("Image copied");
        else toast.error("Couldn't copy image");
        return;
      }
      await copyImageToClipboard(url);
      toast.success("Image copied");
    } catch (err) {
      // Log the REAL failure — clipboard API unavailable / insecure context /
      // CORS-tainted / denied / desktop-native failure — so it isn't invisible.
      console.error("[AttachmentContextMenu] copy image failed", err);
      toast.error("Couldn't copy image");
    } finally {
      onClose();
    }
  }

  async function handleCopyLink(): Promise<void> {
    try {
      await copyLinkToClipboard(url);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy link");
    } finally {
      onClose();
    }
  }

  function handleDownload(): void {
    if (onIos) {
      // Route by MIME type to the native plugin: images/videos → Photos,
      // everything else → the document-export sheet.
      if (type.startsWith("image/")) void saveImageToPhotos(url);
      else if (type.startsWith("video/")) void saveVideoToPhotos(url);
      else void saveFile(url, name);
      onClose();
      return;
    }
    void downloadFile(url, name);
    onClose();
  }

  // Outside-click / scroll / resize / blur dismiss. Escape is handled on the
  // menu's own keydown (focus lands inside via autofocus) and via svelte:window.
  function onWindowPointerDown(e: MouseEvent): void {
    if (!(e.target as HTMLElement)?.closest?.(".attachment-context-menu")) onClose();
  }
  function onWindowKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") onClose();
  }
</script>

<svelte:window
  onmousedown={onWindowPointerDown}
  oncontextmenu={onWindowPointerDown}
  onkeydown={onWindowKeydown}
  onscroll={onClose}
  onresize={onClose}
  onblur={onClose}
/>

<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
<div
  use:portal
  role="menu"
  tabindex="-1"
  aria-label="Attachment actions"
  class="attachment-context-menu fixed z-[var(--z-context-menu)] w-[180px] rounded-lg py-1 shadow-2xl"
  style="background-color: var(--dropdown-bg); border: 1px solid var(--dropdown-border); left: {x}px; top: {y}px;"
>
  {#if isImage}
    <button
      type="button"
      role="menuitem"
      onclick={handleCopyImage}
      class="w-full text-left px-3 py-1.5 text-[12px] text-content-dim hover:bg-[var(--dropdown-hover)] hover:text-content transition-colors cursor-pointer flex items-center gap-2"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
      Copy image
    </button>
  {/if}
  <button
    type="button"
    role="menuitem"
    onclick={handleCopyLink}
    class="w-full text-left px-3 py-1.5 text-[12px] text-content-dim hover:bg-[var(--dropdown-hover)] hover:text-content transition-colors cursor-pointer flex items-center gap-2"
  >
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
    Copy link
  </button>
  <button
    type="button"
    role="menuitem"
    onclick={handleDownload}
    class="w-full text-left px-3 py-1.5 text-[12px] text-content-dim hover:bg-[var(--dropdown-hover)] hover:text-content transition-colors cursor-pointer flex items-center gap-2"
  >
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2v9M4 7l4 4 4-4M3 14h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    Download
  </button>
</div>
