/**
 * Cross-context cache-invalidation hints via BroadcastChannel.
 *
 * Ported from v1 for completeness. On the single-WebView iOS shell there is
 * normally only one context, so this is effectively inert there — it's kept so
 * a future multi-window/desktop consumer can subscribe to "this scope changed,
 * re-read from IDB" without re-deriving the plumbing. No call here throws.
 *
 * Payloads are small structured records; never send actual message bodies.
 * Subscribers should treat every event as "go re-read", not "here's the data".
 */

export type CacheEvent =
  | { type: "scope:updated"; scopeKey: string }
  | { type: "scope:dropped"; scopeKey: string }
  | { type: "cache:cleared" };

const CHANNEL_NAME = "cyborg7-cache";

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (!channel) {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      return null;
    }
  }
  return channel;
}

export function broadcast(event: CacheEvent): void {
  const ch = getChannel();
  if (!ch) return;
  try {
    ch.postMessage(event);
  } catch {
    /* */
  }
}

export function subscribe(handler: (event: CacheEvent) => void): () => void {
  const ch = getChannel();
  if (!ch) return () => {};
  const wrapped = (e: MessageEvent<CacheEvent>) => {
    try {
      handler(e.data);
    } catch {
      /* */
    }
  };
  ch.addEventListener("message", wrapped);
  return () => ch.removeEventListener("message", wrapped);
}
