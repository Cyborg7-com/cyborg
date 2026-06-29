import type { TerminalManager } from "./terminal-manager.js";
import { createWorkerTerminalManager } from "./worker-terminal-manager.js";

// CYBORG7 SEAM (internal docs): downstream consumers depend only on the
// TerminalManager interface, so the cyborg PtyHost is wired in here without any
// Paseo edits. The PtyHost path (env CYBORG7_PTY_HOST) connects to a detached,
// long-lived host so a LIVE pty survives a daemon restart; it is ON by default
// so terminals survive daemon updates for everyone. Because launching the host
// is async (connect-or-start + version handshake), bootstrap awaits
// launchPtyHostTerminalManager() behind the flag and overrides the manager this
// factory returns BEFORE constructing the terminal controller — so this sync
// factory always returns the unchanged Paseo default and the flag never changes
// byte-for-byte behavior here.
export function createConfiguredTerminalManager(): TerminalManager {
  return createWorkerTerminalManager();
}

// True when the daemon should run the cyborg PtyHost instead of the inherited
// worker. Read here (the seam) so bootstrap and the factory agree on the gate.
//
// DEFAULT ON: the PtyHost is enabled unless explicitly opted out, so live ptys
// survive daemon restarts/updates for every install. The launch fallback chain
// (systemd-run --user --scope cgroup escape on Linux/systemd, bare detached on
// macOS / non-systemd Linux) still applies when enabled-by-default.
//
// ESCAPE HATCH: set CYBORG7_PTY_HOST=0 (also accepts `false`/`off`, any case) to
// turn it OFF and fall back to the inherited Paseo worker — for an operator/user
// who needs to disable persistence if the host ever misbehaves.
export function isPtyHostEnabled(): boolean {
  const raw = process.env.CYBORG7_PTY_HOST;
  if (raw === undefined) {
    return true;
  }
  const v = raw.trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}
