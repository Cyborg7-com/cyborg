/**
 * Shared image-action layer (#537) — the single source for the save / copy
 * behavior the two image modals (ImagePreviewModal, ImageViewerModal) used to
 * hand-duplicate (and which had drifted: the viewer skipped the Android native
 * save, and the two showed different result copy). Each modal keeps ONLY its own
 * gesture/layout; it consumes this composable for the action logic + state.
 *
 * Usage (in a component <script>, so the effects bind to its lifecycle):
 *   const actions = createImageActions(() => image);
 *   // template: actions.saving / actions.saveResult / actions.saveResultLabel /
 *   //           actions.onNativeSave / actions.saveNoun
 *   // handlers: actions.save() / actions.copyImage() / actions.copyLink()
 */
import { toast } from "svelte-sonner";
import { downloadFile } from "$lib/download.js";
import { copyImageToClipboard, copyLinkToClipboard } from "$lib/media/clipboard.js";
import {
  isTauriIOS,
  isTauriAndroid,
  saveImageToPhotos,
  copyImageToClipboardNative,
} from "$lib/mobile/push.js";
import { hasActiveComposer, setNativeVisibility } from "$lib/mobile/nativeComposer.js";
import { nativeSaveNoun, saveResultLabel } from "./image-actions.js";

export interface ImageActionTarget {
  url: string;
  name?: string;
}

export function createImageActions(getImage: () => ImageActionTarget | null) {
  // Resolved once — platform identity doesn't change within a session.
  const onIos = isTauriIOS();
  // Save→gallery routes to the NATIVE plugin on BOTH mobile platforms (the web
  // `<a download>` is a no-op in either mobile WebView): iOS → Photos, Android →
  // MediaStore (#461/#475). This gate lives HERE so the modals can't drift — the
  // exact bug #537 fixed (the viewer used to gate on iOS only, skipping Android).
  const onNativeSave = onIos || isTauriAndroid();
  const noun = nativeSaveNoun(onIos);

  let saving = $state(false);
  let copying = $state(false);
  let saveResult = $state<"saved" | "failed" | null>(null);
  let saveResultTimer: ReturnType<typeof setTimeout> | undefined;

  // The native composer pill is a UIKit overlay ABOVE the WKWebView, so a web
  // modal can't cover it — hide while a viewer is open, restore on close. iOS
  // only (a UIKit quirk, not on Android). Restore CONDITIONALLY so we never
  // resurrect the pill on a non-chat surface.
  //
  // Depend on a STABLE open/closed boolean, not getImage() directly: reading the
  // image object inside the effect would re-run it on every image swap (carousel
  // navigation), flicker-toggling the native pill (restore→hide) and spamming
  // IPC. `hasImage` only flips on the actual open↔close transition.
  const hasImage = $derived(getImage() !== null);
  $effect(() => {
    if (!onIos || !hasImage) return;
    setNativeVisibility(false);
    return () => setNativeVisibility(hasActiveComposer());
  });
  // Don't leak the result-clear timer if the modal unmounts mid-countdown.
  $effect(() => () => clearTimeout(saveResultTimer));

  async function save(): Promise<void> {
    const image = getImage();
    if (!image?.name) return;
    const url = image.url;
    if (onNativeSave) {
      if (saving) return;
      saving = true;
      saveResult = null;
      const ok = await saveImageToPhotos(url);
      saving = false;
      saveResult = ok ? "saved" : "failed";
      clearTimeout(saveResultTimer);
      saveResultTimer = setTimeout(() => (saveResult = null), 2200);
    } else {
      void downloadFile(url, image.name ?? "image");
    }
  }

  // Copy the binary image to the clipboard. iOS routes to the native pasteboard
  // (the web ClipboardItem write is a no-op in a WKWebView); web/desktop use the
  // shared canvas→PNG helper (throws on failure). Toasts the outcome and returns
  // ok so a caller can layer extra feedback (e.g. the viewer's haptic).
  async function copyImage(): Promise<boolean> {
    const image = getImage();
    if (copying || !image) return false;
    copying = true;
    try {
      let ok = true;
      if (onIos) {
        ok = await copyImageToClipboardNative(image.url);
      } else {
        await copyImageToClipboard(image.url);
      }
      if (ok) toast.success("Image copied");
      else toast.error("Couldn't copy image");
      return ok;
    } catch (err) {
      // Log the REAL failure so it isn't invisible (web ClipboardItem path or
      // desktop-native failure); keep the user-facing toast short.
      console.error("[image-actions] copy image failed", err);
      toast.error("Couldn't copy image");
      return false;
    } finally {
      copying = false;
    }
  }

  async function copyLink(): Promise<void> {
    const image = getImage();
    if (!image) return;
    try {
      await copyLinkToClipboard(image.url);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy link");
    }
  }

  return {
    onNativeSave,
    saveNoun: noun,
    get saving() {
      return saving;
    },
    get copying() {
      return copying;
    },
    get saveResult() {
      return saveResult;
    },
    get saveResultLabel() {
      return saveResultLabel(saveResult, noun);
    },
    save,
    copyImage,
    copyLink,
  };
}
