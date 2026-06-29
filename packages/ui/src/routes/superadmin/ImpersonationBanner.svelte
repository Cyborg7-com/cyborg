<script lang="ts">
  // Global impersonation banner. Rendered from the ROOT layout so it shows on
  // EVERY page — including /workspace, where impersonation lands you — not just
  // the superadmin shell. Reads the reactive `impersonationState` (rehydrated
  // from localStorage via initImpersonation on mount), and Exit hard-reloads
  // back to /superadmin AS the admin. Styled with the warning palette to match
  // the app.
  import { onMount } from "svelte";
  import {
    impersonationState,
    initImpersonation,
    exitImpersonation,
  } from "./impersonation.svelte.js";

  // Rehydrate the marker from localStorage on mount so a reload mid-
  // impersonation (the swap is a full-page navigation) still surfaces the banner.
  onMount(() => {
    initImpersonation();
  });

  function handleExit(): void {
    // exitImpersonation hard-navigates to /superadmin; no async state to track.
    exitImpersonation();
  }
</script>

{#if impersonationState.active}
  <!-- No role="status": an ARIA live region must not wrap an interactive
       control (the Exit button) — screen readers mishandle focus/announcements. -->
  <div
    class="flex shrink-0 items-center justify-between gap-3 border-b border-warning/40 bg-warning/15 px-4 py-2 text-[13px] text-warning"
  >
    <span class="min-w-0 truncate">
      Impersonating
      <strong class="font-semibold">{impersonationState.targetEmail}</strong>
    </span>
    <button
      type="button"
      onclick={handleExit}
      class="shrink-0 rounded-md border border-warning/50 px-2.5 py-1 font-medium text-warning transition-colors hover:bg-warning/20"
    >
      Exit impersonation
    </button>
  </div>
{/if}
