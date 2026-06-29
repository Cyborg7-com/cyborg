import { contextBridge, ipcRenderer } from "electron";

type EventHandler = (payload: unknown) => void;

contextBridge.exposeInMainWorld("cyborg7Desktop", {
  platform: process.platform,
  invoke: (command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke("cyborg7:invoke", command, args),
  events: {
    on: (event: string, handler: EventHandler): (() => void) => {
      const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
        handler(payload);
      };
      ipcRenderer.on(`cyborg7:event:${event}`, listener);
      return () => {
        ipcRenderer.removeListener(`cyborg7:event:${event}`, listener);
      };
    },
  },
  window: {
    toggleMaximize: () => ipcRenderer.invoke("cyborg7:window:toggleMaximize"),
  },
  getVersion: () => ipcRenderer.invoke("cyborg7:app:get-version"),
  setBadgeCount: (count: number) => ipcRenderer.invoke("cyborg7:app:set-badge", count),
  // Slack-parity dock badge: pass "3" for a count, "•" for unread channel
  // activity, "" to clear. Main maps it to the platform badge/overlay.
  setBadgeText: (text: string) => ipcRenderer.invoke("cyborg7:app:set-badge-text", text),
  notify: (opts: { title: string; body: string; url?: string }) =>
    ipcRenderer.send("cyborg7:app:notify", opts),
  // OS-aware deep link to the platform notification settings (macOS/Windows).
  // Electron can't read/flip the OS notification switch, so the settings page
  // sends the user here to enable banners themselves.
  openNotificationSettings: () => ipcRenderer.invoke("cyborg7:app:open-notification-settings"),
  // No renderer error bridge: the shared web beacon (@cyborg7/observability/web →
  // reportClientError) beacons renderer errors straight to the relay's
  // /api/cyborg/client-log, the same as web + mobile. The Logfire write token
  // lives only on the relay, never in this bundle.
  // Embedded "Set up Cybo" terminal (internal docs Phase 1). The renderer
  // renders xterm.js; the pty lives in main (setup-terminal.ts) running
  // `cybo login` through the user's login shell. Commands are an allowlist
  // KEY (e.g. "cybo-login"), never free text.
  setupTerminal: {
    hostInfo: (): Promise<{ hostname: string; platform: string }> =>
      ipcRenderer.invoke("cyborg7:setup-terminal:host-info"),
    start: (opts: { cols: number; rows: number; command?: string }): Promise<{ id: string }> =>
      ipcRenderer.invoke("cyborg7:setup-terminal:start", opts),
    input: (id: string, data: string): Promise<void> =>
      ipcRenderer.invoke("cyborg7:setup-terminal:input", { id, data }),
    resize: (id: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke("cyborg7:setup-terminal:resize", { id, cols, rows }),
    kill: (id: string): Promise<void> => ipcRenderer.invoke("cyborg7:setup-terminal:kill", { id }),
    onData: (handler: (payload: { id: string; data: string }) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: { id: string; data: string }) =>
        handler(payload);
      ipcRenderer.on("cyborg7:event:setup-terminal-data", listener);
      return () => ipcRenderer.removeListener("cyborg7:event:setup-terminal-data", listener);
    },
    onExit: (handler: (payload: { id: string; exitCode: number }) => void): (() => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        payload: { id: string; exitCode: number },
      ) => handler(payload);
      ipcRenderer.on("cyborg7:event:setup-terminal-exit", listener);
      return () => ipcRenderer.removeListener("cyborg7:event:setup-terminal-exit", listener);
    },
  },
  update: {
    getStatus: () => ipcRenderer.invoke("cyborg7:update:get-status"),
    check: () => ipcRenderer.invoke("cyborg7:update:check"),
    install: () => ipcRenderer.invoke("cyborg7:update:install"),
    onStatus: (handler: EventHandler): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: unknown) => handler(payload);
      ipcRenderer.on("cyborg7:event:update-status", listener);
      return () => ipcRenderer.removeListener("cyborg7:event:update-status", listener);
    },
  },
});
