// Turn composer attachments (#579) into an AgentPromptInput the provider can
// consume. Images become base64 vision content blocks for providers that
// support them (Claude: jpeg/png/gif/webp); text files become inline excerpts;
// everything else (and images on non-vision providers) becomes a short text
// reference so the agent at least knows the file exists. Never throws — a
// fetch/decode failure degrades that one attachment to a reference line.
import type { AgentPromptContentBlock, AgentPromptInput } from "../agent/agent-sdk-types.js";
import { isPrivateAddress, readBodyCapped, secureFetch } from "./secure-fetch.js";

// Re-export so existing importers (and agent-attachments.test.ts) keep their
// entry point; the implementation now lives in the shared secure-fetch module.
export { isPrivateAddress };

// The attachment fields this module needs (a subset of the wire Attachment).
export interface PromptAttachment {
  name: string;
  type: string;
  size: number;
  url: string;
}

// Claude's supported inline image types (mirrors isImageMimeType in the
// provider). Other image types (heic, svg, …) fall through to a reference.
const SDK_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// Caps so one attachment can't blow up the prompt payload / context.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB per image
const MAX_TEXT_EXCERPT_BYTES = 256 * 1024; // 256KB of text inlined
const FETCH_TIMEOUT_MS = 15_000; // give up on a slow/stalled attachment fetch

export interface FetchedBytes {
  data: Buffer;
  contentType?: string;
}

export type FetchBytes = (url: string) => Promise<FetchedBytes>;

// SSRF guard (#618 → #598): the attachment URL is client-supplied, so the daemon
// must not be tricked into fetching internal services (cloud metadata at
// 169.254.169.254, localhost, RFC1918, link-local, ULA, CGNAT). The guard now
// lives in the shared `secureFetch` (https-only + literal-host block +
// DNS-resolution check + refuse-redirects + byte cap), which folds in this
// module's original DNS-resolution defense. data: URLs are inline (no network).
const ATTACHMENT_HOST_ALLOWLIST = (process.env.CYBORG7_ATTACHMENT_HOST_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s.length > 0);

// Default fetcher: data: URLs are parsed inline (no network); http(s) URLs go
// through secureFetch (https-only + DNS-resolution check + no redirects) and are
// streamed with a hard byte cap (a missing/spoofed content-length can't OOM the
// daemon — readBodyCapped stops past the cap), under a wall-clock timeout.
async function defaultFetchBytes(url: string, cap: number): Promise<FetchedBytes> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma === -1) throw new Error("malformed data URL");
    const meta = url.slice(5, comma); // e.g. "image/png;base64"
    const isBase64 = /;base64/i.test(meta);
    const contentType = meta.split(";")[0] || undefined;
    const payload = url.slice(comma + 1);
    const data = isBase64
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf-8");
    if (data.byteLength > cap) throw new Error("attachment exceeds size cap");
    return { data, contentType };
  }
  // https-only + DNS check + refuse-redirects (followRedirects defaults false, so
  // a 3xx throws — our S3/CloudFront assets answer 200 directly and a 3xx is the
  // classic post-DNS-check bypass to an internal target), timeout + declared-cap.
  const res = await secureFetch(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: cap,
    allowlist: ATTACHMENT_HOST_ALLOWLIST,
  });
  if (!res.ok) {
    // intentional: best-effort socket teardown — free the socket on a 4xx/5xx.
    res.body?.cancel().catch(() => {});
    throw new Error(`fetch failed: ${res.status}`);
  }
  // Stream-read enforcing the cap chunk-by-chunk — never trust content-length.
  const contentType = res.headers.get("content-type") ?? undefined;
  const data = await readBodyCapped(res, cap);
  return { data, contentType };
}

function isTextLike(att: PromptAttachment): boolean {
  if (att.type.startsWith("text/")) return true;
  if (att.type === "application/json" || att.type === "application/xml") return true;
  // Extension fallback for common code/log/config files served as octet-stream.
  return /\.(txt|md|log|json|ya?ml|toml|csv|tsv|ts|tsx|js|jsx|py|rs|go|java|rb|sh|c|h|cpp|css|html|sql|env|ini|conf)$/i.test(
    att.name,
  );
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function reference(att: PromptAttachment): string {
  // Name/type/size only — never the raw (possibly signed) URL.
  return `[Attached file: ${att.name} (${att.type || "unknown type"}, ${humanSize(att.size)})]`;
}

export interface BuildAgentPromptOptions {
  text: string;
  attachments?: PromptAttachment[];
  // Whether the target provider can render base64 image blocks (Claude today).
  supportsImageBlocks: boolean;
  // Injectable for tests; defaults to data:-URL parsing + global fetch.
  fetchBytes?: FetchBytes;
}

// Build the prompt the agent receives. With no attachments this returns the
// plain string (zero behavior change for text-only prompts).
export async function buildAgentPrompt(opts: BuildAgentPromptOptions): Promise<AgentPromptInput> {
  const { text, attachments, supportsImageBlocks } = opts;
  if (!attachments || attachments.length === 0) return text;

  const fetchImage: FetchBytes = opts.fetchBytes
    ? opts.fetchBytes
    : (url) => defaultFetchBytes(url, MAX_IMAGE_BYTES);
  const fetchText: FetchBytes = opts.fetchBytes
    ? opts.fetchBytes
    : (url) => defaultFetchBytes(url, MAX_TEXT_EXCERPT_BYTES);

  // ── Providers WITHOUT image support: collapse to a single string so every
  // provider (codex, pi, opencode) keeps working unchanged. Images become
  // references; text files become fenced excerpts. ──
  if (!supportsImageBlocks) {
    const parts: string[] = text ? [text] : [];
    for (const att of attachments) {
      if (isTextLike(att)) {
        try {
          const { data } = await fetchText(att.url);
          parts.push(`Attached file ${att.name}:\n\`\`\`\n${data.toString("utf-8")}\n\`\`\``);
        } catch {
          parts.push(reference(att));
        }
      } else {
        parts.push(reference(att));
      }
    }
    return parts.join("\n\n");
  }

  // ── Image-capable providers (Claude): structured content blocks. ──
  const blocks: AgentPromptContentBlock[] = [];
  if (text) blocks.push({ type: "text", text });
  for (const att of attachments) {
    if (SDK_IMAGE_MIME.has(att.type)) {
      try {
        const { data } = await fetchImage(att.url);
        blocks.push({ type: "image", data: data.toString("base64"), mimeType: att.type });
      } catch {
        blocks.push({ type: "text", text: reference(att) });
      }
    } else if (isTextLike(att)) {
      try {
        const { data } = await fetchText(att.url);
        blocks.push({
          type: "text",
          text: `Attached file ${att.name}:\n\`\`\`\n${data.toString("utf-8")}\n\`\`\``,
        });
      } catch {
        blocks.push({ type: "text", text: reference(att) });
      }
    } else {
      blocks.push({ type: "text", text: reference(att) });
    }
  }
  // Guard: never return an empty block array (the provider needs ≥1 block).
  if (blocks.length === 0) return text;
  return blocks;
}

// Derive the plain-text view of an AgentPromptInput — for the timeline
// user_message and for relay-forwarding the rawPrompt across daemons.
export function promptInputToText(input: AgentPromptInput): string {
  if (typeof input === "string") return input;
  const render = (b: AgentPromptContentBlock): string => {
    if (b.type === "text") return b.text;
    if (b.type === "image") return "[image]";
    return "";
  };
  return input
    .map(render)
    .filter((s) => s.length > 0)
    .join("\n\n");
}
