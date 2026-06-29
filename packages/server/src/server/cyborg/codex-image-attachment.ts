// Codex (and other providers) emit generated images as a markdown token
// `![alt](<os.tmpdir>/paseo-attachments/<uuid>.png)` inside an assistant message.
// The path is a LOCAL file on the daemon's disk — unreachable by the browser/relay
// in cloud mode — and the chat markdown renderer has no image rule, so the user
// just sees the literal text "!Image". This module recognises those tokens so the
// daemon can upload the file to S3 and turn it into a real chat attachment (which
// the existing ChatMessage attachment renderer shows), then strip the dead token.
//
// Detection recognises ANY local filesystem path with an image extension (Codex's
// native `paseo-attachments` images AND skill-generated ones, e.g. the `imagegen`
// skill, which write elsewhere under the OS temp dir). Real links `[x](y)`,
// http(s)/data URLs, and non-image files are left untouched. SECURITY is enforced
// downstream by buildAgentImageAttachments' `allowedDir` containment check (the
// file must resolve INSIDE the caller's allowed dir), NOT by a path substring here
// — a single, traversal-proof gate instead of two partial ones.

import { resolve as resolvePath, sep as pathSep } from "node:path";

// The persisted shape for an uploaded agent image (a subset of the
// messages.attachments jsonb columns the renderer reads). One canonical type,
// imported by the relay upload callback and the WorkspaceRelay flush.
export interface UploadedAgentImage {
  key: string;
  url: string;
  name: string;
  type: string;
  size: number;
}

// Cap on images captured from a single agent message (DoS guard); matches the
// standard per-message attachment limit used elsewhere.
const MAX_IMAGES_PER_MESSAGE = 10;

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;
// Markdown image token: ![alt](path). alt may be empty and may contain escaped
// `\]` (provider-image-output escapes it), so the alt group allows `\<char>`.
// path stops at the first ')'. Codex paths are tmp UUIDs and never contain ')'.
const MARKDOWN_IMAGE_RE = /!\[((?:[^\]\\]|\\.)*)\]\(([^)]+)\)/g;

// Wire shape for an image the daemon captured from an agent message and is
// shipping inline (base64) over the existing agent_stream broadcast, for the
// relay to upload to S3. Kept small + additive so older relays/daemons ignore it.
export interface AgentImageAttachment {
  /** base64-encoded image bytes (no data: prefix). */
  dataBase64: string;
  mimeType: string;
  filename: string;
  size: number;
  alt: string;
}

export interface LocalImageRef {
  /** Decoded alt text (defaults to "Image" upstream). */
  alt: string;
  /** Decoded local filesystem path to the image. */
  path: string;
  /** The exact `![alt](path)` token as it appears in the source text. */
  token: string;
  /** Lowercased extension without the dot, e.g. "png". */
  ext: string;
}

// provider-image-output.ts escapes `\` → `\\` and `]` → `\]` in alt, and `\` → `\\`
// and `)` → `\)` in the source. Reverse both so we recover the real path/alt.
function unescapeMarkdownAlt(value: string): string {
  return value.replace(/\\]/g, "]").replace(/\\\\/g, "\\");
}
function unescapeMarkdownSource(value: string): string {
  return value.replace(/\\\)/g, ")").replace(/\\\\/g, "\\");
}

function isRemoteOrDataUrl(path: string): boolean {
  const lower = path.toLowerCase();
  return /^[a-z][a-z0-9+.-]*:\/\//.test(lower) || lower.startsWith("data:");
}

/** MIME type for a recognised image extension (defaults to image/png). */
export function mimeForImageExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

/**
 * Find markdown image tokens that point at a LOCAL image file (any path with an
 * image extension; not http(s)/data URLs). Returns one entry per match (order
 * preserved). Capture safety (the file must live inside an allowed dir) is the
 * caller's job via buildAgentImageAttachments — this only recognises candidates.
 */
export function extractLocalImageRefs(text: string | null | undefined): LocalImageRef[] {
  const refs: LocalImageRef[] = [];
  if (!text) return refs;
  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) {
    const token = match[0];
    const rawAlt = match[1] ?? "";
    const rawPath = (match[2] ?? "").trim();
    if (!rawPath || isRemoteOrDataUrl(rawPath)) continue;
    const path = unescapeMarkdownSource(rawPath);
    const extMatch = path.match(IMAGE_EXT_RE);
    if (!extMatch) continue;
    refs.push({
      alt: unescapeMarkdownAlt(rawAlt) || "Image",
      path,
      token,
      ext: extMatch[1].toLowerCase(),
    });
  }
  return refs;
}

/**
 * Build inline image attachments from an assistant message's text: find local
 * image tokens, read each file (via the injected reader), and return the text
 * with those tokens stripped plus the captured images. IO is injected so this is
 * unit-testable without the filesystem. Best-effort per image — a read that
 * throws or a file outside [1, maxBytes] is skipped and its token left in place.
 */
export function buildAgentImageAttachments(
  text: string,
  opts: {
    readFile: (path: string) => Buffer;
    basename: (path: string) => string;
    maxBytes: number;
    // Absolute dir the image MUST resolve inside (the daemon's attachments tmp
    // dir). A second, stronger gate than the substring match in
    // extractLocalImageRefs: blocks `..` traversal (e.g. an agent emitting
    // `![x](/tmp/paseo-attachments/../../etc/secret.png)`) reading host files.
    allowedDir: string;
    onError?: (path: string, err: unknown) => void;
  },
): { text: string; imageAttachments: AgentImageAttachment[] } {
  const refs = extractLocalImageRefs(text);
  if (refs.length === 0) return { text, imageAttachments: [] };

  const containmentPrefix = opts.allowedDir.endsWith(pathSep)
    ? opts.allowedDir
    : opts.allowedDir + pathSep;
  const imageAttachments: AgentImageAttachment[] = [];
  const consumedTokens: string[] = [];
  for (const ref of refs) {
    // Cap captured images per message (matches the standard attachment limit) so
    // a message with many image tokens can't exhaust memory/bandwidth.
    if (imageAttachments.length >= MAX_IMAGES_PER_MESSAGE) break;
    const resolved = resolvePath(ref.path);
    if (!resolved.startsWith(containmentPrefix)) {
      opts.onError?.(ref.path, new Error("image path escapes the attachments dir"));
      continue;
    }
    try {
      const buf = opts.readFile(resolved);
      if (buf.length === 0 || buf.length > opts.maxBytes) continue;
      imageAttachments.push({
        dataBase64: buf.toString("base64"),
        mimeType: mimeForImageExt(ref.ext),
        filename: opts.basename(ref.path),
        size: buf.length,
        alt: ref.alt,
      });
      consumedTokens.push(ref.token);
    } catch (err) {
      opts.onError?.(ref.path, err);
    }
  }
  if (imageAttachments.length === 0) return { text, imageAttachments: [] };
  return { text: stripImageTokens(text, consumedTokens), imageAttachments };
}

/**
 * Remove the given image tokens from text and tidy the whitespace they leave
 * behind (so a message that was ONLY an image becomes empty rather than blank
 * lines). Tokens not present are ignored.
 */
export function stripImageTokens(text: string, tokens: string[]): string {
  let out = text;
  for (const token of tokens) {
    out = out.split(token).join("");
  }
  // Collapse the blank lines / trailing separators a removed image leaves behind.
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "");
}

// A local image the daemon should upload to S3 and then REWRITE IN PLACE (vs
// strip): keeps the `![alt](path)` token's position so, once uploaded, the token
// becomes `![alt](s3Url)` and renders inline wherever the text is shown — the
// session transcript (AgentStreamView) AND any channel/DM message. Unlike
// buildAgentImageAttachments (which strips the token and ships the bytes to be
// re-attached as a separate message), this is the in-transcript path.
export interface PendingImageUpload {
  /** The exact `![alt](path)` token as it appears in the source text. */
  token: string;
  /** Decoded local filesystem path to the image. */
  path: string;
  /** Decoded alt text. */
  alt: string;
  /** base64-encoded image bytes (no data: prefix). */
  dataBase64: string;
  mimeType: string;
  filename: string;
  size: number;
}

// Detect local image tokens and read their bytes (same containment + size gates
// as buildAgentImageAttachments) WITHOUT stripping — the caller uploads each to
// S3 and rewrites the token to the returned URL. Returns [] when there's nothing
// to upload (no tokens, none readable, all escape the allowed dir).
export function prepareAgentImageUploads(
  text: string,
  opts: {
    readFile: (path: string) => Buffer;
    basename: (path: string) => string;
    maxBytes: number;
    allowedDir: string;
    onError?: (path: string, err: unknown) => void;
  },
): PendingImageUpload[] {
  const refs = extractLocalImageRefs(text);
  if (refs.length === 0) return [];
  const containmentPrefix = opts.allowedDir.endsWith(pathSep)
    ? opts.allowedDir
    : opts.allowedDir + pathSep;
  const uploads: PendingImageUpload[] = [];
  for (const ref of refs) {
    if (uploads.length >= MAX_IMAGES_PER_MESSAGE) break;
    const resolved = resolvePath(ref.path);
    if (!resolved.startsWith(containmentPrefix)) {
      opts.onError?.(ref.path, new Error("image path escapes the attachments dir"));
      continue;
    }
    try {
      const buf = opts.readFile(resolved);
      if (buf.length === 0 || buf.length > opts.maxBytes) continue;
      uploads.push({
        token: ref.token,
        path: ref.path,
        alt: ref.alt,
        dataBase64: buf.toString("base64"),
        mimeType: mimeForImageExt(ref.ext),
        filename: opts.basename(ref.path),
        size: buf.length,
      });
    } catch (err) {
      opts.onError?.(ref.path, err);
    }
  }
  return uploads;
}
