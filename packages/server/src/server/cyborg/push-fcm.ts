/**
 * Firebase Cloud Messaging — HTTP v1 transport (native mobile push).
 *
 * Ported from the original cyborg7-core app. Uses an OAuth2 access token derived
 * from the Firebase service-account JSON (env `FCM_SERVICE_ACCOUNT_JSON`) to call
 * the per-token endpoint:
 *   POST https://fcm.googleapis.com/v1/projects/<project>/messages:send
 *
 * One code path serves Android and iOS (iOS routes through FCM-over-APNs). The
 * relay calls sendFcm() alongside sendWebPush() for offline recipients; dead
 * tokens (UNREGISTERED / 404 / 403) return "gone" so the dispatcher prunes them.
 *
 * Disabled gracefully when FCM_SERVICE_ACCOUNT_JSON is absent — push is a no-op
 * and the relay still runs. Mirrors push.ts (VAPID) shape on purpose.
 */

import { GoogleAuth } from "google-auth-library";
import type { Logger } from "pino";
import type { PushPayload, WebPushResult } from "./push.js";

export type FcmResult = WebPushResult; // "ok" | "gone" | "transient" | "config"

// Module logger so FCM warnings reach the relay's pino sink (#736) instead of a
// bare console. Set once by initFcm() at relay startup; null → warnings drop.
let fcmLogger: Logger | null = null;

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

let configError: string | null = null;
let serviceAccount: ServiceAccount | null = null;
// Cache the in-flight init PROMISE (not the resolved client) so a burst of
// concurrent dispatches on startup all await one GoogleAuth init.
let authPromise: Promise<{ auth: GoogleAuth; projectId: string } | null> | null = null;

function loadServiceAccount(): ServiceAccount | null {
  if (serviceAccount) return serviceAccount;
  if (configError) return null;
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) {
    configError = "FCM_SERVICE_ACCOUNT_JSON not set — mobile push disabled";
    console.log(`[push.fcm] ${configError}`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
      configError = "FCM_SERVICE_ACCOUNT_JSON missing project_id/client_email/private_key";
      fcmLogger?.warn(`[push.fcm] ${configError}`);
      return null;
    }
    serviceAccount = parsed as ServiceAccount;
    return serviceAccount;
  } catch (err) {
    configError = `FCM_SERVICE_ACCOUNT_JSON not valid JSON: ${(err as Error).message}`;
    fcmLogger?.warn(`[push.fcm] ${configError}`);
    return null;
  }
}

export function initFcm(logger?: Logger): boolean {
  // Stash before loadServiceAccount so its config warnings route to the logger.
  fcmLogger = logger ?? null;
  const sa = loadServiceAccount();
  if (sa) {
    console.log(`[push.fcm] FCM (HTTP v1) configured for project ${sa.project_id}`);
    return true;
  }
  return false;
}

export function isFcmConfigured(): boolean {
  return loadServiceAccount() !== null;
}

function getAuth(): Promise<{ auth: GoogleAuth; projectId: string } | null> {
  if (authPromise) return authPromise;
  authPromise = (async () => {
    const sa = loadServiceAccount();
    if (!sa) return null;
    const auth = new GoogleAuth({
      credentials: { client_email: sa.client_email, private_key: sa.private_key },
      scopes: [FCM_SCOPE],
    });
    return { auth, projectId: sa.project_id };
  })();
  return authPromise;
}

// Build the FCM v1 `message` body for a token. Platform split (#480):
//
// - ANDROID is DATA-ONLY. A top-level `notification` (or `android.notification`)
//   makes the FCM SDK auto-display the banner while backgrounded and SKIP
//   onMessageReceived — exactly where our per-conversation grouping lives
//   (CyborgFirebaseMessagingService). Data-only guarantees onMessageReceived
//   runs in every state, so messages stack into one summary. Android reads
//   title/body from `data` (no `notification` block), so carry them there; HIGH
//   priority + ttl keep data-only pushes prompt.
// - iOS is UNCHANGED: delivered via FCM-over-APNs, it relies on the
//   `notification` + `apns`/aps block (alert, sound, badge) for display and the
//   Swift plugin's foreground/tap handling.
//
// Pure (no network) so the shape is unit-testable.
export function buildFcmMessage(
  token: string,
  payload: PushPayload,
  platform: string,
): Record<string, unknown> {
  // Shared data block (the app reads `url` to deep-link on tap).
  const data: Record<string, string> = {
    url: payload.url,
    ...(payload.tag ? { tag: payload.tag } : {}),
  };
  if (platform === "ios") {
    return {
      token,
      notification: { title: payload.title, body: payload.body },
      data,
      apns: {
        headers: { "apns-priority": "10", "apns-expiration": "0" },
        payload: {
          aps: {
            alert: { title: payload.title, body: payload.body },
            // Custom notification tone bundled in the iOS app as notification.caf
            // (setup-fcm-ios.mjs registers it). iOS resolves aps.sound by
            // filename in background (APNs) and foreground (willPresent's
            // .sound); falls back to the default if missing.
            sound: "notification.caf",
            // iOS app-icon badge. Only attach when the dispatcher computed a
            // count; otherwise omit so the device leaves the badge untouched.
            ...(typeof payload.badgeCount === "number" ? { badge: payload.badgeCount } : {}),
          },
        },
      },
    };
  }
  return {
    token,
    // DATA-ONLY — no `notification` / `android.notification`, so the SDK never
    // auto-displays and onMessageReceived always runs (→ grouping).
    data: { ...data, title: payload.title, body: payload.body },
    android: { priority: "HIGH", ttl: "60s" },
  };
}

export async function sendFcm(
  token: string,
  payload: PushPayload,
  platform: string,
): Promise<FcmResult> {
  return postFcmMessage(buildFcmMessage(token, payload, platform), platform, "send");
}

// Build a SILENT FCM badge-update message (#605 clear-on-read badge sync). It
// carries NO `notification`/alert/sound — its ONLY job is to mutate the app-icon
// badge so it drops when the user reads elsewhere, without buzzing or showing a
// banner. Platform split mirrors buildFcmMessage:
//
// - iOS: a background content-available push. `aps.badge` sets the icon count
//   (badge 0 clears it). `apns-push-type: background` + priority 5 + no alert is
//   the standard silent-badge contract; the device updates the badge without a
//   visible notification.
// - ANDROID: data-only `{type:"badge", count}` so CyborgFirebaseMessagingService
//   .onMessageReceived runs in every state and sets the launcher badge — same
//   data-only rationale as buildFcmMessage (a `notification` block would
//   auto-display + skip onMessageReceived).
//
// Pure (no network) so the shape is unit-testable.
export function buildBadgeFcmMessage(
  token: string,
  count: number,
  platform: string,
): Record<string, unknown> {
  if (platform === "ios") {
    return {
      token,
      // No `notification` block → silent. content-available wakes the app to
      // apply the badge; aps.badge carries the new count (0 clears it).
      apns: {
        headers: { "apns-priority": "5", "apns-push-type": "background" },
        payload: { aps: { "content-available": 1, badge: count } },
      },
    };
  }
  return {
    token,
    // DATA-ONLY silent update (no notification/title/body) — onMessageReceived
    // reads type/count and updates the badge without showing a banner.
    data: { type: "badge", count: String(count) },
    android: { priority: "HIGH", ttl: "60s" },
  };
}

// Shared FCM v1 POST + result mapping for the message/badge senders. Maps the
// HTTP outcome to an FcmResult (ok / gone → caller prunes the token / transient
// / config). `label` only flavors the warning log so the callers stay distinct.
async function postFcmMessage(
  message: Record<string, unknown>,
  platform: string,
  label: string,
): Promise<FcmResult> {
  const ctx = await getAuth();
  if (!ctx) return "config";
  let accessToken: string | null | undefined;
  try {
    accessToken = await ctx.auth.getAccessToken();
  } catch (err) {
    fcmLogger?.warn({ err }, `[push.fcm] failed to mint access token (${label})`);
    return "transient";
  }
  if (!accessToken) return "transient";

  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(ctx.projectId)}/messages:send`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
    });
    if (res.ok) return "ok";
    // 404 (token not found) / 403 (mismatched sender) / UNREGISTERED → prune.
    if (res.status === 404 || res.status === 403) return "gone";
    const text = await res.text().catch(() => "");
    if (/UNREGISTERED|INVALID_ARGUMENT/i.test(text)) return "gone";
    if (res.status >= 400 && res.status < 500) {
      fcmLogger?.warn(
        { platform, status: res.status, body: text.slice(0, 200) },
        `[push.fcm] ${label} rejected`,
      );
      return "transient";
    }
    return "transient";
  } catch (err) {
    fcmLogger?.warn({ err }, `[push.fcm] ${label} failed`);
    return "transient";
  }
}

// Send a silent badge-only update to one token (#605). Reuses the same FCM v1
// transport + dead-token mapping as sendFcm — NOT a new push path.
export async function sendFcmBadge(
  token: string,
  count: number,
  platform: string,
): Promise<FcmResult> {
  return postFcmMessage(buildBadgeFcmMessage(token, count, platform), platform, "badge send");
}
