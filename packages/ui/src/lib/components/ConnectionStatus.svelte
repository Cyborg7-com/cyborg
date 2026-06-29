<script lang="ts">
  import { connectionState } from "$lib/state/app.svelte.js";
  import { cn } from "$lib/utils.js";

  // Reconnect telemetry (set by the connection handler in app.svelte.ts on each
  // "reconnecting" emit; reset to 0 on a successful connect). Surfaced as
  // "Reconnecting… attempt N" with an optional "· retrying in Ns" tail when the
  // backoff delay is known. Both default to 0, so the copy degrades gracefully to
  // a plain "Reconnecting…" if telemetry is ever absent.
  const attempt = $derived(connectionState.reconnectAttempt);
  const delaySecs = $derived(
    connectionState.reconnectDelayMs > 0 ? Math.round(connectionState.reconnectDelayMs / 1000) : 0,
  );

  // true when the banner should use warning (amber) styling vs error (red)
  const isWarning = $derived(
    connectionState.deploying || connectionState.status === "reconnecting",
  );
</script>

{#if connectionState.status !== "connected" && connectionState.hasConnectedOnce}
  <!--
    Safe-area banner — iOS convention: the solid background fills INTO the safe
    area (the Dynamic Island floats over the banner color), but all text/content
    sits BELOW --sat so nothing is clipped by the notch or clock.

    Positioning: in-flow inside .drag-region (root layout flex column), stacked
    ABOVE the MobileTopBar. On desktop --sat resolves to 0px so the padding-top
    is a no-op — desktop rendering is identical to before.

    On iOS (html.tauri-ios) .drag-region collapses to min-height:0, so this
    banner is the only height contribution when visible. The MobileTopBar below
    it carries its own padding-top: var(--sat) independently — the two do NOT
    double-count: this banner sits above MobileTopBar in the DOM, so the
    MobileTopBar's --sat offset still applies relative to its own top edge (the
    bottom of this banner), keeping the top-bar content clear of the notch.

    Layout-displacement: banner is in normal flow (not fixed/absolute) — it
    pushes the rest of the shell down, consistent with the pre-redesign behavior.
    This avoids disturbing --app-vh / keyboard machinery and the swipe-back peek
    geometry, which all assume <main> starts at a fixed offset below the chrome.
  -->
  <div
    role="status"
    aria-live="polite"
    class={cn(
      "conn-status-banner w-full",
      isWarning ? "bg-warning" : "bg-error",
    )}
  >
    <!-- Content row: sits below --sat so text is never under the Dynamic Island -->
    <div
      class={cn(
        "flex items-center justify-center gap-2 px-3 text-[13px] font-semibold text-white",
        "conn-status-content",
      )}
    >
      {#if connectionState.deploying}
        <span class="h-2 w-2 shrink-0 rounded-full bg-white opacity-80 animate-pulse"></span>
        Updating… reconnecting
      {:else if connectionState.status === "reconnecting"}
        <span class="h-2 w-2 shrink-0 rounded-full bg-white opacity-80 animate-pulse"></span>
        <span>
          Reconnecting…{#if attempt > 0}<span class="tabular-nums"> attempt {attempt}</span>{/if}{#if delaySecs > 0}<span class="opacity-75"> · retrying in {delaySecs}s</span>{/if}
        </span>
      {:else}
        <span class="h-2 w-2 shrink-0 rounded-full bg-white"></span>
        Disconnected — reconnecting…
      {/if}
    </div>
  </div>
{/if}

<style>
  /* ── Connection-status banner ───────────────────────────────────────────────
     The outer wrapper (.conn-status-banner) extends its background INTO the
     safe area (iOS convention: color fills behind the Dynamic Island) while the
     inner content row (.conn-status-content) is padded BELOW --sat so the text
     never overlaps the status-bar clock.

     On desktop --sat is 0px so the extra padding collapses to zero — desktop
     appearance is a flat solid strip identical to the pre-redesign design, just
     with better contrast (solid vs 15%-alpha).

     Slide animation: the banner enters by sliding down from above (translateY
     -100% → 0) and exits by sliding back up. 200ms ease-out on entry; the exit
     direction is handled by the {#if} removal which is instant (Svelte removes
     the DOM node; we can't animate out without a transition: directive — kept
     as instant-remove to avoid adding a third-party transition dep). Reduced
     motion: no transform. */

  .conn-status-banner {
    /* Background extends edge-to-edge including the safe-area zone */
    width: 100%;
    /* Slide in from above on mount */
    animation: conn-banner-in 200ms ease-out both;
  }

  .conn-status-content {
    /* Push text below the Dynamic Island / status-bar notch */
    padding-top: var(--sat, 0px);
    /* Content row height: 34px sits comfortably between iOS's typical 32–36pt
       offline banner sizes (WhatsApp/Telegram reference). */
    height: calc(34px + var(--sat, 0px));
  }

  @keyframes conn-banner-in {
    from {
      transform: translateY(-100%);
      opacity: 0.7;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  /* Respect prefers-reduced-motion: skip the slide, show/hide instantly */
  @media (prefers-reduced-motion: reduce) {
    .conn-status-banner {
      animation: none;
    }
  }
</style>
