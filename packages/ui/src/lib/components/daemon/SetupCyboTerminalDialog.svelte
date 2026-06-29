<script lang="ts">
  // Embedded "Set up Cybo" terminal (internal docs Phase 1: local daemon).
  // xterm.js in the dialog, the REAL pty in the Electron main process running
  // `cybo login` through the user's login shell (desktop-terminal bridge).
  // When the dialog closes (or the command exits), `onClosed` fires so the
  // caller triggers the provider re-probe (#369) and the banner heals itself.
  import { Dialog, DialogContent, DialogHeader, DialogTitle } from "$lib/components/ui/dialog/index.js";
  import { desktopTerminalBridge } from "$lib/desktop-terminal.js";
  import type { Terminal } from "@xterm/xterm";
  import "@xterm/xterm/css/xterm.css";

  let {
    open = $bindable(false),
    daemonLabel = "this daemon",
    onClosed,
  }: {
    open: boolean;
    daemonLabel?: string;
    // Fired ONCE per dialog open, after the terminal is torn down — wired to
    // the provider re-probe by the caller.
    onClosed?: () => void;
  } = $props();

  let containerEl: HTMLDivElement | undefined = $state();
  let exitCode: number | null = $state(null);
  let startError: string | null = $state(null);

  let term: Terminal | null = null;
  let sessionId: string | null = null;
  let disposers: Array<() => void> = [];
  let closedNotified = false;

  async function startTerminal(el: HTMLDivElement): Promise<void> {
    const bridge = desktopTerminalBridge();
    if (!bridge) {
      startError = "Embedded terminal is only available in the desktop app.";
      return;
    }
    try {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      const fit = new FitAddon();
      term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "var(--font-mono, ui-monospace, monospace)",
        theme: { background: "#1e242d" },
      });
      term.loadAddon(fit);
      term.open(el);
      fit.fit();

      const { id } = await bridge.start({
        cols: term.cols,
        rows: term.rows,
        command: "cybo-login",
      });
      sessionId = id;

      disposers.push(
        bridge.onData(({ id: evId, data }) => {
          if (evId === sessionId) term?.write(data);
        }),
        bridge.onExit(({ id: evId, exitCode: code }) => {
          if (evId !== sessionId) return;
          exitCode = code;
          sessionId = null;
          term?.write(`\r\n\x1b[2m[cybo login exited (${code}) — you can close this window]\x1b[0m\r\n`);
          // The setup flow is done — close the dialog shortly so the re-probe
          // runs without an extra click; the exit notice stays readable.
          setTimeout(() => {
            if (open) open = false;
          }, 1200);
        }),
      );
      term.onData((data) => {
        if (sessionId) void bridge.input(sessionId, data);
      });

      const resizeObserver = new ResizeObserver(() => {
        fit.fit();
        if (sessionId && term) void bridge.resize(sessionId, term.cols, term.rows);
      });
      resizeObserver.observe(el);
      disposers.push(() => resizeObserver.disconnect());
      term.focus();
    } catch (err) {
      startError = err instanceof Error ? err.message : "Failed to start the terminal.";
    }
  }

  function teardown(): void {
    for (const dispose of disposers) dispose();
    disposers = [];
    if (sessionId) {
      void desktopTerminalBridge()?.kill(sessionId);
      sessionId = null;
    }
    term?.dispose();
    term = null;
    if (!closedNotified) {
      closedNotified = true;
      onClosed?.();
    }
  }

  // Mount/unmount the pty with the dialog content. The container div only
  // exists while the dialog is open, so the effect's cleanup IS dialog close.
  $effect(() => {
    const el = containerEl;
    if (!el || !open) return;
    closedNotified = false;
    exitCode = null;
    startError = null;
    void startTerminal(el);
    return () => teardown();
  });
</script>

<Dialog bind:open>
  <DialogContent class="sm:max-w-[720px]" showCloseButton={true}>
    <DialogHeader>
      <DialogTitle>Set up Cybo on {daemonLabel}</DialogTitle>
    </DialogHeader>
    <p class="text-[12px] text-content-muted -mt-1">
      Connect a model provider for your cybos — this runs <code>cybo login</code> on this
      machine. Close this window when you're done and the status will refresh automatically.
    </p>
    {#if startError}
      <p class="text-[12px] text-destructive">{startError}</p>
    {/if}
    <div
      bind:this={containerEl}
      class="h-[380px] w-full overflow-hidden rounded-md bg-[#1e242d] p-2"
    ></div>
    {#if exitCode !== null}
      <p class="text-[12px] text-content-muted">
        Setup finished (exit {exitCode}). Re-checking providers…
      </p>
    {/if}
  </DialogContent>
</Dialog>
