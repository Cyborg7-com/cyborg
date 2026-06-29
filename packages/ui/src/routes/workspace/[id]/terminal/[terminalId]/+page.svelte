<script lang="ts">
  import { page } from "$app/state";
  import { workspaceState } from "$lib/state/app.svelte.js";
  import { terminalSessionsState } from "$lib/state/terminal-sessions.svelte.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import { goBackFromConversation } from "$lib/mobile/swipeBack";

  // Terminal session route (#656) — the session-list / launcher routes here. The
  // terminal session is daemon-scoped (started via #654). The live emulator
  // (TerminalView via TerminalSessionView) is NO LONGER mounted by THIS page:
  // internal docs keep-alive moves it into TerminalPaneHost (mounted once in the
  // workspace layout), which keeps every open terminal MOUNTED across tab switches
  // and overlays the active one on top of this route. Unmounting the route on a
  // tab switch would tear down the live pty's xterm + subscription; the persistent
  // host avoids that, so returning is instant and the session stays `live`. This
  // page now only keeps the session TRACKED (so the sidebar row + the host pane
  // exist) and renders a placeholder that the host overlay covers.
  const terminalId = $derived(page.params.terminalId as string);
  // The daemon the session runs on — passed by the launcher (?daemon=) so the
  // emulator targets the right daemon for input/resize/kill. Falls back to null;
  // the daemon is also recoverable from the tracked session list.
  const daemonId = $derived(page.url.searchParams.get("daemon"));
  const wsId = $derived(workspaceState.current?.id);

  // Track this session client-side so it appears under "Terminals" in the sidebar
  // (#701) AND so TerminalPaneHost renders a keep-alive pane for it. The launcher
  // (CreateAgentDialog) adds it on start, but a DIRECT nav or a page RELOAD lands
  // here untracked — add() is idempotent on terminalId, so re-adding an already-
  // tracked session is a no-op. Needs the daemon (from ?daemon=) to build the
  // return link; without it we can't, so we skip.
  $effect(() => {
    if (!wsId || !terminalId || !daemonId) return;
    terminalSessionsState.add({
      terminalId,
      daemonId,
      workspaceId: wsId,
      title: "Terminal",
      startedAt: Date.now(),
    });
  });
</script>

<div class="flex h-full flex-col">
  <!-- Mobile-only back affordance. On phones the bottom tab bar (MobileNav) is
       hidden while a terminal is open (the workspace layout drops it on terminal
       routes so the pty isn't cramped), leaving no way back — so we float an
       iOS-style chevron over the top-left. It pops via the SAME origin-aware
       computeBackTarget() the edge-swipe uses (goBackFromConversation), so the
       button and the gesture always land in the same place (the list the
       terminal was opened from, else the workspace root). Positioned `absolute`
       against the layout's `relative` <main>, above the TerminalPaneHost overlay
       (z-sheet), with a safe-area top inset so it clears the status bar. Desktop
       never renders it (gated on viewportState.isMobile). -->
  {#if viewportState.isMobile}
    <button
      type="button"
      onclick={goBackFromConversation}
      class="pressable focus-ring absolute left-1 z-[var(--z-sheet)] flex h-[44px] w-[44px] items-center justify-center rounded-[12px] bg-surface/80 text-content-dim backdrop-blur"
      style="top: calc(0.25rem + var(--sat))"
      aria-label="Back"
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
    </button>
  {/if}
  {#if !wsId}
    <div class="flex h-full items-center justify-center text-sm text-content-muted">Loading…</div>
  {:else if !terminalId}
    <div class="flex h-full items-center justify-center text-sm text-content-muted">
      No terminal session.
    </div>
  {:else}
    <!-- Placeholder behind the keep-alive host overlay (TerminalPaneHost in the
         layout covers this with the live emulator). A tracked session with a
         known daemon shows the live pane here; the brief placeholder only ever
         shows before the host pane mounts (e.g. a reload before ?daemon= tracks). -->
    <div class="flex h-full items-center justify-center text-sm text-content-muted">
      Opening terminal…
    </div>
  {/if}
</div>
