// Native clipboard handlers for the Electron shell.
//
// WHY: the renderer's web "Copy image" relies SOLELY on
// `navigator.clipboard.write([ClipboardItem])` (packages/ui/src/lib/media/
// clipboard.ts). That path is fragile inside the Electron shell — the async
// fetch + canvas→PNG re-encode can outlast the click's transient user
// activation, and the cross-origin fetch is subject to the renderer's CORS /
// permission rules — so "Copy image" frequently failed with "Couldn't copy
// image". This is the desktop equivalent of the iOS native pasteboard path
// (packages/ui/src/lib/mobile/push.ts `copyImageToClipboardNative`).
//
// The MAIN process fetches the bytes via Electron `net` (Node-side, no CORS, no
// activation window) and writes a `nativeImage` to the system clipboard. The
// renderer reaches this through the shared `cyborg7:invoke` channel (the same
// trusted-origin-guarded dispatch as the daemon commands), so no new IPC channel
// or preload surface is added.

import { clipboard, nativeImage, net } from "electron";
import log from "electron-log/main";

import type { DesktopCommandHandler } from "./daemon-manager.js";

// Hard ceiling on the bytes we'll pull into the main process for a clipboard
// copy. The app's upload cap (MAX_ATTACHMENT_BYTES in
// packages/server/src/server/cyborg/routes/assets.ts) is a local, non-exported
// const inside a server route that drags in sharp/AWS — not importable into the
// Electron main process without crossing the desktop package boundary — so we
// keep an independent, intentionally conservative 15 MB cap here.
const MAX_CLIPBOARD_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB

// How long we'll wait on the fetch before aborting. Without this an unresponsive
// host could hang the Electron main process indefinitely.
const FETCH_TIMEOUT_MS = 30_000;

// Fetch `url` and return the decoded bytes. Uses Electron's `net` (Chromium's
// network stack in the main process) so it isn't bound by the renderer's CORS
// rules or by the click's user-activation window — the exact reasons the web
// ClipboardItem path is fragile in the shell.
//
// Hardened against two main-process hazards: (1) a slow/hung host — an
// AbortController fires after FETCH_TIMEOUT_MS; (2) an oversized body — we never
// buffer the whole response (no `arrayBuffer()`), instead streaming chunks and
// aborting the instant we cross MAX_CLIPBOARD_IMAGE_BYTES, so a huge or
// unbounded download can't OOM the process.
async function fetchImageBuffer(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await net.fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`image fetch failed: HTTP ${response.status}`);
    }

    // Fast reject when the server advertises an oversized payload up front.
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_CLIPBOARD_IMAGE_BYTES) {
      throw new Error(
        `image too large: ${contentLength} bytes exceeds ${MAX_CLIPBOARD_IMAGE_BYTES} byte cap`,
      );
    }

    const body = response.body;
    if (!body) {
      throw new Error("image fetch returned no body");
    }

    // Stream the body, summing chunk sizes, and bail the moment we exceed the
    // cap — so a missing/lying content-length can't be used to OOM the process.
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_CLIPBOARD_IMAGE_BYTES) {
          await reader.cancel();
          throw new Error(
            `image too large: exceeded ${MAX_CLIPBOARD_IMAGE_BYTES} byte cap while streaming`,
          );
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }

    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

// Download the image at `url` and write it to the system clipboard as a native
// image. Resolves `{ copied: boolean }` (mirrors the iOS plugin's shape) so the
// renderer can toast success/failure without relying on a thrown error.
async function copyImageToClipboard(args?: Record<string, unknown>): Promise<{ copied: boolean }> {
  const url = typeof args?.url === "string" ? args.url : "";
  if (!url) {
    log.warn("[clipboard] copy_image_to_clipboard called without a url");
    return { copied: false };
  }
  try {
    const buffer = await fetchImageBuffer(url);
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) {
      // createFromBuffer returns an empty image for an undecodable / non-image
      // payload (e.g. an error page or an unsupported codec).
      log.warn("[clipboard] decoded image was empty", { url });
      return { copied: false };
    }
    clipboard.writeImage(image);
    return { copied: true };
  } catch (err) {
    log.error("[clipboard] copy_image_to_clipboard failed", err);
    return { copied: false };
  }
}

// Command handlers merged into the shared `cyborg7:invoke` dispatch map in
// registerDaemonManager(). Keeps the native clipboard logic out of the
// daemon module while reusing the single trusted-origin-guarded channel.
export function createClipboardCommandHandlers(): Record<string, DesktopCommandHandler> {
  return {
    copy_image_to_clipboard: copyImageToClipboard,
  };
}
