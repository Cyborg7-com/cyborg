// One shared "dismiss on outside-click / Escape" Svelte action for popovers and
// menus (#510). Three message-zone components hand-rolled the same
// addEventListener / ref-contains / Esc dance, each easy to leak a listener or
// forget Escape; this consolidates them into a single, lifecycle-safe action.
//
// Usage (default = bubble-phase `click`, Escape on):
//   <div bind:this={ref}>
//     {#if open}<Popover use:clickOutside={{ enabled: open, onClose: () => (open = false) }} />{/if}
//   </div>
//
// It only fires `onClose` when the event target is genuinely OUTSIDE the node
// (or outside every element matching `boundary`, when given) and never while
// `enabled` is false. The document listener is added on mount / when enabled and
// REMOVED on destroy / when disabled — no leaks across reopen.
//
// The three call sites differ in event type and phase, so those are options
// rather than baked in:
//   • MessageInput      — bubble-phase `click`, no Esc (Esc is handled inline by
//                         the composer's own keydown for the mention popup).
//   • MessageActionBar  — CAPTURE-phase `click` (so the reaction popover closes
//                         before a click on another row's bar re-opens one).
//   • MessageList       — `mousedown` + Esc, with `boundary: "[data-date-divider]"`
//                         because the date-jump menus live in an {#each} and a
//                         click on ANY divider counts as "inside".
//
// The pure inside/Escape decisions live in `isOutsideTarget` / `isEscapeKey`
// below so they can be unit-tested without a DOM (the ui vitest env is node).

// Minimal structural view of the DOM bits this decision needs. Duck-typed (not
// `instanceof Element`) so the logic is unit-testable in the ui's node vitest
// env, where the `Element` global doesn't exist — a real DOM Element satisfies
// these (they extend EventTarget so the type guards below narrow cleanly), and a
// test fake just supplies the one method each branch calls.
interface ContainsTarget {
  contains(other: Node | null): boolean;
}
interface ClosestTarget extends EventTarget {
  closest(selector: string): Element | null;
}

/** Should this pointer event's target dismiss the popover? True = outside. */
export function isOutsideTarget(
  node: ContainsTarget,
  target: EventTarget | null,
  boundary?: string,
): boolean {
  // `boundary` mode: "inside" means inside ANY element matching the selector,
  // not just `node` (the date-jump menus are one-per-divider in an {#each}).
  if (boundary) {
    // A target that can't be `.closest()`-queried (e.g. document, or a click
    // that lost its target) is outside — same as the old `!t.closest(sel)` guard.
    if (!hasClosest(target)) return true;
    return target.closest(boundary) === null;
  }
  // A non-node target is treated as outside — same effect as the old
  // `!ref.contains(target)` guards, which were true for anything not contained.
  if (!isNode(target)) return true;
  return !node.contains(target);
}

function isNode(value: EventTarget | null): value is Node {
  return value !== null && typeof (value as { nodeType?: unknown }).nodeType === "number";
}

function hasClosest(value: EventTarget | null): value is ClosestTarget {
  return value !== null && typeof (value as { closest?: unknown }).closest === "function";
}

/** Is this the Escape key? (Mirrors the sites' `e.key === "Escape"` checks.) */
export function isEscapeKey(event: KeyboardEvent): boolean {
  return event.key === "Escape";
}

// Minimal structural view of the target bits the editable check needs. Duck-typed
// (not `instanceof HTMLElement`) so this stays unit-testable in the ui's node
// vitest env, where `HTMLElement` doesn't exist — a real element supplies
// `tagName` + `isContentEditable`, and a test fake just sets those two fields.
interface EditableTarget {
  tagName?: string;
  isContentEditable?: boolean;
}

/**
 * Is this Escape press coming from inside an editable element (INPUT, TEXTAREA,
 * SELECT, or a contenteditable host)? A document-global Escape handler must
 * ignore those so it doesn't yank focus / dismiss the popover out from under
 * someone mid-typing (#510 — the consolidated action is reused by sites that DO
 * sit alongside the composer's textarea).
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null) return false;
  const { tagName, isContentEditable } = target as EditableTarget;
  if (isContentEditable === true) return true;
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

export interface ClickOutsideOptions {
  /** Fire when a click/keydown should dismiss the popover. */
  onClose: () => void;
  /**
   * Only listen while true. The sites only bound their listeners while the
   * popover was open; mirror that so a closed popover costs nothing and we never
   * leave a document listener attached. Defaults to `true`.
   */
  enabled?: boolean;
  /** Pointer event that triggers the outside check. Default `"click"`. */
  eventType?: "click" | "mousedown" | "pointerdown";
  /** Listen in the capture phase (MessageActionBar relied on this). Default `false`. */
  capture?: boolean;
  /** Also close on Escape. Default `true`. */
  escape?: boolean;
  /**
   * CSS selector for the "inside" region. When set, a target inside ANY matching
   * element is treated as inside (instead of only `node`). Used by MessageList,
   * whose menus are rendered per date-divider inside an {#each}.
   */
  boundary?: string;
}

export function clickOutside(node: Element, options: ClickOutsideOptions) {
  let opts = options;
  // The event type / capture flag actually used by the live listener, so a later
  // update() that CHANGES them still removes the original listener (the browser
  // matches removeEventListener on type + capture, so we must replay the old pair
  // before binding the new one).
  let bound: { type: "click" | "mousedown" | "pointerdown"; capture: boolean } | null = null;

  function onPointer(e: Event): void {
    if (isOutsideTarget(node, e.target, opts.boundary)) opts.onClose();
  }

  function onKeydown(e: KeyboardEvent): void {
    // Escape while typing in a field is "cancel my input", not "dismiss this
    // popover" — let the editable element handle it instead of closing.
    if (isEscapeKey(e) && !isEditableTarget(e.target)) opts.onClose();
  }

  function add(): void {
    const type = opts.eventType ?? "click";
    const capture = opts.capture ?? false;
    document.addEventListener(type, onPointer, { capture });
    if (opts.escape ?? true) document.addEventListener("keydown", onKeydown);
    bound = { type, capture };
  }

  function remove(): void {
    if (bound) {
      // Capture flag must match the add() call for removal to take effect.
      document.removeEventListener(bound.type, onPointer, { capture: bound.capture });
      bound = null;
    }
    // keydown has no capture variant here, and removing an unbound listener is a
    // no-op, so it's always safe to clear.
    document.removeEventListener("keydown", onKeydown);
  }

  function sync(): void {
    // Re-bind on every (re)sync so a changed eventType/capture/escape can't
    // strand the previously-bound listener. Cheap: add()/remove() are O(1).
    remove();
    if (opts.enabled ?? true) add();
  }

  sync();

  return {
    update(next: ClickOutsideOptions) {
      opts = next;
      sync();
    },
    destroy() {
      remove();
    },
  };
}
