import { encode } from "blurhash";

export interface ImageMeta {
  width: number;
  height: number;
  blurhash: string;
}

/**
 * Client-side compute of pixel dimensions + BlurHash for an image file.
 * Runs in-browser before upload so:
 *  - we avoid a server-side decode on every upload,
 *  - dimensions are stored on the attachment so the renderer reserves an
 *    aspect-ratio box and the message list never reflows when images decode,
 *  - BlurHash gives instant low-quality-image-placeholder paint (Slack-style).
 *
 * Returns null for formats we can't decode in-browser (HEIC, TIFF, SVG, …).
 * Callers degrade gracefully — the attachment still uploads/renders, just
 * without the smooth-scroll/placeholder guarantee. Ported from cyborg7-core
 * `src/lib/media/imageMeta.ts`.
 */
export async function computeImageMeta(file: File): Promise<ImageMeta | null> {
  if (!file.type.startsWith("image/")) return null;
  // SVG has no pixel grid to hash; native dimensions aren't meaningful either.
  if (file.type === "image/svg+xml") return null;

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (!width || !height) return null;

    // BlurHash wants an RGBA byte array from a small canvas. A 32px target
    // keeps encode under ~10ms and avoids janking the main thread during
    // rapid multi-file attaches.
    const maxEdge = 32;
    const scale = Math.min(maxEdge / width, maxEdge / height, 1);
    const cw = Math.max(1, Math.round(width * scale));
    const ch = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { width, height, blurhash: "" };
    ctx.drawImage(img, 0, 0, cw, ch);
    const data = ctx.getImageData(0, 0, cw, ch);

    // 4x3 component count — balances fidelity vs hash length (~30 chars).
    const blurhash = encode(data.data, cw, ch, 4, 3);
    return { width, height, blurhash };
  } catch (err) {
    console.warn("[media/image-meta] compute failed:", (err as Error).message);
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.addEventListener("load", () => resolve(img));
    img.addEventListener("error", () => reject(new Error("image decode failed")));
    img.src = src;
  });
}
