/**
 * Shared deep-link grammar for the Cyborg7 mobile shell.
 *
 * Pure, dependency-free string functions. They are the single source of truth
 * for two related concerns:
 *
 *  - `buildDeepLink` turns a (kind, workspace, target) tuple into the SvelteKit
 *    route a push tap / native deep link should navigate to.
 *  - `parseChatKey` turns a path (or full URL) back into a stable "chat key"
 *    used for foreground-suppression equality: the native layer compares the
 *    key of the currently-open WebView URL to the key derived from an incoming
 *    push URL, and suppresses the banner when they match (Caveat #2).
 *
 * This module deliberately mirrors the Swift parser another agent is writing
 * (`chatKey(forMobilePath:)` / `chatKey(forPushUrl:)`), so JS and Swift agree
 * on the exact grammar. The route shapes are the rewrite's
 * `/workspace/<ws>/channel|dm|agent/<id>` (NOT v1's `/client/...`), matching the
 * URL builders in `state/app.svelte.ts`.
 */

export type DeepLinkKind = "channel" | "dm_human" | "dm_agent" | "thread";

/**
 * Build the SvelteKit route a deep link / push tap should land on.
 *
 * - `channel`  → `/workspace/<ws>/channel/<id>`
 * - `dm_human` → `/workspace/<ws>/dm/<id>`     (peer user id)
 * - `dm_agent` → `/workspace/<ws>/agent/<id>`  (agent id)
 * - `thread`   → `/workspace/<ws>/threads`     (no per-thread route exists yet,
 *                so a thread push lands on the channel/dm host's threads list;
 *                callers that know the root channel should prefer `channel`)
 */
export function buildDeepLink(kind: DeepLinkKind, wsId: string, id: string): string {
  switch (kind) {
    case "channel":
      return `/workspace/${wsId}/channel/${id}`;
    case "dm_human":
      return `/workspace/${wsId}/dm/${id}`;
    case "dm_agent":
      return `/workspace/${wsId}/agent/${id}`;
    case "thread":
      // No per-thread route exists yet — fall back to the workspace threads list.
      return `/workspace/${wsId}/threads`;
  }
}

/**
 * Derive a stable chat key from a path or full URL, for foreground-suppression
 * equality. Returns `null` for anything that is not a concrete chat surface.
 *
 *  - `/workspace/<ws>/channel/<id>` → `channel:<id>`
 *  - `/workspace/<ws>/dm/<id>`      → `dm-human:<id>`
 *  - `/workspace/<ws>/agent/<id>`   → `dm-agent:<id>`
 *  - anything else (lists, threads, settings, …) → `null`
 *
 * Robust to a full URL (`https://app/…`) or a bare path, and to a trailing
 * query string and/or hash fragment. The key prefixes (`channel`, `dm-human`,
 * `dm-agent`) MUST stay in lockstep with the Swift parser.
 */
export function parseChatKey(path: string): string | null {
  if (!path) return null;

  // Accept a full URL or a bare path: pull out just the pathname. Using a
  // permissive base means a relative path still parses, and an absolute URL
  // (with its own origin) parses too. If anything is malformed, treat the raw
  // input as the path and strip query/hash manually below.
  let pathname = path;
  try {
    pathname = new URL(path, "http://x").pathname;
  } catch {
    // Strip a trailing `?query` and/or `#hash` from the raw string.
    pathname = path.split("#")[0].split("?")[0];
  }

  // Match the three concrete chat surfaces. The `<id>` segment stops at the
  // next slash so nested routes (e.g. `/channel/<id>/threads`) still key by the
  // host channel/dm/agent.
  const channel = pathname.match(/\/workspace\/[^/]+\/channel\/([^/?#]+)/);
  if (channel) return `channel:${decodeURIComponent(channel[1])}`;

  const dm = pathname.match(/\/workspace\/[^/]+\/dm\/([^/?#]+)/);
  if (dm) return `dm-human:${decodeURIComponent(dm[1])}`;

  const agent = pathname.match(/\/workspace\/[^/]+\/agent\/([^/?#]+)/);
  if (agent) return `dm-agent:${decodeURIComponent(agent[1])}`;

  return null;
}
