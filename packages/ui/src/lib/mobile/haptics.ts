/**
 * Native haptics bridge (Tauri iOS shell only).
 *
 * Thin fire-and-forget wrapper over the `haptic` command on
 * `tauri-plugin-cyborg-push` (Swift: UIImpactFeedbackGenerator /
 * UINotificationFeedbackGenerator / UISelectionFeedbackGenerator). No-op on
 * web / desktop / Android, and any invoke failure is swallowed — a missing
 * haptic must never surface as an error or a dropped frame in the caller.
 *
 * Wiring map (P2+ phases adopt this; Phase 0 only ships the bridge):
 *   - send message        → haptic("light")
 *   - long-press menu open → haptic("medium")
 *   - swipe-back commit   → haptic("light")
 *   - pull-to-refresh arm → haptic("light")
 *   - tab switch          → haptic("selection")
 *   - reaction add        → haptic("light")
 *   - destructive confirm / failure toast → haptic("error")
 */

import { isTauriIOS } from "./push";

export type HapticStyle =
  | "light"
  | "medium"
  | "heavy"
  | "soft"
  | "rigid"
  | "success"
  | "warning"
  | "error"
  | "selection";

export function haptic(style: HapticStyle): void {
  if (!isTauriIOS()) return;
  // Dynamic import keeps @tauri-apps/api out of web bundles' critical path
  // (same pattern as push.ts). Fire-and-forget: never await, never throw.
  import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("plugin:cyborg-push|haptic", { style }))
    // intentional: haptics are a non-essential tactile nicety; a failed buzz must never surface or throw into the UI gesture.
    .catch(() => {});
}
