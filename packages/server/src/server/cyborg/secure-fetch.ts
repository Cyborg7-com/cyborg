// Shared SSRF-safe outbound fetch (#598, I3). The relay and daemon both make
// outbound HTTP requests with attacker-influenced URLs (message-link unfurling,
// composer-attachment fetches, and now outgoing-webhook deliveries). Each of
// those grew its OWN ad-hoc SSRF guard (unfurl.ts's isBlockedHost literal check;
// agent-attachments.ts's DNS-resolution check). This module folds BOTH into one
// audited helper so a single place defines "what is safe to fetch", and every
// caller — including new ones — inherits the strongest guard.
//
// Threat model (what a hostile URL must NOT be able to do):
//   - reach a non-http(s) scheme (file:, gopher:, etc.) — only https is allowed
//     by default; http is opt-in (allowHttp) for the two legacy unfurl callers.
//   - reach localhost / RFC1918 / link-local / ULA / CGNAT / cloud-metadata
//     (169.254.169.254) BY LITERAL (an IP or a well-known internal name), AND
//   - reach those same ranges via a PUBLIC hostname that RESOLVES to a private IP
//     (DNS-rebinding): we resolve the host AT SEND TIME and reject if ANY
//     resolved A/AAAA record is private. (Connection pinning to the vetted IP is
//     a further hardening we don't do here — Node's fetch has no per-request DNS
//     pin — but resolving immediately before the fetch shrinks the TOCTOU window
//     to ~milliseconds, and redirects are handled explicitly below.)
//   - bounce us to an internal target AFTER the resolution check, via a 3xx:
//     redirect is "manual". followRedirects:false (the default) throws on any
//     3xx; followRedirects:true re-runs the FULL guard (scheme + literal + DNS)
//     on each hop before following, capped at maxRedirects.
//   - exhaust the process: a wall-clock timeout aborts a slow/stalled request,
//     and a byte cap stream-enforced chunk-by-chunk (never trusting
//     content-length) stops an oversized body from OOMing us.
//   - optional env host allowlist (CYBORG7_SECURE_FETCH_HOST_ALLOWLIST):
//     comma-separated suffixes; when set, a host must match one or the fetch is
//     refused outright (callers may also pass their own allowlist).

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// ─── Reserved/private IP classification ──────────────────────────────────────
// Folds unfurl.ts's literal block and agent-attachments.ts's resolution block
// into one classifier covering the union of both (the agent-attachments set was
// the stricter superset: it also blocks CGNAT 100.64/10 and multicast/reserved
// 224/4+).

function isPrivateV4(addr: string): boolean {
  const p = addr.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → unsafe
  const [a, b] = p;
  if (a === 10 || a === 127 || a === 0) return true; // private / loopback / "this host"
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast 224/4 + reserved/Class E 240/4 + broadcast
  return false;
}

function isPrivateV6(addr: string): boolean {
  const v6 = addr.toLowerCase();
  if (v6 === "::1" || v6 === "::") return true; // loopback / unspecified
  if (/^fe[89ab]/.test(v6)) return true; // link-local fe80::/10 (fe80–febf)
  if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // unique-local fc00::/7
  // Embedded IPv4 (::ffff:a.b.c.d mapped OR ::a.b.c.d compatible) — re-check the v4.
  const mapped = v6.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return false;
}

/**
 * True when `addr` (an IP LITERAL) is in a reserved/private/loopback/link-local/
 * CGNAT/multicast range we must never fetch. A non-IP string is treated as
 * unsafe (the caller should pass real resolved addresses here).
 */
export function isPrivateAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) return isPrivateV4(addr);
  if (family === 6) return isPrivateV6(addr);
  return true; // not a recognizable IP literal → treat as unsafe
}

/**
 * Reject hostnames that would let a crafted URL reach internal/cloud-metadata
 * endpoints by LITERAL (an IP in a private range, or a well-known internal
 * name). Returns true when the host MUST NOT be fetched. This is the
 * literal/hostname check only — DNS-rebinding (a public name resolving to a
 * private IP) is caught separately by the resolution step in `secureFetch`.
 */
export function isBlockedHost(hostname: string): boolean {
  if (!hostname) return true;
  // Strip an IPv6 literal's brackets ("[::1]" → "::1").
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);

  // Well-known internal names.
  if (host === "localhost" || host === "ip6-localhost" || host === "ip6-loopback") return true;
  if (host.endsWith(".local") || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return true;
  }

  // An IP literal → classify it directly (isIP returns 0 for non-literals like
  // "example.com", which then fall through to the not-blocked return below).
  if (isIP(host) !== 0) return isPrivateAddress(host);

  return false;
}

// ─── Allowlist ───────────────────────────────────────────────────────────────

function envAllowlist(): string[] {
  return (process.env.CYBORG7_SECURE_FETCH_HOST_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

// A host passes an allowlist if it equals a suffix or is a subdomain of one
// (e.g. "api.github.com" passes "github.com"). An empty allowlist passes all.
function passesAllowlist(host: string, allow: string[]): boolean {
  if (allow.length === 0) return true;
  return allow.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

// ─── Errors ──────────────────────────────────────────────────────────────────

// A fetch refused by the SSRF guard (vs a network/HTTP failure). Callers that
// degrade gracefully (unfurl returns null; agent-attachments falls back to a
// reference line) can treat any throw uniformly, but the distinct name keeps
// guard rejections legible in logs.
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface SecureFetchOptions {
  /** Forwarded to fetch (method, headers, body, signal, …). `redirect` is
   *  always forced to "manual" — set followRedirects instead. */
  init?: RequestInit;
  /** Wall-clock budget for the WHOLE request (incl. redirect chain). Default 10s.
   *  Composed with any caller-supplied `init.signal` (whichever aborts first). */
  timeoutMs?: number;
  /** Hard cap on the response body, enforced chunk-by-chunk while reading (the
   *  Response is returned UNREAD — the cap is applied by readBodyCapped, or by
   *  the caller streaming res.body itself). When set, a declared content-length
   *  over the cap is rejected before reading. Default: no cap. */
  maxBytes?: number;
  /** false (default): a 3xx response throws (the attachment posture — our assets
   *  answer 200 directly, and a 3xx is the classic post-DNS-check bypass).
   *  true: follow up to maxRedirects hops, re-running the full guard on each. */
  followRedirects?: boolean;
  /** Max hops when followRedirects is true. Default 5. */
  maxRedirects?: number;
  /** Allow http:// in addition to https:// (the two legacy unfurl callers hit
   *  http-only endpoints). Default false → https only. */
  allowHttp?: boolean;
  /** Extra host-suffix allowlist, intersected with the env allowlist. */
  allowlist?: string[];
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;

// Headers that authenticate the request to the ORIGINAL host and must never be
// forwarded across an origin boundary on a redirect (else a 3xx to a third party
// leaks the caller's credentials). Matched case-insensitively. Beyond the fixed
// names we also drop any x-*-secret / x-*-signature auth header.
const SENSITIVE_HEADER_NAMES = new Set(["authorization", "cookie", "proxy-authorization"]);

function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (SENSITIVE_HEADER_NAMES.has(lower)) return true;
  // x-<anything>-secret / x-<anything>-signature (e.g. our X-Cyborg7-Signature).
  return /^x-.*-(secret|signature)$/.test(lower);
}

// Build a new init for the next hop, stripping sensitive headers when the
// redirect crosses to a different origin (scheme + host + port). Same-origin
// redirects keep the original headers untouched.
function initForRedirect(
  init: RequestInit | undefined,
  fromUrl: string,
  toUrl: string,
): RequestInit | undefined {
  if (!init?.headers) return init;
  let sameOrigin = false;
  try {
    sameOrigin = new URL(fromUrl).origin === new URL(toUrl).origin;
  } catch {
    sameOrigin = false; // unparseable → treat as cross-origin and strip
  }
  if (sameOrigin) return init;
  const headers = new Headers(init.headers);
  // Collect first, then delete — never mutate while iterating. Use Headers.forEach
  // (not .keys()): the server build's tsconfig.server.json omits the DOM.Iterable
  // lib, so the Headers iterator methods don't typecheck under `tsc` even though
  // tsgo accepts them.
  const toDelete: string[] = [];
  headers.forEach((_value, name) => {
    if (isSensitiveHeader(name)) toDelete.push(name);
  });
  for (const name of toDelete) headers.delete(name);
  return { ...init, headers };
}

// ─── Guard ───────────────────────────────────────────────────────────────────

// Validate a single URL: scheme + literal-host block + DNS-resolution check +
// allowlist. Throws SsrfBlockedError on any failure. Shared by the initial URL
// and every redirect hop.
async function assertSafeUrl(rawUrl: string, opts: SecureFetchOptions): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError("invalid URL");
  }
  const httpsOnly = opts.allowHttp !== true;
  if (parsed.protocol !== "https:" && (httpsOnly || parsed.protocol !== "http:")) {
    throw new SsrfBlockedError(httpsOnly ? "URL must be https" : "URL must be http(s)");
  }
  // Literal/well-known block (covers IP literals + localhost/*.local/etc).
  if (isBlockedHost(parsed.hostname)) {
    throw new SsrfBlockedError("host is private/reserved");
  }
  // URL.hostname keeps the brackets on an IPv6 literal ([::1]); dns.lookup needs
  // them stripped or it throws ENOTFOUND. Strip so literals + real names resolve.
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);

  const allow = [...envAllowlist(), ...(opts.allowlist ?? [])];
  if (!passesAllowlist(host, allow)) {
    throw new SsrfBlockedError("host not allowed");
  }

  // DNS-rebind defense: resolve and reject if ANY address is private. An IP
  // literal resolves to itself (isBlockedHost already passed it, so this is a
  // cheap re-confirm); a public name that maps to a private IP is caught here.
  const addrs = await lookup(host, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new SsrfBlockedError("host resolves to a private address");
  }
}

// Compose the caller's signal (if any) with our timeout into one signal, plus a
// cleanup that clears the timer and detaches the listener.
function buildSignal(opts: SecureFetchOptions): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const outer = opts.init?.signal ?? undefined;
  let onAbort: (() => void) | undefined;
  if (outer) {
    if (outer.aborted) controller.abort();
    else {
      onAbort = () => controller.abort();
      outer.addEventListener("abort", onAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (outer && onAbort) outer.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * SSRF-safe replacement for `fetch`. Validates the URL (and every redirect hop)
 * against the guard above, enforces a wall-clock timeout, optionally rejects or
 * follows redirects, and returns the Response with its body UNREAD (use
 * `readBodyCapped` to enforce a byte cap, or stream `res.body` yourself).
 *
 * Throws SsrfBlockedError when the guard refuses a URL/hop, or a generic Error
 * on network/HTTP-shape failures (timeout abort, declared length over the cap).
 * It never silently returns an unsafe Response.
 */
export async function secureFetch(url: string, opts: SecureFetchOptions = {}): Promise<Response> {
  const followRedirects = opts.followRedirects === true;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const { signal, cleanup } = buildSignal(opts);
  try {
    let current = url;
    // Per-hop init: starts as the caller's init and has its credential headers
    // stripped whenever a redirect crosses to a different origin (so we never
    // forward Authorization/Cookie/etc. to a third party we were bounced to).
    let init = opts.init;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      // assertSafeUrl re-runs the FULL guard (scheme + literal + DNS) on `current`
      // EVERY hop, so a redirect target must independently pass SSRF validation.
      await assertSafeUrl(current, opts);
      // redirect:"manual" — we re-validate each hop ourselves (followRedirects)
      // or reject the 3xx (default), never letting fetch follow blindly.
      const res = await fetch(current, { ...init, signal, redirect: "manual" });

      if (res.status >= 300 && res.status < 400) {
        if (!followRedirects) {
          // intentional: best-effort socket teardown — the thrown error is what matters.
          res.body?.cancel().catch(() => {});
          throw new SsrfBlockedError("URL must not redirect");
        }
        const location = res.headers.get("location");
        // Drain the redirect body so the socket can be reused/closed.
        // intentional: best-effort socket teardown — a failed cancel is harmless.
        res.body?.cancel().catch(() => {});
        if (!location) throw new SsrfBlockedError("redirect without a Location");
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          throw new SsrfBlockedError("malformed redirect Location");
        }
        // Strip credential headers if this hop changes origin BEFORE following.
        init = initForRedirect(init, current, next);
        current = next;
        continue;
      }

      // Non-redirect response. Enforce a declared-length cap up front (the
      // stream read in readBodyCapped is the real guard against a lying header).
      if (opts.maxBytes !== undefined) {
        const declared = Number(res.headers.get("content-length") ?? "0");
        if (Number.isFinite(declared) && declared > opts.maxBytes) {
          // intentional: best-effort socket teardown — the thrown error is what matters.
          res.body?.cancel().catch(() => {});
          throw new Error("response exceeds size cap");
        }
      }
      return res;
    }
    throw new SsrfBlockedError("too many redirects");
  } finally {
    cleanup();
  }
}

/**
 * Read a Response body as bytes, enforcing `maxBytes` chunk-by-chunk so a
 * missing/spoofed content-length can't OOM us. Throws when the body exceeds the
 * cap. Returns the raw bytes; the caller decodes as needed.
 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) throw new Error("no response body");
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      // intentional: best-effort reader teardown — the thrown error is what matters.
      await reader.cancel().catch(() => {});
      throw new Error("response exceeds size cap");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
