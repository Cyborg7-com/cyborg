<script lang="ts">
  import { backOut, cubicIn } from "svelte/easing";

  // "N new messages" jump pill — Slack/Mattermost ToastWrapper parity.
  //
  // Rendered INSIDE the message-list scroll viewport (not a global toast) as a
  // sticky-positioned overlay pinned near the top of the viewport. It appears
  // when new non-own messages arrive while the user is scrolled UP (not near
  // the bottom). Clicking the pill jumps to the unread divider (or bottom); the
  // dismiss "x" hides it. The parent owns the visibility lifecycle (count +
  // atBottom/Esc reset) — this component is purely presentational and emits
  // onJump/onDismiss. The negative bottom margin keeps it from displacing the
  // message flow (it floats over the first row).
  let {
    count,
    onJump,
    onDismiss,
    noun = "message",
  }: {
    count: number;
    onJump: () => void;
    onDismiss: () => void;
    // Pluralized with a trailing "s". Channels/DMs use the default ("messages");
    // the thread panel passes "reply" → "N new replies".
    noun?: string;
  } = $props();

  const label = $derived(count === 1 ? `1 new ${noun}` : `${count} new ${noun}s`);

  // #520: spring the pill in/out (translateY + opacity) instead of a hard
  // pop. The parent's {#if} drives mount/unmount, so a custom intro/outro
  // transition is the idiomatic fit. The intro uses backOut (an overshoot
  // ease) for a spring-like settle; the outro is a quick clean fly-up.
  // prefers-reduced-motion collapses the duration to 0 → instant show/hide,
  // honoring the DONE criterion. Read live each time the transition starts so
  // a mid-session OS toggle wins.
  const reduceMotion = () =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Pinned at the top of the viewport, so it springs DOWN into place: enters
  // from -8px (above) with the overshoot ease.
  const OFFSET = -8;

  function pillIn(_node: Element) {
    return {
      duration: reduceMotion() ? 0 : 440,
      easing: backOut,
      css: (t: number) => `transform: translateY(${(1 - t) * OFFSET}px); opacity: ${t};`,
    };
  }

  function pillOut(_node: Element) {
    return {
      duration: reduceMotion() ? 0 : 200,
      easing: cubicIn,
      css: (t: number) => `transform: translateY(${(1 - t) * OFFSET}px); opacity: ${t};`,
    };
  }
</script>

<!-- P4a: floating capsule on the iOS material (.material-sheet blurs via its
     ::before overlay; overflow-hidden clips that inset-0 pseudo to the
     rounded-full radius so the blur can't paint square corners). Show/hide
     logic is entirely the parent's — unchanged. -->
<div
  class="pointer-events-none sticky inset-x-0 top-2 z-40 -mb-9 flex justify-center px-4"
  in:pillIn
  out:pillOut
>
  <div
    class="material-sheet pointer-events-auto flex items-center gap-1 overflow-hidden rounded-full shadow-lg"
  >
    <button
      type="button"
      onclick={onJump}
      class="flex cursor-pointer items-center gap-1.5 rounded-l-full py-1.5 pl-3.5 pr-2 text-[13px] font-semibold text-accent transition-opacity hover:opacity-90"
      aria-label={`Jump to ${label}`}
    >
      {label}
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path
          d="M6 2.5V9.5M6 9.5L9 6.5M6 9.5L3 6.5"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <button
      type="button"
      onclick={onDismiss}
      class="flex cursor-pointer items-center justify-center rounded-r-full py-1.5 pl-1 pr-3 text-content-muted transition-opacity hover:opacity-90"
      aria-label="Dismiss"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path
          d="M3 3L9 9M9 3L3 9"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
      </svg>
    </button>
  </div>
</div>
