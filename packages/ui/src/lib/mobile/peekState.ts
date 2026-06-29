/**
 * Module-level peek-snapshot store for the iOS swipe-back gesture (Caveat #22).
 *
 * The swipe-back peek needs a single source of truth for the cloned `<main>`
 * element (the snapshot of the page we're sliding away from, shown underneath).
 * Keeping it in a `let` inside the layout's `<script>` broke in v1 after the
 * layout ran more than once (Svelte component re-init / iOS WKWebView re-init /
 * HMR): each pass created a fresh local, so the capture hook wrote into
 * instance A's variable while the touchmove handler read from instance B's —
 * `captures=0 lastPageNode=null` even though the capture log proved the capture
 * ran. A standalone *plain* `.ts` module (NOT `.svelte.ts`) stays a true
 * singleton across all component lifecycles — same rule as Caveats #8 and #28.
 *
 * Pure DOM/ESM state; no Svelte runes here on purpose.
 */

let lastPageNode: HTMLElement | null = null;
let captureCount = 0;
let lastCaptureResult: "found" | "null" | "none" = "none";

export function setLastPageNode(node: HTMLElement | null): void {
  lastPageNode = node;
}

export function getLastPageNode(): HTMLElement | null {
  return lastPageNode;
}

export function clearLastPageNode(): void {
  lastPageNode = null;
}

export function bumpCaptureCount(): number {
  return ++captureCount;
}

export function getCaptureCount(): number {
  return captureCount;
}

export function setLastCaptureResult(r: "found" | "null" | "none"): void {
  lastCaptureResult = r;
}

export function getLastCaptureResult(): "found" | "null" | "none" {
  return lastCaptureResult;
}
