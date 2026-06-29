/**
 * Web Push transport (VAPID + service worker).
 *
 * Ported from the original cyborg7-core Next.js app. The relay configures
 * VAPID from env, exposes the public key to clients (which subscribe via the
 * browser PushManager), and signs/sends encrypted payloads to each stored
 * subscription. The client service worker decodes the JSON and shows the
 * OS notification.
 *
 * Disabled gracefully when VAPID env vars are absent — the relay still runs,
 * push is simply a no-op and the client's "Enable" toggle reports unsupported.
 */

import webpush from "web-push";

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
  // iOS app-icon badge count (set into aps.badge on the FCM/APNs send). Computed
  // per-recipient at dispatch time from their total unread activity count across
  // all workspaces (iOS shows one badge per app). Web push ignores it. Absent
  // when not applicable (e.g. web-only payloads) → no badge mutation on device.
  badgeCount?: number;
}

export type WebPushResult = "ok" | "gone" | "transient" | "config";

let configured = false;
let publicKey: string | null = null;

export function initWebPush(): boolean {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:support@cyborg7.com";
  if (!pub || !priv) {
    console.log("[push] VAPID not configured — web push disabled");
    return false;
  }
  webpush.setVapidDetails(subject, pub, priv);
  configured = true;
  publicKey = pub;
  console.log("[push] Web Push (VAPID) configured");
  return true;
}

export function isWebPushConfigured(): boolean {
  return configured;
}

export function vapidPublicKey(): string | null {
  return publicKey;
}

export async function sendWebPush(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: PushPayload,
): Promise<WebPushResult> {
  if (!configured) return "config";
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      // TTL 60s: if the device is offline longer, drop the push. A stale
      // "you got a message hours ago" banner is worse than none; the user
      // catches up in-app on reconnect.
      { TTL: 60 },
    );
    return "ok";
  } catch (err) {
    const status = (err as { statusCode?: number } | null | undefined)?.statusCode;
    if (status === 404 || status === 410) return "gone";
    return "transient";
  }
}
