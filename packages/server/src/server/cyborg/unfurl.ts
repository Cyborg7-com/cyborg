/* oxlint-disable complexity, no-nested-ternary */
/**
 * URL unfurling — platform-aware link previews.
 *
 * Strategy:
 *   1. Classify the URL (X/Twitter, YouTube, Vimeo, GitHub, image, generic)
 *   2. Use platform-specific APIs for rich data (tweet text + media, PR status,
 *      video channel, etc.)
 *   3. Fall back to generic Open Graph / Twitter Card / HTML meta parsing
 *
 * Ported from cyborg7-core v1 (`src/lib/unfurl.ts`), framework-agnostic, uses
 * `fetch`. Results are cached in memory for 24h. This runs server-side only.
 *
 * SSRF hardening: every outbound fetch passes through the shared `secureFetch`
 * (see ./secure-fetch.ts), which rejects non-http(s) schemes, localhost/*.local,
 * IP literals in private/loopback/link-local ranges (incl. 169.254.169.254 cloud
 * metadata), AND — folding in the DNS-resolution defense from agent-attachments —
 * a public hostname that RESOLVES to a private IP (DNS-rebinding). Redirects are
 * re-validated hop-by-hop. `isBlockedHost`/`ssrfSafeFetch` are re-exported from
 * `secure-fetch` for back-compat with this file's existing callers + tests.
 */

import { isBlockedHost, secureFetch, SecureFetchOptions } from "./secure-fetch.js";

// Re-export so existing importers (and unfurl.test.ts) keep their entry points.
export { isBlockedHost };

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+(?<![.,!?;:])/g;
const TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i;

export type UnfurlPlatform = "x" | "youtube" | "vimeo" | "github" | "generic";

export interface UnfurlMedia {
  url: string;
  type: "image" | "video" | "gif";
  width?: number;
  height?: number;
  thumbnail?: string;
}

export interface UnfurlAuthor {
  name?: string;
  handle?: string;
  url?: string;
  avatar?: string;
}

export interface UnfurlGithub {
  kind: "repo" | "pr" | "issue";
  state?: "open" | "closed" | "merged" | "draft";
  number?: number;
  stars?: number;
  language?: string;
  owner?: string;
  repo?: string;
  comments?: number;
}

export interface Unfurl {
  url: string;
  platform?: UnfurlPlatform;
  title?: string;
  description?: string;
  image?: string;
  imageWidth?: number;
  imageHeight?: number;
  siteName?: string;
  favicon?: string;
  type?: "link" | "image" | "video";
  author?: UnfurlAuthor;
  media?: UnfurlMedia[];
  github?: UnfurlGithub;
  publishedAt?: string;
}

// In-memory cache (good enough for single-instance; Redis optional)
const cache = new Map<string, { data: Unfurl | null; ts: number }>();

/** Extract URLs from message text. */
export function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX);
  if (!matches) return [];
  return [...new Set(matches)].slice(0, 5);
}

/* ─────────────────────────────── SSRF guard ─────────────────────────────── */

// The guard now lives in ./secure-fetch.ts (isBlockedHost re-exported above).
// `isFetchableUrl` is the cheap synchronous pre-check (scheme + literal host)
// used by the orchestrator before dispatching a platform strategy; the
// authoritative async check (incl. DNS resolution + per-hop redirect re-check)
// runs inside secureFetch on every actual request.
function isFetchableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (isBlockedHost(u.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

/* ─────────────────────────────── Classification ─────────────────────────────── */

function classifyUrl(url: string): {
  platform: UnfurlPlatform;
  type: "link" | "image" | "video";
} {
  if (IMAGE_EXTENSIONS.test(url)) return { platform: "generic", type: "image" };
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host === "x.com" || host === "twitter.com" || host === "mobile.twitter.com") {
      return { platform: "x", type: "link" };
    }
    if (host === "youtube.com" || host === "youtu.be" || host.endsWith(".youtube.com")) {
      return { platform: "youtube", type: "video" };
    }
    if (host === "vimeo.com" || host.endsWith(".vimeo.com")) {
      return { platform: "vimeo", type: "video" };
    }
    if (host === "github.com") return { platform: "github", type: "link" };
  } catch {
    /* invalid URL */
  }
  return { platform: "generic", type: "link" };
}

/* ─────────────────────────────── HTML meta parsing ─────────────────────────────── */

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function parseMeta(html: string, url: string): Omit<Unfurl, "url" | "type" | "platform"> {
  const get = (pattern: RegExp): string | undefined => {
    const match = html.match(pattern);
    return match?.[1] ? decodeEntities(match[1].trim()) : undefined;
  };

  const ogTitle =
    get(/<meta\s+(?:property|name)=["']og:title["']\s+content=["']([^"']+)["']/i) ??
    get(/<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["']og:title["']/i);
  const ogDesc =
    get(/<meta\s+(?:property|name)=["']og:description["']\s+content=["']([^"']+)["']/i) ??
    get(/<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["']og:description["']/i);
  const ogImage =
    get(/<meta\s+(?:property|name)=["']og:image["']\s+content=["']([^"']+)["']/i) ??
    get(/<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["']og:image["']/i);
  const ogSiteName =
    get(/<meta\s+(?:property|name)=["']og:site_name["']\s+content=["']([^"']+)["']/i) ??
    get(/<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["']og:site_name["']/i);

  const twTitle = get(
    /<meta\s+(?:property|name)=["']twitter:title["']\s+content=["']([^"']+)["']/i,
  );
  const twDesc = get(
    /<meta\s+(?:property|name)=["']twitter:description["']\s+content=["']([^"']+)["']/i,
  );
  const twImage = get(
    /<meta\s+(?:property|name)=["']twitter:image["']\s+content=["']([^"']+)["']/i,
  );

  const htmlTitle = get(/<title[^>]*>([^<]+)<\/title>/i);
  const metaDesc = get(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);

  const faviconHref =
    get(/<link\s+[^>]*rel=["'](?:icon|shortcut icon)["'][^>]*href=["']([^"']+)["']/i) ??
    get(/<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["'](?:icon|shortcut icon)["']/i);

  let favicon: string | undefined;
  if (faviconHref) {
    try {
      favicon = new URL(faviconHref, url).href;
    } catch {
      favicon = faviconHref;
    }
  } else {
    try {
      favicon = `${new URL(url).origin}/favicon.ico`;
    } catch {
      /* */
    }
  }

  let image = ogImage ?? twImage;
  if (image && !image.startsWith("http")) {
    try {
      image = new URL(image, url).href;
    } catch {
      /* */
    }
  }

  return {
    title: ogTitle ?? twTitle ?? htmlTitle,
    description: ogDesc ?? twDesc ?? metaDesc,
    image,
    siteName: ogSiteName,
    favicon,
  };
}

// Shared options for unfurl's outbound fetches: http(s) allowed (some unfurl
// targets are http-only), follow redirects (re-validated per hop inside
// secureFetch), one timeout budget across the chain, 5MB cap.
const UNFURL_FETCH_OPTS: Omit<SecureFetchOptions, "init"> = {
  followRedirects: true,
  allowHttp: true,
  timeoutMs: TIMEOUT_MS,
  maxBytes: MAX_BODY_BYTES,
};

// SSRF-safe fetch for unfurling. Thin wrapper over the shared `secureFetch` that
// preserves this module's "return null on any failure (incl. a refused/blocked
// URL or redirect)" contract. secureFetch re-validates EVERY redirect hop
// (scheme + literal-host block + DNS-resolution) so a public URL that
// 3xx-redirects to a private/metadata target is refused instead of followed.
export async function ssrfSafeFetch(
  initialUrl: string,
  init: RequestInit,
): Promise<Response | null> {
  try {
    return await secureFetch(initialUrl, { ...UNFURL_FETCH_OPTS, init });
  } catch {
    return null; // blocked URL/hop, timeout, oversized, or network failure
  }
}

/** Fetch a URL with timeout + size limit. Returns HTML body or null. */
async function fetchHtml(url: string, headers?: Record<string, string>): Promise<string | null> {
  const res = await ssrfSafeFetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; Cyborg7Bot/1.0; +https://cyborg7.com)",
      Accept: "text/html,application/xhtml+xml",
      ...headers,
    },
  });
  if (!res || !res.ok) return null;

  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("text/html") && !ct.includes("application/xhtml")) return null;

  const reader = res.body?.getReader();
  if (!reader) return null;
  try {
    let body = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        reader.cancel();
        break;
      }
      body += decoder.decode(value, { stream: true });
      if (body.includes("</head>")) break;
    }
    // intentional: best-effort reader teardown — body already captured.
    reader.cancel().catch(() => {});
    return body;
  } catch {
    return null;
  }
}

async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T | null> {
  const res = await ssrfSafeFetch(url, {
    headers: { "User-Agent": "Cyborg7Bot/1.0", Accept: "application/json", ...headers },
  });
  if (!res || !res.ok) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/* ─────────────────────────────── Twitter / X ─────────────────────────────── */

function getTweetId(url: string): string | null {
  try {
    const m = new URL(url).pathname.match(/\/status(?:es)?\/(\d+)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Token algorithm used by the public syndication endpoint. */
function getSyndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

interface SyndicationTweet {
  text?: string;
  created_at?: string;
  user?: { name?: string; screen_name?: string; profile_image_url_https?: string };
  mediaDetails?: Array<{
    type?: "photo" | "video" | "animated_gif";
    media_url_https?: string;
    original_info?: { width?: number; height?: number };
    video_info?: { variants?: Array<{ content_type?: string; url?: string; bitrate?: number }> };
  }>;
  photos?: Array<{ url: string; width?: number; height?: number }>;
  video?: { poster?: string; variants?: Array<{ type?: string; src?: string }> };
  entities?: {
    urls?: Array<{ expanded_url?: string; display_url?: string; indices?: [number, number] }>;
  };
  display_text_range?: [number, number];
}

// "Name (@handle) on X" / "Name on X" / "Post on X" — shared by the syndication
// and oembed branches below.
function buildXTitle(authorName: string | undefined, handle: string | undefined): string {
  if (authorName && handle) return `${authorName} (@${handle}) on X`;
  if (authorName) return `${authorName} on X`;
  return "Post on X";
}

// Map the syndication API's mediaDetails to our UnfurlMedia shape (photos +
// best-bitrate mp4 for video/gif).
function parseSyndicationMedia(details: SyndicationTweet["mediaDetails"]): UnfurlMedia[] {
  const media: UnfurlMedia[] = [];
  for (const m of details ?? []) {
    if (m.type === "photo" && m.media_url_https) {
      media.push({
        url: m.media_url_https,
        type: "image",
        width: m.original_info?.width,
        height: m.original_info?.height,
      });
    } else if ((m.type === "video" || m.type === "animated_gif") && m.video_info?.variants) {
      const best = m.video_info.variants
        .filter((v) => v.content_type === "video/mp4")
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
      if (best?.url) {
        media.push({
          url: best.url,
          type: m.type === "animated_gif" ? "gif" : "video",
          width: m.original_info?.width,
          height: m.original_info?.height,
          thumbnail: m.media_url_https,
        });
      }
    }
  }
  return media;
}

async function fetchTwitterUnfurl(url: string): Promise<Unfurl | null> {
  const tweetId = getTweetId(url);
  if (!tweetId) return null;

  // Preferred: syndication API — returns media, author, full text.
  const token = getSyndicationToken(tweetId);
  const syn = await fetchJson<SyndicationTweet>(
    `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${token}&lang=en`,
  );

  if (syn && (syn.text || syn.user)) {
    const media = parseSyndicationMedia(syn.mediaDetails);

    // Strip trailing t.co media link from the text (syndication leaves it in).
    let text = syn.text ?? "";
    text = text.replace(/\s+https:\/\/t\.co\/\w+\s*$/u, "").trim();

    const authorName = syn.user?.name;
    const handle = syn.user?.screen_name;
    const title = buildXTitle(authorName, handle);

    const primaryImage =
      media.find((m) => m.type === "image" || m.type === "gif")?.url ??
      media.find((m) => m.type === "video")?.thumbnail;

    return {
      url,
      platform: "x",
      type: "link",
      title,
      description: text || undefined,
      image: primaryImage,
      siteName: "X (Twitter)",
      favicon: "https://abs.twimg.com/favicons/twitter.ico",
      author: {
        name: authorName,
        handle: handle ? `@${handle}` : undefined,
        url: handle ? `https://x.com/${handle}` : undefined,
        avatar: syn.user?.profile_image_url_https,
      },
      media,
      publishedAt: syn.created_at,
    };
  }

  // Fallback: oEmbed (no media, but proper author).
  const oembed = await fetchJson<{ author_name?: string; author_url?: string; html?: string }>(
    `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true&dnt=true`,
  );
  if (oembed?.html) {
    const pMatch = oembed.html.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const raw = pMatch?.[1] ?? "";
    const text = decodeEntities(
      raw
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi, "$2")
        .replace(/<[^>]+>/g, ""),
    ).trim();
    const handle =
      oembed.author_url?.match(/twitter\.com\/([^/]+)/)?.[1] ??
      oembed.author_url?.match(/x\.com\/([^/]+)/)?.[1];
    const title = buildXTitle(oembed.author_name, handle);
    return {
      url,
      platform: "x",
      type: "link",
      title,
      description: text || undefined,
      siteName: "X (Twitter)",
      favicon: "https://abs.twimg.com/favicons/twitter.ico",
      author: {
        name: oembed.author_name,
        handle: handle ? `@${handle}` : undefined,
        url: oembed.author_url,
      },
    };
  }

  return null;
}

/* ─────────────────────────────── YouTube / Vimeo ─────────────────────────────── */

function getYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be" || u.hostname.endsWith(".youtu.be")) return u.pathname.slice(1);
    if (u.hostname.includes("youtube.com")) {
      if (u.pathname.startsWith("/watch")) return u.searchParams.get("v");
      if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] ?? null;
      if (u.pathname.startsWith("/embed/")) return u.pathname.split("/")[2] ?? null;
    }
  } catch {
    /* */
  }
  return null;
}

async function fetchYouTubeUnfurl(url: string): Promise<Unfurl | null> {
  const ytId = getYouTubeId(url);
  const oembed = await fetchJson<{
    title?: string;
    author_name?: string;
    author_url?: string;
    thumbnail_url?: string;
  }>(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
  const thumb = ytId
    ? `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg`
    : oembed?.thumbnail_url;

  if (!oembed && !ytId) return null;

  return {
    url,
    platform: "youtube",
    type: "video",
    title: oembed?.title ?? "YouTube Video",
    description: oembed?.author_name ? `on ${oembed.author_name}` : undefined,
    image: thumb,
    siteName: "YouTube",
    favicon: "https://www.youtube.com/favicon.ico",
    author: {
      name: oembed?.author_name,
      url: oembed?.author_url,
    },
  };
}

async function fetchVimeoUnfurl(url: string): Promise<Unfurl | null> {
  const oembed = await fetchJson<{
    title?: string;
    author_name?: string;
    author_url?: string;
    thumbnail_url?: string;
    description?: string;
  }>(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`);
  if (!oembed) return null;
  return {
    url,
    platform: "vimeo",
    type: "video",
    title: oembed.title ?? "Vimeo Video",
    description: oembed.description?.replace(/<[^>]+>/g, "").trim(),
    image: oembed.thumbnail_url,
    siteName: "Vimeo",
    favicon: "https://vimeo.com/favicon.ico",
    author: { name: oembed.author_name, url: oembed.author_url },
  };
}

/* ─────────────────────────────── GitHub ─────────────────────────────── */

interface GithubRepo {
  name?: string;
  full_name?: string;
  description?: string;
  stargazers_count?: number;
  language?: string;
  owner?: { login?: string; avatar_url?: string };
  html_url?: string;
  open_issues_count?: number;
}
interface GithubIssue {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  number?: number;
  user?: { login?: string; avatar_url?: string };
  comments?: number;
  pull_request?: unknown;
  html_url?: string;
  draft?: boolean;
  merged_at?: string | null;
}
interface GithubPull extends GithubIssue {
  merged?: boolean;
  draft?: boolean;
}

function parseGithubUrl(
  url: string,
): { owner: string; repo: string; kind: "repo" | "pr" | "issue"; number?: number } | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "github.com") return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, repo, section, num] = parts;
    if (section === "pull" && num) return { owner, repo, kind: "pr", number: Number(num) };
    if (section === "issues" && num) return { owner, repo, kind: "issue", number: Number(num) };
    if (!section) return { owner, repo, kind: "repo" };
    return null;
  } catch {
    return null;
  }
}

// Issue/PR display state. draft takes precedence over merged (matching the
// original override order), then the raw open/closed from the API.
function githubItemState(kind: "repo" | "pr" | "issue", item: GithubPull): UnfurlGithub["state"] {
  if (kind === "pr" && item.draft) return "draft";
  if (kind === "pr" && item.merged) return "merged";
  return item.state === "open" ? "open" : "closed";
}

async function fetchGithubUnfurl(url: string): Promise<Unfurl | null> {
  const parsed = parseGithubUrl(url);
  if (!parsed) return null;

  const authHeaders: Record<string, string> = process.env.GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {};

  if (parsed.kind === "repo") {
    const repo = await fetchJson<GithubRepo>(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`,
      authHeaders,
    );
    if (!repo) return null;
    return {
      url,
      platform: "github",
      type: "link",
      title: repo.full_name ?? `${parsed.owner}/${parsed.repo}`,
      description: repo.description ?? undefined,
      image: `https://opengraph.githubassets.com/1/${parsed.owner}/${parsed.repo}`,
      siteName: "GitHub",
      favicon: "https://github.com/favicon.ico",
      author: {
        name: repo.owner?.login,
        avatar: repo.owner?.avatar_url,
        url: repo.owner?.login ? `https://github.com/${repo.owner.login}` : undefined,
      },
      github: {
        kind: "repo",
        owner: parsed.owner,
        repo: parsed.repo,
        stars: repo.stargazers_count,
        language: repo.language ?? undefined,
      },
    };
  }

  const endpoint = parsed.kind === "pr" ? "pulls" : "issues";
  const item = await fetchJson<GithubPull>(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/${endpoint}/${parsed.number}`,
    authHeaders,
  );
  if (!item) return null;

  const state = githubItemState(parsed.kind, item);

  const body = item.body
    ?.slice(0, 400)
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  return {
    url,
    platform: "github",
    type: "link",
    title: `${parsed.owner}/${parsed.repo}#${parsed.number}: ${item.title ?? ""}`.trim(),
    description: body || undefined,
    image: `https://opengraph.githubassets.com/1/${parsed.owner}/${parsed.repo}/${parsed.kind === "pr" ? "pull" : "issues"}/${parsed.number}`,
    siteName: "GitHub",
    favicon: "https://github.com/favicon.ico",
    author: {
      name: item.user?.login,
      handle: item.user?.login ? `@${item.user.login}` : undefined,
      avatar: item.user?.avatar_url,
      url: item.user?.login ? `https://github.com/${item.user.login}` : undefined,
    },
    github: {
      kind: parsed.kind,
      owner: parsed.owner,
      repo: parsed.repo,
      number: parsed.number,
      state,
      comments: item.comments,
    },
  };
}

/* ─────────────────────────────── Generic OG fallback ─────────────────────────────── */

async function fetchGenericUnfurl(
  url: string,
  classification: { type: "link" | "image" | "video" },
): Promise<Unfurl | null> {
  if (classification.type === "image") {
    return {
      url,
      platform: "generic",
      type: "image",
      title: url.split("/").pop()?.split("?")[0],
      image: url,
    };
  }

  const body = await fetchHtml(url);
  if (!body) return null;
  const meta = parseMeta(body, url);
  if (!meta.title && !meta.description && !meta.image) return null;

  return {
    url,
    platform: "generic",
    type: classification.type,
    ...meta,
  };
}

/* ─────────────────────────────── Orchestration ─────────────────────────────── */

async function fetchUnfurl(url: string): Promise<Unfurl | null> {
  // SSRF gate: reject non-http(s) and private/loopback/link-local targets before
  // any platform strategy runs (each fetch helper re-checks too, defense in depth).
  if (!isFetchableUrl(url)) return null;

  const classification = classifyUrl(url);

  try {
    switch (classification.platform) {
      case "x": {
        const x = await fetchTwitterUnfurl(url);
        if (x) return x;
        break;
      }
      case "youtube": {
        const yt = await fetchYouTubeUnfurl(url);
        if (yt) return yt;
        break;
      }
      case "vimeo": {
        const v = await fetchVimeoUnfurl(url);
        if (v) return v;
        break;
      }
      case "github": {
        const gh = await fetchGithubUnfurl(url);
        if (gh) return gh;
        break;
      }
    }
  } catch {
    /* fall through to generic */
  }

  return fetchGenericUnfurl(url, classification);
}

/** Unfurl URLs from message text (with caching). Call server-side only. */
export async function unfurlUrls(text: string): Promise<Unfurl[]> {
  const urls = extractUrls(text);
  if (urls.length === 0) return [];

  const results: Unfurl[] = [];

  // Process up to 3 URLs in parallel
  const jobs = urls.slice(0, 3).map(async (url) => {
    const cached = cache.get(url);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;
    const data = await fetchUnfurl(url);
    // Only cache SUCCESSFUL fetches. A transient failure (network blip,
    // rate limit, slow response > TIMEOUT_MS) would otherwise be pinned
    // in cache for 24 h and turn every retry into an instant empty
    // result. Failed fetches need to retry on the next message.
    if (data) cache.set(url, { data, ts: Date.now() });
    return data;
  });
  const settled = await Promise.all(jobs);
  for (const d of settled) if (d) results.push(d);

  if (cache.size > 1000) {
    const now = Date.now();
    for (const [key, val] of cache) {
      if (now - val.ts > CACHE_TTL_MS) cache.delete(key);
    }
  }

  return results;
}
