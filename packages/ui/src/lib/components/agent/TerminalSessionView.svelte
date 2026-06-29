<script lang="ts">
  import TerminalView from "../terminal/TerminalView.svelte";
  import { relayTerminalTransport } from "../terminal/terminal-transport.js";
  import { client } from "$lib/state/client.js";

  // Session-view wrapper for a terminal session (#656, wired in #673).
  //
  // The emulator (TerminalView, components/terminal/) is a real, landed
  // dependency now — so this STATICALLY imports it (the old import.meta.glob
  // hedge searched ./ and silently no-matched once W2 placed it in
  // ../terminal/, which rendered the view EMPTY, #673). TerminalView is
  // backend-agnostic: it drives a TerminalTransport. We build the cloud
  // transport (#654 protocol over the ws-client) here and hand it down;
  // TerminalView owns the pty lifecycle (start with its xterm geometry, then
  // input/resize/kill + output/exit). `terminalId` identifies this session's
  // sidebar/route entry; the emulator manages its own pty over the transport.
  let {
    terminalId,
    daemonId,
    workspaceId,
    // Fired when the daemon pty exits (cyborg:terminal_exit) — forwarded from
    // TerminalView so the route can drop the session from the sidebar (#701).
    onExit,
  }: {
    terminalId: string;
    daemonId: string | null;
    workspaceId: string;
    onExit?: (exitCode: number) => void;
  } = $props();

  // Rebuilt per (workspaceId, daemonId) so switching sessions/daemons re-wires
  // the transport cleanly (the parent also {#key}s on terminalId).
  const transport = $derived(
    relayTerminalTransport({
      socket: client.terminalSocket(),
      workspaceId,
      daemonId: daemonId ?? undefined,
      newRequestId: () => crypto.randomUUID(),
    }),
  );
</script>

<div class="h-full w-full min-h-0" data-terminal-id={terminalId}>
  <!-- daemonId threads through so TerminalView can wire onDaemonReconnect
       (internal docs FIX-1): a daemon↔relay flap re-subscribes the live pty. -->
  <TerminalView {transport} {terminalId} daemonId={daemonId ?? undefined} {onExit} />
</div>
