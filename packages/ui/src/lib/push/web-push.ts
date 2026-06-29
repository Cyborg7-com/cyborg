/**
 * Browser-side Web Push helper. Hooks the user's notification-permission grant
 * up to a real push subscription stored on the relay.
 *
 * Flow:
 *   1. Wait for the SvelteKit-registered service worker to be ready.
 *   2. Fetch the VAPID public key over the WS RPC (cyborg:get_vapid_key).
 *   3. pushManager.subscribe({ applicationServerKey }) — browser computes keys.
 *   4. Send the subscription to the relay (cyborg:push_subscribe), which the
 *      dispatcher targets on the next message to an offline recipient.
 *
 * Idempotent: re-running with an existing subscription reads it back and
 * re-sends to the relay (upsert on endpoint), so it's safe to call on every
 * connect.
 */

import { base } from "$app/paths";
import { client } from "$lib/state/client.js";

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  // Allocate over a concrete ArrayBuffer so the result satisfies BufferSource
  // for pushManager.subscribe's applicationServerKey under TS 6.
  const buffer = new ArrayBuffer(raw.length);
  const arr = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    // Web Push needs a secure http(s) origin. Under Electron (`cyborg://app`)
    // service worker registration is unsupported and throws — Electron uses
    // native OS notifications instead, so treat push as unsupported there.
    (location.protocol === "https:" || location.protocol === "http:") &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

// Register the push service worker manually (SvelteKit auto-registration is
// disabled in svelte.config.js so it can't crash under cyborg://). Safe to call
// repeatedly — register() is idempotent per scope. Returns the ready
// registration, or null if registration isn't possible on this origin.
async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  try {
    await navigator.serviceWorker.register(`${base}/service-worker.js`);
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

/**
 * Ensure a push subscription exists and is registered with the relay.
 * Only acts when permission is already granted — safe to call on every connect.
 * Returns true on success.
 */
export async function ensureWebPushSubscription(): Promise<boolean> {
  if (!isPushSupported() || Notification.permission !== "granted") return false;

  const registration = await ensureServiceWorker();
  if (!registration) return false;

  let sub = await registration.pushManager.getSubscription();
  if (!sub) {
    let publicKey: string | null;
    try {
      publicKey = await client.getVapidKey();
    } catch {
      return false;
    }
    if (!publicKey) return false; // relay has no VAPID configured
    try {
      sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    } catch {
      return false;
    }
  }

  try {
    const json = sub.toJSON() as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;
    await client.pushSubscribe({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      userAgent: navigator.userAgent,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Request permission (if needed) then subscribe. Used by the settings toggle.
 * Returns the resulting permission state.
 */
export async function enableWebPush(): Promise<NotificationPermission> {
  if (!isPushSupported()) return "denied";
  let permission = Notification.permission;
  if (permission === "default") {
    permission = await Notification.requestPermission();
  }
  if (permission === "granted") {
    await ensureWebPushSubscription();
  }
  return permission;
}

/** Drop the local subscription and tell the relay to forget it. */
export async function disableWebPush(): Promise<void> {
  if (!isPushSupported()) return;
  try {
    // getRegistration (not .ready) — .ready never resolves if no SW was ever
    // registered, which would hang this call now that auto-registration is off.
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return;
    const sub = await registration.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    // best-effort teardown — attempt BOTH the browser unsubscribe and the relay
    // forget even if the first fails, so each is caught independently below.
    await sub.unsubscribe().catch(() => {}); // intentional: best-effort teardown
    await client.pushUnsubscribe(endpoint).catch(() => {}); // intentional: best-effort teardown
  } catch {
    // intentional: disabling push is best-effort teardown; a transient failure
    // just means the relay prunes the stale subscription on its next delivery.
  }
}
