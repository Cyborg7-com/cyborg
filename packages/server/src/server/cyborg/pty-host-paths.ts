// Deterministic, identity-scoped socket path for the PtyHost (internal docs).
//
// rmux hardening: the rendezvous address is a FUNCTION OF (user / daemon-home),
// never a pid — so any later daemon process can reconnect to the same running
// host. The dir is 0700 and the socket 0600 (matching the credential store),
// with the unix-socket peer being owner-only by virtue of the dir perms.

import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PTY_HOST_SOCKET_NAME = "pty-host.sock";

// The env var the launcher passes to the spawned host. The host READS it (when
// set) so the launcher and host can never derive divergent socket paths — they
// agree on the literal path the launcher chose, not "the same PASEO_HOME by
// coincidence" (the #860 latent bug). Falls back to the PASEO_HOME-derived path.
export const PTY_HOST_SOCKET_ENV = "CYBORG7_PTY_HOST_SOCKET";

// Base dir for the host's runtime files. Mirrors cybo-credentials /
// terminal-persistence: $PASEO_HOME, else ~/.cyborg7.
export function resolvePtyHostBaseDir(baseDir?: string): string {
  return baseDir ?? process.env.PASEO_HOME ?? join(homedir(), ".cyborg7");
}

// The stable socket path. Same input (base dir) → same path → reconnect surface.
export function resolvePtyHostSocketPath(baseDir?: string): string {
  return join(resolvePtyHostBaseDir(baseDir), PTY_HOST_SOCKET_NAME);
}

// Resolve the host's socket path for the STANDALONE entry: prefer the explicit
// CYBORG7_PTY_HOST_SOCKET env the launcher set (so launcher + host agree on the
// exact path), falling back to the PASEO_HOME-derived path. Pass `baseDir` to
// override the fallback derivation (tests / in-process hosts).
export function resolvePtyHostSocketPathFromEnv(baseDir?: string): string {
  const fromEnv = process.env[PTY_HOST_SOCKET_ENV];
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return resolvePtyHostSocketPath(baseDir);
}

// Ensure the base dir exists with owner-only perms before the host binds. Returns
// the resolved base dir.
export function ensurePtyHostBaseDir(baseDir?: string): string {
  const dir = resolvePtyHostBaseDir(baseDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(dir, 0o700);
  } catch {
    // intentional: a chmod failure on an existing dir is non-fatal — the dir may
    // be owned with looser perms on a shared host; binding still proceeds.
  }
  return dir;
}
