import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import sharp from "sharp";
import { createConcurrencyLimiter } from "../concurrency-limiter.js";
import type { RelayEnv, RequireAuth } from "./types.js";

// Cap concurrent thumbnail jobs: each buffers the full S3 object in memory and
// sharp is CPU-heavy, so unbounded concurrency can pin the relay's CPU/RAM (the
// size guard below only bounds a SINGLE request). Past the queue cap we shed
// load with a 503 rather than queue (and buffer) unboundedly (#196).
const THUMB_CONCURRENCY = 6;
const THUMB_MAX_QUEUE = 100;
const thumbLimiter = createConcurrencyLimiter(THUMB_CONCURRENCY, THUMB_MAX_QUEUE);

export interface AssetRoutesDeps {
  requireAuth: RequireAuth;
  // The S3 client + bucket are constructed in relay-standalone.ts and injected,
  // because a backend-status RPC handler there also reports their state.
  s3Client: S3Client | null;
  s3Bucket: string | undefined;
  s3Region: string;
}

const THUMB_WIDTHS = [360, 720, 1080] as const;
// Hard ceiling on attachment size. Enforced at the presign checkpoint (the
// client declares the size; we reject oversized requests before issuing a URL)
// and again hard on the client before upload. NOTE: a presigned PUT can't
// enforce a byte range, so a malicious client could still PUT more to a URL it
// obtained — fully server-enforced size needs a presigned POST with a
// content-length-range condition (deferred follow-up).
// Exported so server-initiated downloads (e.g. inbound Slack file re-hosting) cap their
// stream at the SAME ceiling uploadBufferToS3 enforces, instead of duplicating the value.
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MB
// Decompression-bomb guard for the thumbnailer: refuse to let sharp decode an
// image with more pixels than this (a 100k×100k "image" is a few KB on disk but
// would OOM the relay). Real photos are well under 50 MP.
const MAX_DECODE_PIXELS = 50_000_000; // 50 megapixels

// ─── Upload content-type policy (presign-time download/XSS hardening) ─────────
//
// Our S3 bucket is PUBLIC-READ behind CloudFront with NO serve-time middleware
// (clients PUT directly via presigned URLs). So an uploaded `text/html` or
// `image/svg+xml` would execute as STORED XSS if a victim opened its URL inline,
// and arbitrary types could be abused. We cannot add a serve-time filter, so we
// bind SAFE object metadata AT PRESIGN time: S3 then echoes `Content-Type` /
// `Content-Disposition` on every GET, and CloudFront serves them. This adapts
// Mattermost's serve-time defense (inline-allowlist + force-download everything
// else + rewrite HTML/JS → text/plain + nosniff) to a presigned-PUT model.
//
// NOTE: a presigned PUT *signs* the headers it binds, so the CLIENT must replay
// the EXACT `Content-Type` / `Content-Disposition` we signed or the signature
// fails. `presignPutMetadata()` returns precisely that header set.

// Types the browser is allowed to render INLINE (served with their real
// Content-Type and no forced disposition). Deliberately conservative: no
// `image/svg+xml` (SVG can carry <script>), no HTML, no documents.
export const INLINE_SAFE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/ogg",
]);

// HTML/script-ish types that must be NEUTRALIZED: forced to download AND
// rewritten to `text/plain` so the browser can never execute them (Mattermost's
// rewrite pattern). `image/svg+xml` lives here, not in the inline set.
const SCRIPTABLE_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/javascript",
  "text/javascript",
  "application/ecmascript",
  "text/ecmascript",
  "application/x-javascript",
]);

// Executable / installer / archive-of-code types rejected OUTRIGHT at presign —
// we never want these in a public-read bucket regardless of disposition.
export const BLOCKED_UPLOAD_TYPES = new Set([
  "application/x-msdownload",
  "application/x-sh",
  "application/x-executable",
  "application/java-archive",
  "application/vnd.microsoft.portable-executable",
  "application/x-dosexec",
  "application/x-elf",
  "application/x-mach-binary",
  "application/x-msi",
  "application/vnd.android.package-archive", // .apk
  "application/x-apple-diskimage", // .dmg
]);

// Common documents accepted for upload but forced to download (never inline).
const DOC_TYPES = new Set(["application/pdf", "text/plain", "application/json", "text/markdown"]);

// Full set of content-types accepted at presign at all: inline-safe ∪ scriptable
// (accepted but neutralized) ∪ docs ∪ the legacy chat-media set. Anything not in
// here is rejected as "unsupported"; anything in BLOCKED is rejected first.
const ALLOWED_UPLOAD_TYPES = new Set([
  ...INLINE_SAFE_TYPES,
  ...SCRIPTABLE_TYPES,
  ...DOC_TYPES,
  // Legacy chat media: audio (voice notes), video, the original image set.
  "image/svg+xml", // (already in SCRIPTABLE_TYPES — kept for parity with prior allowlist)
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/wav",
  "audio/x-aiff",
  "audio/aiff",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

export type PresignRejectReason = "blocked" | "unsupported";

export class PresignContentTypeError extends Error {
  constructor(
    public readonly reason: PresignRejectReason,
    public readonly contentType: string,
  ) {
    super(
      reason === "blocked"
        ? `content type blocked for security: ${contentType}`
        : `unsupported content type: ${contentType}`,
    );
    this.name = "PresignContentTypeError";
  }
}

// Sanitize a filename for use inside a `Content-Disposition` header. Strips
// control chars / quotes / path separators, then emits BOTH a plain ASCII
// `filename=` (fallback) and an RFC 5987 `filename*=UTF-8''…` (the real name,
// percent-encoded) so non-ASCII names survive without breaking the header.
// Sanitization is done by code point (not a control-char regex) so header
// injection via CR/LF and friends is structurally impossible.
export function buildContentDisposition(rawFilename: string): string {
  const cleaned = sanitizeFilenameChars(rawFilename || "download").trim();
  const safe = cleaned.length > 0 ? cleaned : "download";
  // ASCII fallback: any code point outside printable ASCII (0x20–0x7e) → '_'.
  let asciiFallback = "";
  for (const ch of safe) {
    const code = ch.codePointAt(0) ?? 0;
    asciiFallback += code >= 0x20 && code <= 0x7e ? ch : "_";
  }
  // RFC 5987 extended value: percent-encode the UTF-8 name. encodeURIComponent
  // leaves ' ( ) * unescaped, but RFC 5987's `attr-char` set excludes them, so
  // some parsers choke on a literal `'()*` inside filename*. Escape them too.
  const encoded = encodeURIComponent(safe).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

// Replace control chars (0x00–0x1f, 0x7f) — including the CR/LF that could
// inject a new header — plus quotes / backslash / path separators with '_'.
function sanitizeFilenameChars(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = code <= 0x1f || code === 0x7f;
    const isUnsafePunct = ch === '"' || ch === "\\" || ch === "/";
    out += isControl || isUnsafePunct ? "_" : ch;
  }
  return out;
}

export interface PresignObjectMetadata {
  ContentType: string;
  ContentDisposition?: string;
}

// Decide the SAFE object metadata to bind at presign time for a given declared
// content-type + filename. Throws PresignContentTypeError for blocked/unknown.
//   - inline-safe   → real ContentType, no disposition (browser may render).
//   - scriptable    → ContentType forced to text/plain + attachment (neutralized).
//   - everything else allowed (docs, generic) → real ContentType + attachment.
export function resolvePresignMetadata(
  contentType: string,
  filename: string,
): PresignObjectMetadata {
  if (BLOCKED_UPLOAD_TYPES.has(contentType)) {
    throw new PresignContentTypeError("blocked", contentType);
  }
  if (!ALLOWED_UPLOAD_TYPES.has(contentType)) {
    throw new PresignContentTypeError("unsupported", contentType);
  }
  if (SCRIPTABLE_TYPES.has(contentType)) {
    // Neutralize: cannot execute as text/plain, and forced to download anyway.
    return {
      ContentType: "text/plain",
      ContentDisposition: buildContentDisposition(filename),
    };
  }
  if (INLINE_SAFE_TYPES.has(contentType)) {
    // Safe to render inline — keep real type, no forced disposition.
    return { ContentType: contentType };
  }
  // Allowed but not inline-safe (pdf, json, markdown, generic) → force download.
  return {
    ContentType: contentType,
    ContentDisposition: buildContentDisposition(filename),
  };
}

export interface UploadBufferParams {
  s3Client: S3Client | null;
  s3Bucket: string | undefined;
  s3Region: string;
  buffer: Buffer;
  contentType: string;
  filename: string;
  folder?: string;
}
export interface UploadBufferResult {
  key: string;
  publicUrl: string;
}

// Direct SERVER-SIDE upload of a buffer to S3 (the relay holds the creds). Used
// by the agent-image attachment path (#845): the daemon ships a generated image's
// BYTES inline over WS, and the relay PUTs them straight to S3 — no presigned
// round-trip, since the daemon has neither creds nor a way to await a presign.
// Reuses resolvePresignMetadata so the SAME safe Content-Type/Disposition apply,
// and only lets INLINE_SAFE image/media types through this server-initiated path.
// Returns null (caller degrades gracefully) when S3 is off, the buffer is too
// large, or the type isn't inline-safe.
export async function uploadBufferToS3(
  params: UploadBufferParams,
): Promise<UploadBufferResult | null> {
  const { s3Client, s3Bucket, s3Region, buffer, contentType, filename, folder } = params;
  if (!s3Client || !s3Bucket) return null;
  if (buffer.length === 0 || buffer.length > MAX_ATTACHMENT_BYTES) return null;
  if (!INLINE_SAFE_TYPES.has(contentType)) return null;
  // Safe metadata (inline-safe → real type, no forced disposition). Throws only
  // for blocked/unsupported, which the INLINE_SAFE guard above already excludes.
  const metadata = resolvePresignMetadata(contentType, filename);
  const ext = filename.split(".").pop() ?? "bin";
  const key = `${folder ?? "agent-images"}/${randomUUID()}.${ext}`;
  await s3Client.send(
    new PutObjectCommand({
      Bucket: s3Bucket,
      Key: key,
      Body: buffer,
      ContentType: metadata.ContentType,
      ContentDisposition: metadata.ContentDisposition,
    }),
  );
  return { key, publicUrl: `https://${s3Bucket}.s3.${s3Region}.amazonaws.com/${key}` };
}

// Asset uploads (S3 presigned URLs) + on-demand thumbnails. Extracted from
// relay-standalone.ts (compositor) as a mounted Hono sub-app — see
// `app.route("/", createAssetRoutes(...))`. Pure mechanical move.
export function createAssetRoutes(deps: AssetRoutesDeps): Hono<RelayEnv> {
  const { requireAuth, s3Client, s3Bucket, s3Region } = deps;
  const app = new Hono<RelayEnv>();

  app.post("/api/assets/presign", requireAuth, async (c) => {
    if (!s3Client || !s3Bucket) return c.json({ error: "S3 storage not configured" }, 503);
    const body = (await c.req.json()) as {
      filename: string;
      contentType: string;
      folder?: string;
      size?: number;
    };
    if (!body.filename || !body.contentType)
      return c.json({ error: "filename and contentType required" }, 400);

    // Size is REQUIRED — otherwise an older/handwritten client could omit it and
    // skip the size checkpoint entirely. Must be a finite, non-negative number.
    if (typeof body.size !== "number" || !Number.isFinite(body.size) || body.size < 0) {
      return c.json({ error: "size (bytes) required" }, 400);
    }
    if (body.size > MAX_ATTACHMENT_BYTES) {
      return c.json(
        { error: `file too large (max ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB)` },
        413,
      );
    }

    // Decide SAFE object metadata to BIND on the upload. This rejects blocked
    // (executable) and unknown types, neutralizes scriptable types to text/plain
    // + attachment, forces non-inline-safe types to download, and leaves
    // inline-safe types renderable. The returned headers are exactly what S3 /
    // CloudFront will echo on GET — and exactly what the client MUST replay on
    // its PUT (a presigned PUT signs these headers).
    let metadata: PresignObjectMetadata;
    try {
      metadata = resolvePresignMetadata(body.contentType, body.filename);
    } catch (err) {
      if (err instanceof PresignContentTypeError) {
        // 415 Unsupported Media Type for both blocked and unsupported — both are
        // client errors about an unacceptable content-type.
        return c.json({ error: err.message, reason: err.reason }, 415);
      }
      throw err;
    }

    const ext = body.filename.split(".").pop() ?? "bin";
    const folder = body.folder ?? "avatars";
    const key = `${folder}/${randomUUID()}.${ext}`;

    const command = new PutObjectCommand({
      Bucket: s3Bucket,
      Key: key,
      ContentType: metadata.ContentType,
      ContentDisposition: metadata.ContentDisposition,
    });

    const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
    const publicUrl = `https://${s3Bucket}.s3.${s3Region}.amazonaws.com/${key}`;

    // The client MUST replay these EXACT headers on its S3 PUT or the presigned
    // signature will fail (the headers above are part of the signed request).
    const requiredHeaders: Record<string, string> = { "Content-Type": metadata.ContentType };
    if (metadata.ContentDisposition) {
      requiredHeaders["Content-Disposition"] = metadata.ContentDisposition;
    }

    return c.json({ presignedUrl, publicUrl, key, requiredHeaders });
  });

  app.get("/api/assets/config", requireAuth, async (c) => {
    return c.json({
      enabled: !!s3Client,
      bucket: s3Bucket ?? null,
      region: s3Region,
      baseUrl: s3Bucket ? `https://${s3Bucket}.s3.${s3Region}.amazonaws.com` : null,
    });
  });

  // ─── On-demand image thumbnails (M7) ──────────────────────────
  // Public (the S3 key is the capability — matches the public-read bucket) so
  // <img>/<picture> can fetch without auth headers. Fetches the original from
  // S3, resizes with sharp → WebP, caches hard at the edge/browser. The renderer
  // requests w=360/720/1080 and falls back to the original on error.
  app.get("/api/assets/thumb", async (c) => {
    if (!s3Client || !s3Bucket) return c.json({ error: "storage not configured" }, 503);
    const key = c.req.query("key");
    const w = Number(c.req.query("w"));
    if (!key) return c.json({ error: "key required" }, 400);
    if (!THUMB_WIDTHS.includes(w as (typeof THUMB_WIDTHS)[number])) {
      return c.json({ error: "unsupported width" }, 400);
    }
    // Acquire a slot AFTER cheap validation (don't spend capacity on bad requests).
    // A full queue sheds load instead of buffering yet another source object; the
    // request's abort signal drops the waiter if the client disconnects while queued.
    if (!(await thumbLimiter.acquire(c.req.raw.signal))) {
      return c.json({ error: "thumbnailer busy, retry shortly" }, 503);
    }
    try {
      const obj = await s3Client.send(new GetObjectCommand({ Bucket: s3Bucket, Key: key }));
      if (!obj.Body) return c.json({ error: "not found" }, 404);
      // Refuse to buffer an oversized object into memory. transformToByteArray
      // loads the WHOLE object, so without this an attacker who got a large file
      // into the bucket could OOM the relay just by requesting its thumbnail.
      if (typeof obj.ContentLength === "number" && obj.ContentLength > MAX_ATTACHMENT_BYTES) {
        return c.json({ error: "object too large" }, 413);
      }
      const input = Buffer.from(await obj.Body.transformToByteArray());
      const out = await sharp(input, { limitInputPixels: MAX_DECODE_PIXELS })
        .rotate() // respect EXIF orientation
        .resize({ width: w, withoutEnlargement: true })
        .webp({ quality: 70 })
        .toBuffer();
      return new Response(new Uint8Array(out), {
        headers: {
          "Content-Type": "image/webp",
          "Cache-Control": "public, max-age=86400, immutable",
        },
      });
    } catch (err) {
      console.error("[media] thumb failed:", (err as Error).message);
      return c.json({ error: "thumbnail generation failed" }, 404);
    } finally {
      thumbLimiter.release();
    }
  });

  return app;
}
