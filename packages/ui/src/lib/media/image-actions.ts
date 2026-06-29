/**
 * Pure helpers for the shared image-action layer (#537). Kept separate from the
 * rune composable (`image-actions.svelte.ts`) so this decision/label logic is
 * unit-testable without a Svelte runtime — it's the bit that had DRIFTED between
 * the two image modals (inconsistent result copy).
 */

// Platform-correct destination noun for the native save: iOS Photos vs the
// Android system gallery.
export function nativeSaveNoun(isIos: boolean): string {
  return isIos ? "Photos" : "gallery";
}

// The transient result toast text for the save button. ONE source so the two
// modals stop showing different copy ("Saved" / "Failed" vs "Saved to Photos" /
// "Couldn't save") for the same outcome.
export function saveResultLabel(result: "saved" | "failed" | null, noun: string): string {
  if (result === "saved") return `Saved to ${noun}`;
  if (result === "failed") return "Couldn't save";
  return "";
}
