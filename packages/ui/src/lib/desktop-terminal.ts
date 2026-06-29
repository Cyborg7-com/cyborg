// Typed accessor for the desktop shell's embedded-terminal bridge
// (packages/desktop-cyborg/preload.cts `cyborg7Desktop.setupTerminal`).
// Returns null in a plain browser or on a desktop build that predates the
// bridge — callers degrade to the show-the-command CTA (setup-cybo-cta.ts).

export interface DesktopTerminalBridge {
  hostInfo(): Promise<{ hostname: string; platform: string }>;
  start(opts: { cols: number; rows: number; command?: string }): Promise<{ id: string }>;
  input(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  kill(id: string): Promise<void>;
  onData(handler: (payload: { id: string; data: string }) => void): () => void;
  onExit(handler: (payload: { id: string; exitCode: number }) => void): () => void;
}

export function desktopTerminalBridge(): DesktopTerminalBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { cyborg7Desktop?: { setupTerminal?: unknown } })
    .cyborg7Desktop?.setupTerminal;
  return (bridge as DesktopTerminalBridge | undefined) ?? null;
}

// Open an http(s) URL in the OS browser, NOT inside the app WebView (which would
// destroy the shell). Prefers the desktop shell's `openExternal` bridge when the
// build exposes it; degrades to window.open with noopener in a plain browser.
// Used by the provider-remedy "open_url" action (Add usage, etc.).
export function openExternalUrl(url: string): void {
  if (typeof window === "undefined") return;
  const bridge = (window as unknown as { cyborg7Desktop?: { openExternal?: (u: string) => void } })
    .cyborg7Desktop?.openExternal;
  if (typeof bridge === "function") {
    bridge(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
