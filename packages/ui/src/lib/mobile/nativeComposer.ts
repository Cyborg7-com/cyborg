/**
 * Native iOS composer bridge (Caveat #6 — the defining keyboard fix).
 *
 * iOS WKWebView's keyboard animation flicker ("parpadeo") can't be eliminated
 * from inside the WebView: the OS compositor does a snapshot-based morph between
 * the two viewport states, invisible to JS. The workaround is to keep the
 * WebView at full size — never resize it — and let a native UIKit composer
 * (a UIView pill with a UITextView + paperclip/mic/send) ride the keyboard via
 * Auto Layout inside iOS's own animation block.
 *
 * The Swift side lives in `CyborgPushPlugin.swift` (MARK: Native Composer). It
 * exposes these commands (Tauri `invoke('plugin:cyborg-push|…')`):
 *   - composer_activate   { theme }     — show the pill, apply the theme palette
 *   - composer_deactivate                — hide it + reset the bottom constraint
 *   - composer_clear_input               — wipe the text view after a send
 *   - composer_blur_input                — resign first responder, keep pill shown
 *   - composer_set_has_pending { hasPending } — drive the send-affordance for
 *                                          image-only sends
 *   - composer_set_text { text, caret }  — write text + caret (mention picks)
 *   - composer_set_visible { visible }   — LIGHT visibility-only toggle of the
 *                                          pill (isHidden) for sheets / swipe-back;
 *                                          does NOT touch first-responder/constraints
 *
 * And these Tauri events (`addPluginListener('cyborg-push', …)`):
 *   - composer:send         { text }                  — Send tapped
 *   - composer:mic          {}                         — mic tapped
 *   - composer:attach       {}                         — paperclip tapped
 *   - composer:text-changed { text, selectionStart, selectionEnd } — every keystroke
 *   - composer:file-picked  { name, mimeType, base64 } — native picker result
 *
 * The Svelte composer (`MessageInput.svelte`) stays mounted but visually hidden
 * on iOS; this bridge routes native events back into it so mentions, upload,
 * and voice logic keep running unchanged.
 *
 * ── 3-concurrent-instances reality ──
 * Up to three `MessageInput` instances can be mounted at once (channel +
 * ThreadPanel + dm). Only one may own the native pill. Each instance `register`s
 * onto a LIFO stack and receives an opaque owner token; the top of the stack
 * owns the pill, and `activate`/event-routing only honor calls from the top
 * owner. A destroyed instance `unregister`s (splices itself out): if it was the
 * top, the pill is handed to the next instance down via its `onReclaim`
 * callback (e.g. closing a thread restores the channel composer's pill), or
 * hidden if the stack is now empty. A buried instance simply leaves without
 * touching the top owner. This guarantees a stale/destroyed instance can never
 * drive the pill.
 *
 * ── activate-before-await + sequence rollback (Caveat #7) ──
 * `activate` claims a monotonic `activationSeq` synchronously, BEFORE any await.
 * If `deactivate` runs while an activate's bridge call is still in flight, the
 * counter advances and the resolved activate is rolled back with an extra
 * deactivate. This eliminates the "composer leaks onto the next page" bug caused
 * by async destroy/mount overlap during SvelteKit navigation.
 */

import { invoke, addPluginListener, type PluginListener } from "@tauri-apps/api/core";
import { isTauriIOS } from "./push";

/** Theme palette forwarded to Swift's `composer_activate`. Caveat #11: Swift
 *  must NEVER `evaluateJavaScript` from inside a plugin command (deadlocks
 *  against the WebKit URL-scheme handler's runtime mutex), so JS reads the
 *  computed CSS tokens and passes them in. Keys mirror the Swift
 *  `ComposerActivateArgs.Theme` decodable. */
export interface ComposerTheme {
  surface?: string;
  raised?: string;
  surfaceAlt?: string;
  edge?: string;
  content?: string;
  contentDim?: string;
  contentMuted?: string;
  accent?: string;
}

/** Per-instance callbacks routed from the native pill back to the visible
 *  Svelte composer. */
export interface ComposerCallbacks {
  /** Send tapped (or Return when configured). Receives the trimmed text; the
   *  Svelte side consults its own pending-attachments array, so an image-only
   *  send (empty text) still rides along. */
  onSend: (text: string) => void | Promise<void>;
  /** Paperclip tapped. iOS presents its own pickers natively, so this is the
   *  fallback path; `onFilePicked` carries the actual bytes. */
  onAttach?: () => void;
  /** Mic tapped — delegate to the hidden Svelte composer's voice flow. */
  onMic?: () => void;
  /** A formatting button in the native format bar (the row ABOVE the input pill,
   *  shown while the keyboard is up) was tapped. `kind` is one of
   *  bold/italic/strike/code/bulletList/orderedList/blockquote/link; the handler
   *  applies the markdown to the pill's live native selection. */
  onFormat?: (kind: string) => void;
  /** Every keystroke in the native pill. Powers the @-mention dropdown: the JS
   *  side needs the live text + caret position to detect `@query` patterns.
   *  `selectionEnd` is the end of the native selection (== selectionStart for a
   *  collapsed caret); the formatting toolbar uses both ends to wrap a selection
   *  (bold/italic/strike/code/link over selected text). Optional + defaults to
   *  selectionStart on the JS side so older Swift payloads (no selectionEnd)
   *  stay backward compatible. */
  onTextChanged?: (text: string, selectionStart: number, selectionEnd: number) => void;
  /** Once per file the user picks via a native iOS picker, already decoded into
   *  a `File` ready for the upload pipeline. */
  onFilePicked?: (file: File) => void | Promise<void>;
  /** The × on a native attachment chip was tapped. Carries the pending-file id
   *  so the Svelte side can drop it from its pendingFiles array. */
  onAttachRemoved?: (id: string) => void;
  /** A failed (red) native attachment chip was tapped to retry its upload. */
  onAttachRetry?: (id: string) => void;
  /** The native pill's total height changed (multi-line growth / attachment
   *  strip). The web layout reserves a matching bottom spacer so the message
   *  list isn't occluded by the UIKit overlay. Height is in CSS px. */
  onHeightChanged?: (height: number) => void;
  /** Called when this instance becomes the top of the registration stack again
   *  WITHOUT a re-register — i.e. a sibling that had grabbed the pill (a thread
   *  panel) was destroyed and ownership fell back to this still-mounted
   *  instance. The instance should re-show the pill (re-activate + re-sync its
   *  text/pending state). Without this, closing a thread would leave the
   *  underlying channel/dm composer with no native pill. */
  onReclaim?: () => void;
}

export interface ActivateOpts {
  /** Theme palette read from the live CSS tokens (Caveat #11). */
  theme?: ComposerTheme;
}

/** Opaque per-instance ownership token. An instance only controls the native
 *  pill while it is the registered owner; routing + activate calls from any
 *  other token are ignored. */
export type ComposerOwner = symbol;

// ── Ownership + callback registration (stack model) ──
// Up to three MessageInput instances can be mounted at once (channel +
// ThreadPanel + dm). We keep a LIFO stack of registrations; the top of the
// stack owns the native pill. `register` pushes (so the most-recently-mounted
// instance — e.g. a thread panel opened over a channel — wins), and
// `unregister` removes by token. When the top changes because a sibling above
// was removed, the new top's `onReclaim` fires so the still-mounted underlying
// composer re-shows the pill. Events always route to the current top's
// callbacks — never a torn-down instance.
interface Registration {
  owner: ComposerOwner;
  cb: ComposerCallbacks;
}
const stack: Registration[] = [];

function top(): Registration | null {
  return stack.length > 0 ? stack[stack.length - 1] : null;
}

function currentCallbacks(): ComposerCallbacks | null {
  return top()?.cb ?? null;
}

/** True when a MessageInput currently owns the native pill — i.e. we're on a
 *  route that has a composer (channel / dm / agent). Full-screen overlays that
 *  hid the pill (IapPaywall, …) use this to restore it ONLY when a composer is
 *  actually mounted: forcing `setNativeVisibility(true)` unconditionally re-showed
 *  the pill over non-chat screens (Home, settings, the trial bar's host) where
 *  Swift's URL-KVO had correctly kept it hidden. */
export function hasActiveComposer(): boolean {
  return stack.length > 0;
}

// Plugin listeners are registered once, lazily, and shared across all
// instances. They read the stack top's callbacks at fire time, so
// re-registration on owner change is unnecessary (and avoids leaking listeners).
let sendListener: PluginListener | null = null;
let attachListener: PluginListener | null = null;
let micListener: PluginListener | null = null;
let formatListener: PluginListener | null = null;
let textChangedListener: PluginListener | null = null;
let filePickedListener: PluginListener | null = null;
let attachRemovedListener: PluginListener | null = null;
let attachRetryListener: PluginListener | null = null;
let heightListener: PluginListener | null = null;

/** Monotonic counter used to invalidate stale activations (Caveat #7). Every
 *  call to `activate` claims a new sequence number; if `deactivate` (or an
 *  ownership change) runs while an activate's bridge call is still in flight,
 *  the counter advances and the resolved activate rolls itself back with an
 *  extra deactivate. */
// Vestigial Caveat-#7 bookkeeping: activate() now defers visibility entirely to
// Swift's URL-KVO and no longer reads this, so it's write-only. Kept (underscore-
// marked) as a record of the original stale-activation guard rather than ripped
// out of the delicate ownership scaffolding.
let _activationSeq = 0;

/** Base64 → Uint8Array → File. Decodes the native picker payload back into
 *  something the upload pipeline can consume. `atob` handles the standard
 *  alphabet that Swift's `base64EncodedString()` emits. */
function base64ToFile(name: string, mimeType: string, base64: string): File {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type: mimeType });
}

/** Register all five plugin event listeners exactly once. One try/catch per
 *  registration so a single failure doesn't leave the rest unregistered (the
 *  shared-catch variant in early v1 silently broke mic when send registered
 *  OK). Each handler reads `currentCallbacks()` (the top of the stack) at fire
 *  time, so events always route to the current owner — never a torn-down
 *  instance. */
async function ensureListeners(): Promise<void> {
  if (!sendListener) {
    try {
      sendListener = await addPluginListener<{ text?: string }>(
        "cyborg-push",
        "composer:send",
        (payload) => {
          // Forward whatever was typed — including empty. The Svelte composer's
          // submit() consults its own pendingFiles, so an image-only send still
          // has an attachment to ride along.
          const text = (payload?.text ?? "").trim();
          const cb = currentCallbacks()?.onSend;
          if (cb) {
            try {
              void cb(text);
            } catch (e) {
              console.warn("[nativeComposer] onSend threw", e);
            }
          }
        },
      );
    } catch (e) {
      console.warn("[nativeComposer] failed to register composer:send", e);
    }
  }
  if (!attachListener) {
    try {
      attachListener = await addPluginListener<Record<string, never>>(
        "cyborg-push",
        "composer:attach",
        () => {
          const cb = currentCallbacks()?.onAttach;
          if (cb) {
            try {
              cb();
            } catch (e) {
              console.warn("[nativeComposer] onAttach threw", e);
            }
          }
        },
      );
    } catch (e) {
      console.warn("[nativeComposer] failed to register composer:attach", e);
    }
  }
  if (!micListener) {
    try {
      micListener = await addPluginListener<Record<string, never>>(
        "cyborg-push",
        "composer:mic",
        () => {
          const cb = currentCallbacks()?.onMic;
          if (cb) {
            try {
              cb();
            } catch (e) {
              console.warn("[nativeComposer] onMic threw", e);
            }
          }
        },
      );
    } catch (e) {
      console.warn("[nativeComposer] failed to register composer:mic", e);
    }
  }
  if (!formatListener) {
    try {
      formatListener = await addPluginListener<{ kind?: string }>(
        "cyborg-push",
        "composer:format",
        (payload) => {
          const cb = currentCallbacks()?.onFormat;
          const kind = payload?.kind;
          if (cb && kind) {
            try {
              cb(kind);
            } catch (e) {
              console.warn("[nativeComposer] onFormat threw", e);
            }
          }
        },
      );
    } catch (e) {
      console.warn("[nativeComposer] failed to register composer:format", e);
    }
  }
  if (!textChangedListener) {
    try {
      textChangedListener = await addPluginListener<{
        text?: string;
        selectionStart?: number;
        selectionEnd?: number;
      }>("cyborg-push", "composer:text-changed", (payload) => {
        const cb = currentCallbacks()?.onTextChanged;
        if (!cb) return;
        const text = payload?.text ?? "";
        const sel =
          typeof payload?.selectionStart === "number" ? payload.selectionStart : text.length;
        // Backward compatible: older Swift payloads carry no selectionEnd, so
        // fall back to the caret (collapsed selection).
        const selEnd = typeof payload?.selectionEnd === "number" ? payload.selectionEnd : sel;
        try {
          cb(text, sel, selEnd);
        } catch (e) {
          console.warn("[nativeComposer] onTextChanged threw", e);
        }
      });
    } catch (e) {
      console.warn("[nativeComposer] failed to register composer:text-changed", e);
    }
  }
  if (!filePickedListener) {
    try {
      filePickedListener = await addPluginListener<{
        name?: string;
        mimeType?: string;
        base64?: string;
      }>("cyborg-push", "composer:file-picked", (payload) => {
        const name = payload?.name ?? "photo";
        const mimeType = payload?.mimeType ?? "application/octet-stream";
        const base64 = payload?.base64 ?? "";
        if (!base64) return;
        try {
          const file = base64ToFile(name, mimeType, base64);
          const cb = currentCallbacks()?.onFilePicked;
          if (cb) void cb(file);
        } catch (e) {
          console.warn("[nativeComposer] failed to decode picked file", e);
        }
      });
    } catch (e) {
      console.warn("[nativeComposer] failed to register composer:file-picked", e);
    }
  }
  if (!attachRemovedListener) {
    try {
      attachRemovedListener = await addPluginListener<{ id?: string }>(
        "cyborg-push",
        "composer:attach-removed",
        (payload) => {
          const id = payload?.id;
          if (!id) return;
          const cb = currentCallbacks()?.onAttachRemoved;
          if (cb) {
            try {
              cb(id);
            } catch (e) {
              console.warn("[nativeComposer] onAttachRemoved threw", e);
            }
          }
        },
      );
    } catch (e) {
      console.warn("[nativeComposer] failed to register composer:attach-removed", e);
    }
  }
  if (!attachRetryListener) {
    try {
      attachRetryListener = await addPluginListener<{ id?: string }>(
        "cyborg-push",
        "composer:attach-retry",
        (payload) => {
          const id = payload?.id;
          if (!id) return;
          const cb = currentCallbacks()?.onAttachRetry;
          if (cb) {
            try {
              cb(id);
            } catch (e) {
              console.warn("[nativeComposer] onAttachRetry threw", e);
            }
          }
        },
      );
    } catch (e) {
      console.warn("[nativeComposer] failed to register composer:attach-retry", e);
    }
  }
  if (!heightListener) {
    try {
      heightListener = await addPluginListener<{ height?: number }>(
        "cyborg-push",
        "composer:height",
        (payload) => {
          const h = payload?.height;
          if (typeof h !== "number") return;
          const cb = currentCallbacks()?.onHeightChanged;
          if (cb) {
            try {
              cb(h);
            } catch (e) {
              console.warn("[nativeComposer] onHeightChanged threw", e);
            }
          }
        },
      );
    } catch (e) {
      console.warn("[nativeComposer] failed to register composer:height", e);
    }
  }
}

/**
 * Register an instance as the native-pill owner and bind its callbacks by
 * pushing it onto the LIFO stack. The most-recently-registered instance wins
 * ownership (matches the visible-on-top composer in the 3-instance reality:
 * a thread panel opened over a channel takes the pill). Returns an opaque owner
 * token the caller passes to `activate` / `deactivate` / `unregister` / `isOwner`.
 *
 * Registration alone does NOT show the pill — call `activate` after to do that
 * (so the caller can read the theme + activate before any await, Caveat #7).
 */
export function register(cb: ComposerCallbacks): ComposerOwner {
  const owner: ComposerOwner = Symbol("composer-owner");
  // Drop any prior registration for this exact token (defensive — a caller
  // should unregister first, but a re-register must never duplicate).
  const existing = stack.findIndex((r) => r.owner === owner);
  if (existing !== -1) stack.splice(existing, 1);
  stack.push({ owner, cb });
  // Listener wiring is lazy + idempotent; kick it off but don't block the
  // synchronous registration (callbacks are already live for any event).
  void ensureListeners();
  return owner;
}

/** True while `owner` is the top of the stack (the live owner of the native
 *  pill). Used by an instance to decide whether to re-activate. */
export function isOwner(owner: ComposerOwner): boolean {
  return top()?.owner === owner;
}

/**
 * Show the native pill and apply the theme palette. Claims a fresh
 * `activationSeq` synchronously BEFORE the await (Caveat #7) so a `deactivate`
 * that races in during the in-flight invoke advances the counter and this
 * activation rolls itself back with an extra deactivate — the pill can never
 * leak onto the next page.
 *
 * No-ops for a stale owner (an instance not at the top of the stack), so a
 * torn-down or backgrounded composer's late activate can't resurrect the pill.
 */
export async function activate(owner: ComposerOwner, _opts: ActivateOpts = {}): Promise<boolean> {
  // VISIBILITY IS OWNED BY THE SWIFT URL-KVO, not JS. The native side shows the
  // pill on chat routes, hides it on every other URL, and applies the theme on
  // its show path. JS must NOT invoke composer_activate/_deactivate: doing so
  // raced the KVO during SvelteKit navigation and the race resolved to a
  // trailing deactivate — the pill vanished (the "missing composer" bug; the
  // device log showed 3×composerActivate → 2×composerDeactivate on a cold-launch
  // deep-link, leaving it hidden). So here we only confirm THIS instance is the
  // live owner; the caller then syncs text/pending via the separate
  // composer_set_* commands (which never touch visibility).
  return top()?.owner === owner;
}

/**
 * Hide the native pill. Advances `activationSeq` to roll back any activate that
 * is still resolving (Caveat #7). Only the live owner — or an explicit
 * teardown — should call this.
 */
export async function deactivate(): Promise<void> {
  // No-op for VISIBILITY: Swift's URL-KVO hides the pill on any non-chat route
  // (and resets the keyboard constraint), so JS must not invoke
  // composer_deactivate — that invoke racing the KVO is what hid the pill on a
  // live chat route. Kept as an API (callers still call it on teardown); it
  // simply advances the seq for any legacy in-flight bookkeeping.
  _activationSeq++;
}

/**
 * Remove a destroyed instance from the stack. If it was the top (the live
 * owner), the activationSeq is advanced so any in-flight activate from it rolls
 * back, and the new top (a still-mounted underlying composer — e.g. the channel
 * beneath a just-closed thread) is told to reclaim the pill via `onReclaim`.
 * If the instance was buried (a newer instance is on top), it's simply spliced
 * out — the top owner is untouched.
 */
export function unregister(owner: ComposerOwner): void {
  const idx = stack.findIndex((r) => r.owner === owner);
  if (idx === -1) return;
  const wasTop = idx === stack.length - 1;
  stack.splice(idx, 1);
  if (!wasTop) return;
  // The owner went away — invalidate any of its in-flight activations.
  _activationSeq++;
  const next = top();
  if (next) {
    // Hand the pill to the next instance down (a still-mounted composer beneath
    // the destroyed one — e.g. the channel under a just-closed thread) so it
    // re-shows + re-syncs without a hide/show flicker.
    if (next.cb.onReclaim) {
      try {
        next.cb.onReclaim();
      } catch (e) {
        console.warn("[nativeComposer] onReclaim threw", e);
      }
    }
  } else {
    // Stack is empty (last composer destroyed — navigating away from all
    // chats). Hide the native pill so it doesn't leak onto the next page.
    void deactivate();
  }
}

/** Wipe the native pill's text view after a successful send. */
export async function clearInput(): Promise<void> {
  try {
    await invoke("plugin:cyborg-push|composer_clear_input");
  } catch {
    /* plugin not available */
  }
}

/**
 * Lightweight show/hide of the native composer pill — only toggles Swift's
 * `composerContainer.isHidden`. A PURE visibility toggle: it does NOT touch the
 * ownership stack, `activationSeq`, JS callbacks, theme, text, or height
 * constraints (those would be wiped by `deactivate()` and would need a
 * re-`activate()` the chat page can't trigger reactively). Used by full-screen
 * overlay sheets and the swipe-back peek gesture to hide the pill — which is a
 * window-anchored native overlay above the WebView — while a web sheet covers
 * the chat or the chat page slides out under a finger, and to bring it back
 * cleanly when the sheet closes / the swipe is cancelled. The chat page stays
 * mounted with its JS state intact, so a Swift-side isHidden flip is enough.
 * Swift guards `composer_set_visible` on the master kill-switch, so a "show"
 * can never resurrect a globally-disabled pill.
 */
export async function setNativeVisibility(visible: boolean): Promise<void> {
  try {
    await invoke("plugin:cyborg-push|composer_set_visible", { visible });
  } catch {
    /* plugin not available (web/desktop) */
  }
}

/**
 * Dismiss the keyboard (resign the native text view's first responder) WITHOUT
 * hiding the pill. For a swipe-down-to-dismiss gesture — the pill stays visible
 * so the user can re-focus by tapping it (WhatsApp / Slack behaviour).
 */
export async function blurInput(): Promise<void> {
  try {
    await invoke("plugin:cyborg-push|composer_blur_input");
  } catch {
    /* plugin not available */
  }
}

/**
 * Mirror the JS-side pending-attachment count to Swift so the native send
 * button can enable for image-only sends. Without this Swift leaves the button
 * greyed out (it only sees the text view's emptiness).
 */
export async function setHasPending(hasPending: boolean): Promise<void> {
  try {
    await invoke("plugin:cyborg-push|composer_set_has_pending", { hasPending });
  } catch {
    /* plugin not available (web/desktop) */
  }
}

/** One pending attachment, shaped for the native preview strip. `thumb` is a
 *  base64 JPEG (no data: prefix) for images, empty for non-images (Swift draws
 *  a type icon instead). `state` drives the chip overlay (spinner/✓/retry). */
export interface NativeAttachment {
  id: string;
  kind: "image" | "video" | "audio" | "file";
  thumb: string;
  state: "uploading" | "ready" | "error";
}

/**
 * Push the full pending-attachment list to the native pill so it can render a
 * visible thumbnail strip above the input. The web composer chrome (which owns
 * the Svelte ComposerAttachments preview) is collapsed to opacity:0 behind the
 * native pill on iOS, so this is the ONLY visible attachment preview there.
 * Called on every change to pendingFiles (pick / paste / drop / upload-state /
 * remove). No-op off iOS.
 */
export async function setAttachments(items: NativeAttachment[]): Promise<void> {
  try {
    await invoke("plugin:cyborg-push|composer_set_attachments", { items });
  } catch {
    /* plugin not available (web/desktop) */
  }
}

/**
 * Write text (+ optional caret) into the native pill's text view. Called by the
 * JS @-mention picker when the user picks a row — it replaces the active
 * `@query` slice with `@token ` and moves the caret to the end of the inserted
 * token so typing resumes naturally.
 */
export async function setText(text: string, caret?: number): Promise<void> {
  try {
    await invoke("plugin:cyborg-push|composer_set_text", { text, caret });
  } catch {
    /* plugin not available */
  }
}

/**
 * Read the live CSS theme tokens off `document.documentElement` and shape them
 * into a `ComposerTheme` for `activate` (Caveat #11 — theme from JS, never read
 * via evaluateJavaScript inside a Swift command). Token names mirror the Swift
 * decodable keys. Returns `undefined` when not running in a browser context.
 */
export function readComposerTheme(): ComposerTheme | undefined {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return undefined;
  const s = getComputedStyle(document.documentElement);
  const v = (name: string): string => s.getPropertyValue(name).trim();
  return {
    surface: v("--color-surface"),
    raised: v("--color-raised"),
    surfaceAlt: v("--color-surface-alt"),
    edge: v("--color-edge"),
    content: v("--color-content"),
    contentDim: v("--color-content-dim"),
    contentMuted: v("--color-content-muted"),
    accent: v("--color-accent"),
  };
}

/**
 * Push the live CSS theme palette to the already-mounted native pill so an
 * in-chat theme switch (or a boot-time stale read) repaints it deterministically
 * — WITHOUT waiting for the next navigation.
 *
 * The gap this closes: `activate()` is a no-op for visibility (Swift's URL-KVO
 * owns show/hide) and DISCARDS its theme arg, and Swift only re-reads the CSS
 * tokens on a route change (its URL-KVO). So a light↔dark toggle while a chat is
 * open left the pill painted with the previous palette until the user navigated.
 * This fires the dedicated `composer_set_theme` command, which parses the same
 * tokens into the same cg* vars and repaints the pill on the main thread.
 *
 * Reads `readComposerTheme()` (the live `--color-*` tokens off the document —
 * Caveat #11: theme from JS, never via evaluateJavaScript inside a Swift
 * command) and fire-and-forget invokes the plugin. No-op off Tauri iOS, and a
 * no-op if the tokens can't be read (no document context). The pill is a single
 * global native overlay, so no owner argument is needed — the colours are the
 * same for whichever MessageInput currently owns it.
 */
export function pushComposerTheme(): void {
  if (!isTauriIOS()) return;
  const theme = readComposerTheme();
  if (!theme) return;
  // Instrumentation (iOS-only): the surface token pushed is the boss's toggle
  // signal — pair it with the Swift `[CyborgPush] composerSetTheme received …`
  // NSLog to prove the channel end-to-end from `log stream`.
  console.debug("[nativeComposer] pushComposerTheme surface=", theme.surface);
  void invoke("plugin:cyborg-push|composer_set_theme", { theme }).catch(() => {
    /* plugin not available (web/desktop) */
  });
}
