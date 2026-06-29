<script lang="ts">
  import { page } from "$app/state";
  import { workspaceState } from "$lib/state/app.svelte.js";
  import { terminalSessionsState } from "$lib/state/terminal-sessions.svelte.js";
  import TerminalSessionView from "./TerminalSessionView.svelte";
  import {
    activeTerminalId,
    bumpLru,
    mountedTerminalIds,
    paneDisplay,
    hostDisplay,
  } from "./terminal-pane-host.js";

  // Tab-change keep-alive host (internal docs Layer 1) with a BOUNDED renderer
  // footprint (internal docs §#10 — the "kills the Mac" fix).
  //
  // Terminal "tabs" in this shell are SvelteKit routes
  // (/workspace/<ws>/terminal/<id>). Navigating between them — or away to a
  // channel and back — used to UNMOUNT the terminal route, tearing down
  // TerminalView, its xterm buffer, and its daemon subscription; returning had to
  // re-attach from scratch (a "Connecting…"/black beat at best, a lost session at
  // worst). PR #818 fixed that by keeping every open TerminalView MOUNTED across
  // tab switches (display:none, never unmount): the subscription + xterm +
  // scrollback persist, so returning to a terminal is INSTANT and stays `live` —
  // no re-attach, no black screen. We KEEP that win exactly: a mounted pane stays
  // FULLY LIVE (subscribed + xterm intact) even while hidden.
  //
  // The only RAM concern is the UNBOUNDED count of mounted panes: the session list
  // is uncapped + persisted, so a launch with N sessions would mount N live xterms.
  // The daemon pty SURVIVES regardless (PtyHost), so a pane outside the cap can be
  // unmounted and re-attach instantly from the daemon snapshot/ring on return. So
  // this host BOUNDS the number of mounted (live) panes without regressing the
  // common-case keep-alive:
  //   1. LRU mount cap: the active pane + the few most-recently-viewed stay MOUNTED
  //      and fully live (mountedTerminalIds, cap MAX_MOUNTED_PANES). Up to the cap,
  //      hidden panes keep their subscription + xterm so a tab switch is instant.
  //      Beyond the cap the least-recently-viewed pane fully unmounts; returning to
  //      it remounts from scratch (connecting → snapshot → live).
  //   2. Hydrate-time prune: because the {#each} renders only the mounted subset, a
  //      launch with N persisted sessions never spawns N xterms — at most the cap.
  //
  // This host lives ABOVE the route (mounted once in the workspace layout). It is
  // shown only while a terminal route is active (covering the route's own
  // placeholder). The terminal route page (+page.svelte) no longer mounts the
  // emulator itself — this host owns the live panes so they survive navigation.

  // Current workspace scopes which terminals we host.
  const wsId = $derived(workspaceState.current?.id);
  // The terminal whose route is currently active (visible). null on every
  // non-terminal route — the whole host hides then, but the mounted panes survive.
  const activeId = $derived(activeTerminalId(page.url.pathname, page.params, wsId));
  // Every tracked session in this workspace (the candidate set to mount from).
  const sessions = $derived(wsId ? terminalSessionsState.forWorkspace(wsId) : []);

  // LRU recency of viewed terminals (most-recent first). Drives which panes stay
  // mounted beyond the active one. Updated whenever the active terminal changes.
  let lru = $state<string[]>([]);
  $effect(() => {
    const next = bumpLru(lru, activeId);
    // Only reassign on a real change so this effect doesn't loop (it reads `lru`).
    if (next.length !== lru.length || next.some((id, i) => id !== lru[i])) {
      lru = next;
    }
  });

  // The bounded set of terminalIds to keep MOUNTED + live (active + LRU, capped).
  // Reading `lru` makes this re-derive on navigation; reading `sessions` drops
  // stale ids whose session was removed.
  const mounted = $derived(mountedTerminalIds(sessions.map((s) => s.terminalId), activeId, lru));
  // Render only the mounted subset — everything else stays unmounted (its xterm +
  // subscription never created / fully torn down), so renderer RAM is bounded by
  // the cap. A mounted pane (even hidden) stays fully live for instant tab switch.
  const mountedSessions = $derived(sessions.filter((s) => mounted.has(s.terminalId)));

  // The daemon pty exited (cyborg:terminal_exit) → drop the session so its pane
  // unmounts and its sidebar row disappears. Mirrors the old route handler.
  function handleExit(terminalId: string): void {
    terminalSessionsState.remove(terminalId);
  }
</script>

<!-- Absolutely positioned over the route's <main> so it can cover the terminal
     route's placeholder while keeping the mounted panes across navigation. Hidden
     (display:none) on non-terminal routes — the mounted panes inside survive. -->
<div
  class="absolute inset-0 flex flex-col"
  style:display={hostDisplay(activeId)}
  data-testid="terminal-pane-host"
>
  {#each mountedSessions as session (session.terminalId)}
    <!-- Bounded keep-alive pane: mounted only while within the LRU cap. Every
         mounted pane stays FULLY LIVE (xterm + subscription + scrollback intact)
         even when hidden, so the active one is visible and switching to any other
         mounted pane is INSTANT and still `live` — only the active one is shown. -->
    <div
      class="absolute inset-0 h-full w-full"
      style:display={paneDisplay(session.terminalId, activeId)}
      data-terminal-pane={session.terminalId}
    >
      <TerminalSessionView
        terminalId={session.terminalId}
        daemonId={session.daemonId}
        workspaceId={session.workspaceId}
        onExit={() => handleExit(session.terminalId)}
      />
    </div>
  {/each}
</div>
