<script lang="ts">
  // Cold-start splash: shown while the saved session is restored and the
  // destination workspace is resolved, so the user never sees the transient
  // login (Cloud/Local) screen or the workspace picker flash past on launch.
  import CyborgIcon from "$lib/components/CyborgIcon.svelte";
  import { connectionState } from "$lib/state/app.svelte.js";

  // Only surface a status if the connect is genuinely SLOW (>4s), so a stuck /
  // failing restore isn't a silent infinite spinner. A normal fast launch never
  // shows any text — just the logo + spinner.
  let slow = $state(false);
  $effect(() => {
    const t = setTimeout(() => {
      slow = true;
    }, 4000);
    return () => clearTimeout(t);
  });
  const statusText = $derived(
    !slow
      ? ""
      : connectionState.deploying || connectionState.status === "reconnecting"
        ? "Reconnecting…"
        : "Connecting…",
  );
</script>

<div class="fixed inset-0 z-[var(--z-modal)] flex flex-col items-center justify-center gap-5 bg-surface">
  <div
    class="c7-splash-logo flex items-center justify-center"
    style="width: 60px; height: 60px; border-radius: 16px; background: var(--bg-raised, var(--bg-base));"
  >
    <CyborgIcon size={32} class="text-content" />
  </div>
  <div class="c7-splash-spinner" aria-label="Loading"></div>
  {#if statusText}
    <p class="text-xs text-content-muted">{statusText}</p>
  {/if}
</div>

<style>
  .c7-splash-logo {
    animation: c7-splash-pulse 1.4s ease-in-out infinite;
  }
  @keyframes c7-splash-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }
  .c7-splash-spinner {
    width: 22px;
    height: 22px;
    border-radius: 9999px;
    border: 2px solid var(--border, color-mix(in srgb, currentColor 18%, transparent));
    border-top-color: var(--c7-accent, var(--color-link, currentColor));
    animation: c7-splash-spin 0.7s linear infinite;
  }
  @keyframes c7-splash-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
