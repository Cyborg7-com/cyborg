/**
 * Native mobile push registration (Tauri/Android-iOS shell only).
 *
 * On the Tauri mobile shell, after the WS is authenticated we ask the native
 * push plugin (`tauri-plugin-cyborg-push`) for this device's FCM token and
 * register it with the relay (`cyborg:fcm_register`). The relay then delivers a
 * push when the user is offline. No-op on web/desktop (no `window.__TAURI__`).
 *
 * Idempotent: the relay upserts by token, so calling this on every (re)auth is
 * safe. First launch needs a short backoff — Firebase delivers the token a beat
 * after the plugin's load().
 */

// Structural type — only the FCM methods are needed, so we avoid importing the
// concrete client class (and its dependency graph) here.
interface FcmRegistrar {
  registerFcmToken(token: string, platform: string, deviceName?: string): Promise<void>;
}

// Platform detection moved to ./platform.ts (Gemini #946) so non-push code (e.g.
// the terminal's viewport/keyboard gating) can detect the native shell WITHOUT
// importing this push module. Imported here for push-registration gating below and
// re-exported so the existing ~20 importers of these from "./push" keep working.
import { isTauri, isTauriIOS, isTauriAndroid } from "./platform.js";
export { isTauri, isTauriIOS, isTauriAndroid };

/**
 * Save a remote image to the device gallery via the native plugin. The web
 * `<a download>` / blob path is a no-op inside the mobile WebView (no Downloads
 * / Photos integration on iOS WKWebView, none in the Android System WebView),
 * so the image preview's Save button routes here on BOTH mobile platforms.
 * Native fetches the bytes (no CORS): iOS writes to the Photos camera roll
 * (add-only auth); Android writes to Pictures/Cyborg7 via MediaStore. Resolves
 * true on success, false otherwise. Throws are swallowed into `false` so
 * callers can show a single failure toast.
 */
export async function saveImageToPhotos(url: string): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const res = await invoke<{ saved?: boolean }>("plugin:cyborg-push|save_image_to_photos", {
      url,
    });
    return Boolean(res?.saved);
  } catch (err) {
    console.warn("[push] save_image_to_photos failed", err);
    return false;
  }
}

/**
 * Save a remote video to the iOS Photos library via the native plugin. The web
 * `<a download>` path is a no-op inside a WKWebView, so the chat video's Save
 * action routes here on iOS. Swift downloads the bytes to a temp file (no CORS),
 * asks for add-only Photos permission, and writes it to the camera roll as a
 * video asset, then cleans up the temp file. Resolves true on success, false
 * otherwise — throws are swallowed so callers can show a single failure toast.
 */
export async function saveVideoToPhotos(url: string): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const res = await invoke<{ saved?: boolean }>("plugin:cyborg-push|save_video_to_photos", {
      url,
    });
    return Boolean(res?.saved);
  } catch (err) {
    console.warn("[push] save_video_to_photos failed", err);
    return false;
  }
}

/**
 * Export an arbitrary file (PDF / doc / any non-media attachment) to a location
 * the user picks via the native iOS document-export / share sheet. The web blob
 * download path doesn't reach the Files app from inside a WKWebView, so the
 * file-card download routes here on iOS. Swift downloads the bytes to a temp
 * file under `filename`, presents `UIDocumentPickerViewController(forExporting:)`,
 * and resolves once the sheet is presented. Resolves true on success, false
 * otherwise — throws are swallowed so callers can show a single failure toast.
 */
export async function saveFile(url: string, name: string): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const res = await invoke<{ saved?: boolean }>("plugin:cyborg-push|save_file", {
      url,
      filename: name,
    });
    return Boolean(res?.saved);
  } catch (err) {
    console.warn("[push] save_file failed", err);
    return false;
  }
}

/**
 * Copy a remote image to the iOS system clipboard via the native plugin — the
 * iOS equivalent of the web "Copy image". `navigator.clipboard.write([
 * ClipboardItem])` doesn't work inside a WKWebView, so the right-click / lightbox
 * "Copy image" routes here on iOS. Swift downloads the bytes (no CORS), decodes
 * to a UIImage, and sets `UIPasteboard.general.image`. Resolves true on success,
 * false otherwise — throws are swallowed so callers can show a single failure
 * toast. Named *Native to avoid colliding with the web helper in
 * `$lib/media/clipboard.ts`.
 */
export async function copyImageToClipboardNative(url: string): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const res = await invoke<{ copied?: boolean }>("plugin:cyborg-push|copy_image_to_clipboard", {
      url,
    });
    return Boolean(res?.copied);
  } catch (err) {
    console.warn("[push] copy_image_to_clipboard failed", err);
    return false;
  }
}

function platformTag(): "android" | "ios" {
  if (typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent)) {
    return "ios";
  }
  return "android";
}

let registeredToken: string | null = null;

async function fetchFcmToken(): Promise<string | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const t = await invoke<string | null>("plugin:cyborg-push|get_fcm_token");
    return t ?? null;
  } catch (err) {
    console.warn("[push] get_fcm_token failed", err);
    return null;
  }
}

/**
 * Ensure the OS-level notification permission is granted (Android 13+ / API 33
 * gates notifications behind the POST_NOTIFICATIONS runtime permission, denied
 * by default — without prompting, FCM banners are silently dropped). The
 * tauri-plugin-notification requestPermission drives the native system dialog;
 * because POST_NOTIFICATIONS is app-wide, granting it also unblocks our FCM
 * FirebaseMessagingService banners. On API <33 it's auto-granted (no-op).
 * This is an Android-13+ concern only: iOS prompts natively via
 * UNUserNotificationCenter in the Swift plugin, and a desktop Tauri shell has
 * no such flow — so target Android explicitly (skipping iOS alone would still
 * run on desktop Tauri and could trigger an unexpected prompt / log noise).
 * Denial degrades gracefully: the token still registers; banners stay
 * suppressed until the user enables them.
 */
async function ensureNotificationPermission(): Promise<void> {
  const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
  if (!isAndroid) return;
  try {
    // Invoke tauri-plugin-notification's commands directly (the same ones its JS
    // wrapper calls) — it's bundled natively (lib.rs) and granted via
    // `notification:default` in the capability, so no extra JS dependency is
    // needed. is_permission_granted → boolean; request_permission → the
    // resulting state string ("granted" | "denied" | "default").
    const { invoke } = await import("@tauri-apps/api/core");
    if (await invoke<boolean>("plugin:notification|is_permission_granted")) return;
    const result = await invoke<string>("plugin:notification|request_permission");
    if (result !== "granted") {
      console.log(`[push] notification permission ${result} — banners suppressed until enabled`);
    }
  } catch (err) {
    // Plugin/API unavailable (older shell) — never block token registration.
    console.warn("[push] notification permission request failed", err);
  }
}

/**
 * Poll for the FCM token (first install delivers it ~1-3s after load) and
 * register it with the relay. Safe to call repeatedly; only re-registers when
 * the token actually changed.
 */
export async function registerMobilePush(client: FcmRegistrar): Promise<void> {
  if (!isTauri()) return;
  // Prompt for the notification permission early (first authenticated launch)
  // so banners can show once a push arrives (Android 13+ #468).
  await ensureNotificationPermission();
  const delaysMs = [0, 1000, 2500, 5000, 10000];
  let token: string | null = null;
  for (const delay of delaysMs) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    token = await fetchFcmToken();
    if (token) break;
  }
  if (!token) {
    console.log("[push] no FCM token yet (Firebase not ready or not configured)");
    return;
  }
  if (token === registeredToken) return;
  try {
    await client.registerFcmToken(token, platformTag(), `${platformTag()} device`);
    registeredToken = token;
    console.log(`[push] FCM token registered (${token.slice(0, 12)}…)`);
  } catch (err) {
    console.warn("[push] FCM register failed", err);
  }

  // Live refresh: re-register when Firebase rotates the token. The native plugin
  // emits this via trigger("fcm-token-refresh", { token }), a PLUGIN event —
  // delivered only to addPluginListener('cyborg-push', …), NOT a global listen()
  // (matches nativeComposer.ts). A bare listen() silently missed rotations.
  try {
    const { addPluginListener } = await import("@tauri-apps/api/core");
    await addPluginListener<{ token?: string } | string>(
      "cyborg-push",
      "fcm-token-refresh",
      async (payload) => {
        const next = typeof payload === "string" ? payload : payload?.token;
        if (!next || next === registeredToken) return;
        try {
          await client.registerFcmToken(next, platformTag(), `${platformTag()} device`);
          registeredToken = next;
        } catch (err) {
          console.warn("[push] FCM refresh register failed", err);
        }
      },
    );
  } catch {
    // plugin API unavailable (non-Tauri) — ignore.
  }
}
