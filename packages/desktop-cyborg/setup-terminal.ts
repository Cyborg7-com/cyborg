// Embedded "Set up Cybo" terminal (internal docs Phase 1: local daemon).
//
// The renderer opens a modal with xterm.js; this module hosts the REAL pty on
// the Electron main side running `cybo login` through the user's LOGIN shell —
// interactive (-i) + login (-l) so the shell resolves its own PATH (homebrew /
// npm-global / proto), the exact #342 failure family a GUI process hits with a
// bare spawn. The runtime's own TUI does the auth (Hermes pattern — no custom
// auth UI that drifts); when the pty exits, the renderer triggers the provider
// re-probe (cyborg:refresh_providers, #369) so the banner heals on its own.
//
// IPC surface (all renderer-initiated; events are targeted at the requesting
// WebContents only):
//   invoke cyborg7:setup-terminal:start {cols,rows,command?} → {id}
//   invoke cyborg7:setup-terminal:input {id,data}
//   invoke cyborg7:setup-terminal:resize {id,cols,rows}
//   invoke cyborg7:setup-terminal:kill {id}
//   invoke cyborg7:setup-terminal:host-info → {hostname,platform}
//   event  cyborg7:event:setup-terminal-data {id,data}
//   event  cyborg7:event:setup-terminal-exit {id,exitCode}

import os from "node:os";
import { ipcMain, type WebContents } from "electron";
import log from "electron-log/main";
import type * as pty from "node-pty";
import { spawnSetupPty, isPtyAvailable } from "./setup-terminal-pty.js";

interface PtySession {
  proc: pty.IPty;
  sender: WebContents;
  cancelAutoType: () => void;
}

const sessions = new Map<string, PtySession>();

export function registerSetupTerminal(): void {
  ipcMain.handle("cyborg7:setup-terminal:host-info", () => ({
    hostname: os.hostname(),
    platform: process.platform,
    // Lets the renderer hide/disable the embedded terminal and point the user to
    // running `cybo login` in a real terminal, instead of a cryptic spawn error,
    // when the native pty module didn't ship in this build.
    ptyAvailable: isPtyAvailable(),
  }));

  ipcMain.handle(
    "cyborg7:setup-terminal:start",
    (event, opts: { cols?: number; rows?: number; command?: string }) => {
      if (!isPtyAvailable()) {
        throw new Error(
          "The embedded terminal isn't available in this build (native pty module missing). " +
            "Run `cybo login` in your own terminal to authenticate, then click Re-check providers.",
        );
      }
      const cols = Math.max(20, Math.min(500, Math.floor(opts?.cols ?? 80)));
      const rows = Math.max(5, Math.min(200, Math.floor(opts?.rows ?? 24)));
      const commandKey = opts?.command ?? "cybo-login";
      const { id, proc, cancelAutoType } = spawnSetupPty({ cols, rows, commandKey });
      const sender = event.sender;
      sessions.set(id, { proc, sender, cancelAutoType });
      log.info("[setup-terminal] started", { id, commandKey, cols, rows });

      proc.onData((data) => {
        if (!sender.isDestroyed()) {
          sender.send("cyborg7:event:setup-terminal-data", { id, data });
        }
      });
      proc.onExit(({ exitCode }) => {
        sessions.delete(id);
        log.info("[setup-terminal] exited", { id, exitCode });
        if (!sender.isDestroyed()) {
          sender.send("cyborg7:event:setup-terminal-exit", { id, exitCode });
        }
      });
      return { id };
    },
  );

  ipcMain.handle("cyborg7:setup-terminal:input", (event, opts: { id: string; data: string }) => {
    const session = sessions.get(opts?.id);
    // Only the WebContents that started the session may drive it.
    if (session && session.sender === event.sender && typeof opts.data === "string") {
      session.proc.write(opts.data);
    }
  });

  ipcMain.handle(
    "cyborg7:setup-terminal:resize",
    (event, opts: { id: string; cols: number; rows: number }) => {
      const session = sessions.get(opts?.id);
      if (session && session.sender === event.sender) {
        const cols = Math.max(20, Math.min(500, Math.floor(opts.cols)));
        const rows = Math.max(5, Math.min(200, Math.floor(opts.rows)));
        session.proc.resize(cols, rows);
      }
    },
  );

  ipcMain.handle("cyborg7:setup-terminal:kill", (event, opts: { id: string }) => {
    const session = sessions.get(opts?.id);
    if (session && session.sender === event.sender) {
      sessions.delete(opts.id);
      session.cancelAutoType();
      try {
        session.proc.kill();
      } catch (err) {
        log.warn("[setup-terminal] kill failed", { id: opts.id, err });
      }
    }
  });
}

// App-quit hygiene: never leave a pty (and its child TUI) orphaned.
export function killAllSetupTerminals(): void {
  for (const [id, session] of sessions) {
    try {
      session.proc.kill();
    } catch (err) {
      log.warn("[setup-terminal] shutdown kill failed", { id, err });
    }
  }
  sessions.clear();
}
