export interface VideoMeta {
  duration?: number; // media length in SECONDS
  width?: number; // intrinsic video width (px)
  height?: number; // intrinsic video height (px)
  posterBlob?: Blob; // a captured first-/mid-frame thumbnail (video only)
}

// Bound the whole extraction so a wedged decode (codec the browser hints it can
// play but then stalls on) can never block the send pipeline.
const EXTRACT_TIMEOUT_MS = 8_000;

/**
 * Client-side compute of video (or audio) metadata before upload.
 *
 * For video files we load a hidden `<video>` (preload=metadata, muted, from an
 * object URL), read `duration` + `videoWidth`/`videoHeight` on `loadedmetadata`,
 * then seek to a representative frame (`min(1, duration/2)`) and, on `seeked`,
 * draw it to a canvas → a WebP (or JPEG fallback) poster Blob. Storing duration
 * + dimensions lets the player show a proper time label and reserve an
 * aspect-ratio box before the media element loads; the poster gives an instant
 * Slack-style preview frame without streaming the whole file.
 *
 * For audio files callers only want `duration` (no poster) — this works for
 * `audio/*` too: the metadata read succeeds, the frame-grab is simply skipped.
 *
 * EVERYTHING is best-effort: any failure (CORS-tainted canvas, unsupported
 * codec, timeout) degrades to "return what we have" — duration only, or `{}`.
 * Callers must never block the send on this. Mirrors `image-meta.ts`.
 */
export async function computeVideoMeta(file: File): Promise<VideoMeta> {
  const isVideo = file.type.startsWith("video/");
  const isAudio = file.type.startsWith("audio/");
  if (!isVideo && !isAudio) return {};
  if (typeof document === "undefined") return {};

  const objectUrl = URL.createObjectURL(file);
  // Audio decodes through the same media element; only video can grab a frame.
  const el = document.createElement("video");
  el.preload = "metadata";
  el.muted = true;
  // Avoid iOS auto-fullscreen on any internal play and keep the element offscreen.
  el.playsInline = true;
  el.crossOrigin = "anonymous";

  const result: VideoMeta = {};

  try {
    await withTimeout(
      (async () => {
        await loadMetadata(el, objectUrl);

        if (Number.isFinite(el.duration) && el.duration > 0) {
          result.duration = el.duration;
        }
        if (el.videoWidth && el.videoHeight) {
          result.width = el.videoWidth;
          result.height = el.videoHeight;
        }

        // Audio (or a video with no decodable frame size) → metadata only.
        if (!isVideo || !el.videoWidth || !el.videoHeight) return;

        // Seek to a representative frame. For very short clips the midpoint, else
        // ~1s in (skips fade-from-black intros). Clamp to a valid time.
        const seekTarget =
          Number.isFinite(el.duration) && el.duration > 0 ? Math.min(1, el.duration / 2) : 0;
        await seekTo(el, seekTarget);

        const posterBlob = await captureFrame(el);
        if (posterBlob) result.posterBlob = posterBlob;
      })(),
      EXTRACT_TIMEOUT_MS,
    );
  } catch (err) {
    // Keep whatever we already gathered (often the duration) — never throw.
    console.warn("[media/video-meta] compute failed:", (err as Error).message);
  } finally {
    // Detach the source so the browser can free the decoder, then revoke.
    try {
      el.removeAttribute("src");
      el.load();
    } catch {
      // ignore — element is being discarded anyway
    }
    URL.revokeObjectURL(objectUrl);
  }

  return result;
}

function loadMetadata(el: HTMLVideoElement, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onLoaded = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("metadata load failed"));
    };
    const cleanup = (): void => {
      el.removeEventListener("loadedmetadata", onLoaded);
      el.removeEventListener("error", onError);
    };
    el.addEventListener("loadedmetadata", onLoaded);
    el.addEventListener("error", onError);
    el.src = src;
  });
}

function seekTo(el: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("seek failed"));
    };
    const cleanup = (): void => {
      el.removeEventListener("seeked", onSeeked);
      el.removeEventListener("error", onError);
    };
    el.addEventListener("seeked", onSeeked);
    el.addEventListener("error", onError);
    // Setting currentTime triggers the seek; `seeked` fires when the frame is ready.
    el.currentTime = time;
  });
}

// Draw the current frame to a canvas and encode a poster Blob. Prefers WebP
// (smaller) and falls back to JPEG where WebP encoding isn't supported. Returns
// null on a tainted canvas (cross-origin source without CORS) or encode failure.
function captureFrame(el: HTMLVideoElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      const w = el.videoWidth;
      const h = el.videoHeight;
      if (!w || !h) return resolve(null);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);
      ctx.drawImage(el, 0, 0, w, h);
      const onBlob = (blob: Blob | null): void => {
        // toBlob SILENTLY falls back to image/png when WebP encoding isn't
        // supported, so `if (blob)` alone would accept a (potentially huge,
        // lossless) PNG. Only accept a real WebP here; otherwise fall through to
        // an explicit, compressed JPEG. The caller reads `blob.type` to pick the
        // poster's filename extension, so the returned MIME is always truthful.
        if (blob && blob.type === "image/webp") return resolve(blob);
        // WebP unsupported (fell back to PNG) or failed → try JPEG before giving up.
        canvas.toBlob((jpeg) => resolve(jpeg), "image/jpeg", 0.8);
      };
      canvas.toBlob(onBlob, "image/webp", 0.8);
    } catch {
      // toBlob throws SecurityError on a tainted canvas — no poster.
      resolve(null);
    }
  });
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
