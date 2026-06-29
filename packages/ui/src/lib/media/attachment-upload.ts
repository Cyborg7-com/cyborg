// Shared attachment upload core — the channel/DM composer (MessageInput) and the
// agent composer (AgentComposer) both turn a picked/pasted/dropped File into an
// Attachment via this ONE pipeline, so the S3-presign + local-mode fallback +
// image/video metadata logic can't drift between the two composers.
import { client } from "$lib/state/app.svelte.js";
import { computeImageMeta } from "$lib/media/image-meta.js";
import { computeVideoMeta } from "$lib/media/video-meta.js";
import { MAX_ATTACHMENT_BYTES } from "$lib/core/client.js";
import type { Attachment } from "$lib/types.js";

export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.addEventListener("load", () => resolve(r.result as string));
    r.addEventListener("error", () => reject(new Error("read failed")));
    r.readAsDataURL(file);
  });
}

// Upload via the S3 presign endpoint (cloud). When S3 isn't configured
// (local/dev) the presign fails, so we fall back to an inline data: URL — the
// same Attachment shape works two-user locally with no infra.
export async function fileToAttachment(
  file: File,
  // #517: progress + cancel for the MAIN file PUT (the poster upload below stays
  // plain — it's a tiny, non-critical best-effort asset).
  opts?: { onProgress?: (pct: number) => void; signal?: AbortSignal },
): Promise<Attachment> {
  // Hard size guard BEFORE the upload try/catch — otherwise an oversized file
  // would fall through to the data-URL fallback and surface the misleading
  // "too large for local mode" error.
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `${file.name} is too large (max ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB)`,
    );
  }
  // Compute width/height/blurhash up-front (images only) so the renderer can
  // reserve an aspect-ratio box + paint a placeholder. Same fields on both the
  // S3 and the local data-URL path. Null for non-images / undecodable.
  const meta = await computeImageMeta(file);
  const dims = meta
    ? { width: meta.width, height: meta.height, blurhash: meta.blurhash || undefined }
    : {};

  // Video/audio metadata — duration (both), intrinsic dimensions + a poster
  // frame (video only). Best-effort: any failure degrades to whatever we got
  // (often duration only) so we never block the send. The poster is uploaded as
  // its own public asset and referenced by `poster`/`posterKey`.
  const media: Pick<Attachment, "duration" | "width" | "height" | "poster" | "posterKey"> = {};
  if (file.type.startsWith("video/") || file.type.startsWith("audio/")) {
    try {
      const vm = await computeVideoMeta(file);
      if (vm.duration !== undefined) media.duration = vm.duration;
      if (vm.width !== undefined) media.width = vm.width;
      if (vm.height !== undefined) media.height = vm.height;
      if (vm.posterBlob) {
        try {
          // Derive the extension from the ACTUAL blob MIME — computeVideoMeta
          // returns WebP or (where WebP encoding isn't supported) JPEG, so a
          // hardcoded `.webp` would mislabel a JPEG poster.
          const posterExt = vm.posterBlob.type === "image/jpeg" ? "jpg" : "webp";
          const posterFile = new File([vm.posterBlob], `${file.name}.${posterExt}`, {
            type: vm.posterBlob.type,
          });
          const poster = await client.uploadAsset(posterFile, "attachments");
          media.poster = poster.publicUrl;
          media.posterKey = poster.key;
        } catch (err) {
          // Poster upload is non-critical — the player falls back to a neutral
          // placeholder + reads duration on load. Keep going.
          console.warn("[attachments] poster upload failed:", (err as Error).message);
        }
      }
    } catch (err) {
      console.warn("[attachments] video metadata failed:", (err as Error).message);
    }
  }
  try {
    const { publicUrl, key } = await client.uploadAsset(file, "attachments", opts);
    return {
      key,
      name: file.name,
      type: file.type,
      size: file.size,
      url: publicUrl,
      ...dims,
      ...media,
    };
  } catch {
    if (file.size > 2 * 1024 * 1024) {
      throw new Error(`${file.name} is too large for local mode (2MB without S3)`);
    }
    const url = await readAsDataUrl(file);
    // In local mode the poster was never uploaded (uploadAsset above threw), so
    // drop poster/posterKey — but keep duration/width/height for the player.
    const { poster: _poster, posterKey: _posterKey, ...localMedia } = media;
    void _poster;
    void _posterKey;
    return {
      key: `inline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      type: file.type,
      size: file.size,
      url,
      ...dims,
      ...localMedia,
    };
  }
}
