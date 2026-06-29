<script lang="ts">
  // Mobile long-press action sheet for a single message attachment — the touch
  // counterpart to the desktop right-click AttachmentContextMenu.
  //
  // WHY THIS EXISTS — the attachment UX shipped with only hover-overlay /
  // oncontextmenu triggers, which are DEAD on iOS (no hover, no contextmenu on
  // touch). So "Copy image" and "Save video" were completely unreachable on the
  // phone. This sheet is the touch path: long-press an attachment → an
  // iMessage-style bottom sheet with the per-type actions, each a ≥48pt row.
  //
  // Mirrors the MessageActionSheet material-sheet pattern EXACTLY (the project's
  // mobile "context menu"): translucent .material-sheet chrome (blur on its
  // ::before, never the container — WebKit trap), a grab handle, --sat/--sab
  // safe areas, a grouped inset card with hairline separators, min-h-[48px]
  // rows with active:bg-raised press feedback, 16px labels. Theme tokens only.
  //
  // Action routing reuses the SAME helpers as AttachmentContextMenu so copy/save
  // logic lives in one place: web → $lib/media/clipboard + downloadFile; iOS →
  // the native plugin commands (Photos / clipboard / document-export). A short
  // haptic fires on open and on each action's success/failure.
  import { toast } from "svelte-sonner";
  import BottomActionSheet from "./BottomActionSheet.svelte";
  import { downloadFile } from "$lib/download.js";
  import { copyImageToClipboard, copyLinkToClipboard } from "$lib/media/clipboard.js";
  import {
    isTauriIOS,
    saveImageToPhotos,
    saveVideoToPhotos,
    saveFile,
    copyImageToClipboardNative,
  } from "$lib/mobile/push.js";
  import { haptic } from "$lib/mobile/haptics.js";

  let {
    url,
    type,
    name,
    onClose,
  }: {
    url: string;
    type: string; // MIME type, e.g. "image/png", "video/mp4"
    name: string;
    onClose: () => void;
  } = $props();

  const isImage = $derived(type.startsWith("image/"));
  const isVideo = $derived(type.startsWith("video/"));
  // iOS Tauri shell: the web ClipboardItem / blob-download paths are no-ops in a
  // WKWebView, so Copy image + Save route to native plugin commands instead.
  const onIos = isTauriIOS();

  // Open haptic — runs once when the sheet mounts (it only mounts when open).
  // Native iOS bridge (haptics.ts): a real UIImpactFeedbackGenerator buzz,
  // iOS-gated and a no-op on web/desktop. The intended kinds map 1:1 onto the
  // native styles: generic tap → "light", success → "success", error → "error".
  $effect(() => {
    haptic("light");
  });

  // A single in-flight action at a time (each handler bails early while busy).
  // `busy` disables every row so a slow copy/save can't be double-fired;
  // `busyAction` names the running one so ONLY that row swaps its icon for a
  // spinner. Dismiss is intentionally NOT blocked: tapping the backdrop while a
  // copy/save is in flight just unmounts the sheet — the async op keeps running
  // and still toasts success/failure in the background, so there's no desync and
  // the sheet never feels stuck on a slow mobile network.
  let busy = $state(false);
  let busyAction = $state<"copyImage" | "copyLink" | "saveImage" | "saveVideo" | "saveAsFile" | null>(
    null,
  );

  function close(): void {
    onClose();
  }

  async function copyImage(): Promise<void> {
    if (busy) return;
    busy = true;
    busyAction = "copyImage";
    try {
      let ok = true;
      if (onIos) {
        ok = await copyImageToClipboardNative(url);
      } else {
        // Web helper throws on failure; reaching the next line means success.
        await copyImageToClipboard(url);
      }
      if (ok) {
        haptic("success");
        toast.success("Image copied");
      } else {
        haptic("error");
        toast.error("Couldn't copy image");
      }
    } catch (err) {
      // Log the REAL failure so it isn't invisible — web path: insecure context /
      // no clipboard API / CORS-tainted / denied / desktop-native failure.
      console.error("[AttachmentActionSheet] copy image failed", err);
      haptic("error");
      toast.error("Couldn't copy image");
    } finally {
      busy = false;
      busyAction = null;
      close();
    }
  }

  async function copyLink(): Promise<void> {
    if (busy) return;
    busy = true;
    busyAction = "copyLink";
    try {
      await copyLinkToClipboard(url);
      haptic("success");
      toast.success("Link copied");
    } catch {
      haptic("error");
      toast.error("Couldn't copy link");
    } finally {
      busy = false;
      busyAction = null;
      close();
    }
  }

  async function saveImage(): Promise<void> {
    if (busy) return;
    busy = true;
    busyAction = "saveImage";
    try {
      if (onIos) {
        const ok = await saveImageToPhotos(url);
        haptic(ok ? "success" : "error");
        toast[ok ? "success" : "error"](ok ? "Saved to Photos" : "Couldn't save image");
      } else {
        await downloadFile(url, name);
        haptic("success");
        toast.success("Image saved");
      }
    } catch {
      haptic("error");
      toast.error("Couldn't save image");
    } finally {
      busy = false;
      busyAction = null;
      close();
    }
  }

  async function saveVideo(): Promise<void> {
    if (busy) return;
    busy = true;
    busyAction = "saveVideo";
    try {
      if (onIos) {
        const ok = await saveVideoToPhotos(url);
        haptic(ok ? "success" : "error");
        toast[ok ? "success" : "error"](ok ? "Saved to Photos" : "Couldn't save video");
      } else {
        await downloadFile(url, name);
        haptic("success");
        toast.success("Video saved");
      }
    } catch {
      haptic("error");
      toast.error("Couldn't save video");
    } finally {
      busy = false;
      busyAction = null;
      close();
    }
  }

  async function saveAsFile(): Promise<void> {
    if (busy) return;
    busy = true;
    busyAction = "saveAsFile";
    try {
      if (onIos) {
        const ok = await saveFile(url, name);
        haptic(ok ? "success" : "error");
        toast[ok ? "success" : "error"](ok ? "Saved" : "Couldn't save");
      } else {
        await downloadFile(url, name);
        haptic("success");
        toast.success("File saved");
      }
    } catch {
      haptic("error");
      toast.error("Couldn't save");
    } finally {
      busy = false;
      busyAction = null;
      close();
    }
  }
</script>

<BottomActionSheet ariaLabel="Attachment actions" onClose={close}>
  <!-- File name caption -->
  <div class="mb-2 shrink-0 truncate px-1 text-center text-[13px] text-content-muted">{name}</div>

  <!-- Vertical action list — one grouped inset card; hairlines between cells. -->
  <div class="shrink-0 overflow-hidden rounded-[12px] bg-surface-alt">
        {#if isImage}
          <button
            type="button"
            disabled={busy}
            onclick={copyImage}
            class="flex min-h-[48px] w-full items-center gap-3 px-4 transition-colors active:bg-raised disabled:opacity-60"
          >
            {#if busyAction === "copyImage"}
              {@render spinner()}
            {:else}
              <svg class="h-[20px] w-[20px] shrink-0 text-content-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            {/if}
            <span class="flex-1 text-left text-[16px] text-content">Copy image</span>
          </button>
          <div class="mx-4 h-px" style="background-color: var(--hairline);"></div>

          <button
            type="button"
            disabled={busy}
            onclick={copyLink}
            class="flex min-h-[48px] w-full items-center gap-3 px-4 transition-colors active:bg-raised disabled:opacity-60"
          >
            {#if busyAction === "copyLink"}{@render spinner()}{:else}{@render linkIcon()}{/if}
            <span class="flex-1 text-left text-[16px] text-content">Copy link</span>
          </button>
          <div class="mx-4 h-px" style="background-color: var(--hairline);"></div>

          <button
            type="button"
            disabled={busy}
            onclick={saveImage}
            class="flex min-h-[48px] w-full items-center gap-3 px-4 transition-colors active:bg-raised disabled:opacity-60"
          >
            {#if busyAction === "saveImage"}{@render spinner()}{:else}{@render saveIcon()}{/if}
            <span class="flex-1 text-left text-[16px] text-content">{onIos ? "Save to Photos" : "Save image"}</span>
          </button>
        {:else if isVideo}
          <button
            type="button"
            disabled={busy}
            onclick={saveVideo}
            class="flex min-h-[48px] w-full items-center gap-3 px-4 transition-colors active:bg-raised disabled:opacity-60"
          >
            {#if busyAction === "saveVideo"}{@render spinner()}{:else}{@render saveIcon()}{/if}
            <span class="flex-1 text-left text-[16px] text-content">{onIos ? "Save to Photos" : "Save video"}</span>
          </button>
          <div class="mx-4 h-px" style="background-color: var(--hairline);"></div>

          <button
            type="button"
            disabled={busy}
            onclick={copyLink}
            class="flex min-h-[48px] w-full items-center gap-3 px-4 transition-colors active:bg-raised disabled:opacity-60"
          >
            {#if busyAction === "copyLink"}{@render spinner()}{:else}{@render linkIcon()}{/if}
            <span class="flex-1 text-left text-[16px] text-content">Copy link</span>
          </button>
        {:else}
          <button
            type="button"
            disabled={busy}
            onclick={saveAsFile}
            class="flex min-h-[48px] w-full items-center gap-3 px-4 transition-colors active:bg-raised disabled:opacity-60"
          >
            {#if busyAction === "saveAsFile"}{@render spinner()}{:else}{@render saveIcon()}{/if}
            <span class="flex-1 text-left text-[16px] text-content">Save / Download</span>
          </button>
          <div class="mx-4 h-px" style="background-color: var(--hairline);"></div>

          <button
            type="button"
            disabled={busy}
            onclick={copyLink}
            class="flex min-h-[48px] w-full items-center gap-3 px-4 transition-colors active:bg-raised disabled:opacity-60"
          >
            {#if busyAction === "copyLink"}{@render spinner()}{:else}{@render linkIcon()}{/if}
            <span class="flex-1 text-left text-[16px] text-content">Copy link</span>
          </button>
        {/if}
      </div>

  <!-- Cancel — separate grouped card, matches iOS sheet convention. -->
  <button
    type="button"
    onclick={close}
    class="mt-2 flex min-h-[48px] shrink-0 w-full items-center justify-center rounded-[12px] bg-surface-alt px-4 text-[16px] font-semibold text-content transition-colors active:bg-raised"
  >
    Cancel
  </button>
</BottomActionSheet>

{#snippet spinner()}
  <span
    class="h-[18px] w-[18px] shrink-0 animate-spin rounded-full border-2 border-content-muted/30 border-t-content-muted"
    role="status"
    aria-label="Working"
  ></span>
{/snippet}

{#snippet saveIcon()}
  <svg class="h-[20px] w-[20px] shrink-0 text-content-dim" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M8 2v9M4 7l4 4 4-4M3 14h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
{/snippet}

{#snippet linkIcon()}
  <svg class="h-[20px] w-[20px] shrink-0 text-content-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
{/snippet}
