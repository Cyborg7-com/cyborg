// Shared clipboard helpers for media attachments. Used by the right-click
// AttachmentContextMenu and the ImagePreviewModal lightbox so the copy logic
// lives in ONE place (no duplication).
//
// "Copy image" is net-new vs. the original (Mattermost has no copy-image-binary
// feature). The standard browser mechanism is `navigator.clipboard.write([
// new ClipboardItem({ 'image/png': blob })])`. Browsers generally only accept
// `image/png` in a ClipboardItem, so any non-PNG source (JPEG/WebP/GIF/…) is
// re-encoded to PNG via an offscreen canvas before writing.
//
// PLATFORM ROUTING (one point — `copyImageToClipboard` below): the web
// ClipboardItem path is fragile inside the Electron shell — the async fetch +
// canvas→PNG re-encode can outlast the click's user-activation window, and the
// cross-origin fetch is bound by the renderer's CORS / permission rules — so on
// desktop we route to a NATIVE main-process path that fetches the bytes with
// Electron `net` (no CORS, no activation window) and writes a `nativeImage` to
// the system clipboard, the desktop equivalent of the iOS native pasteboard
// helper (`copyImageToClipboardNative` in $lib/mobile/push.ts). iOS keeps its
// own native path, gated at the callers via `isTauriIOS()`.

import { isDesktopApp } from "$lib/utils.js";

// Minimal shape of the Electron preload bridge — only the generic `invoke`
// command channel is needed here (see packages/desktop-cyborg/preload.cts).
interface DesktopBridge {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

function desktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { cyborg7Desktop?: Partial<DesktopBridge> }).cyborg7Desktop;
  return typeof bridge?.invoke === "function" ? (bridge as DesktopBridge) : null;
}

// Copy the image at `url` to the clipboard via the Electron main process. Main
// fetches the bytes (Node-side `net`, no CORS) and writes a `nativeImage` to the
// system clipboard. Resolves true on success, false otherwise — throws are
// swallowed into `false` (mirrors the iOS `copyImageToClipboardNative` contract).
export async function copyImageToClipboardNativeDesktop(url: string): Promise<boolean> {
  const bridge = desktopBridge();
  if (!bridge) return false;
  try {
    const res = (await bridge.invoke("copy_image_to_clipboard", { url })) as {
      copied?: boolean;
    } | null;
    return Boolean(res?.copied);
  } catch (err) {
    console.error("[clipboard] desktop copy_image_to_clipboard failed", err);
    return false;
  }
}

// Re-encode an arbitrary image blob to PNG by drawing it onto a canvas.
// Used because the async clipboard API only reliably accepts `image/png`.
async function toPngBlob(blob: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    ctx.drawImage(bmp, 0, 0);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("canvas.toBlob returned null");
    return png;
  } finally {
    // createImageBitmap allocates GPU/CPU memory that GC won't reclaim promptly.
    bmp.close();
  }
}

// Copy the binary image at `url` to the clipboard as PNG. Throws on any failure
// (insecure context / no clipboard API / CORS-tainted fetch / permission) so the
// caller can surface a graceful toast. CORS note: the fetch + canvas readback
// only succeeds when the cross-origin host (CloudFront/S3) returns permissive
// CORS headers; otherwise the fetch or `toBlob` throws and we fall through to
// the caller's error toast.
//
// ONE routing point: on the Electron desktop shell, delegate to the native
// main-process path (no CORS, no activation window). It returns a boolean, so a
// false result is converted into a throw to keep this function's throw-on-failure
// contract uniform across every caller. Web (browser) uses the ClipboardItem
// path below; iOS uses its own native path, gated at the callers.
export async function copyImageToClipboard(url: string): Promise<void> {
  if (isDesktopApp()) {
    const copied = await copyImageToClipboardNativeDesktop(url);
    if (!copied) throw new Error("Desktop native clipboard copy failed");
    return;
  }
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("Clipboard image API unavailable");
  }
  // Hand ClipboardItem a PROMISE (not an already-awaited Blob): the network fetch
  // + PNG re-encode can outlast the click's transient user activation, and
  // `clipboard.write` with a resolved Blob then fails with NotAllowedError. The
  // Promise form keeps the write bound to the original gesture while the bytes
  // resolve. Chrome supports it; Safari/WebKit REQUIRES it for async sources.
  const pngBlob = (async () => {
    const blob = await (await fetch(url, { mode: "cors" })).blob();
    // Already PNG → use directly; otherwise re-encode (browsers only accept PNG).
    return blob.type === "image/png" ? blob : await toPngBlob(blob);
  })();
  await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
}

// Copy a plain URL string to the clipboard. Throws on failure so the caller can
// toast. Note: signed CloudFront/S3 URLs can EXPIRE — fine for a quick paste,
// not for durable sharing.
export async function copyLinkToClipboard(url: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard text API unavailable");
  }
  await navigator.clipboard.writeText(url);
}
