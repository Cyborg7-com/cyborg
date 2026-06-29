import type { Command } from "commander";
import type { SingleResult, CommandError } from "../../output/index.js";
import { connectCyborg } from "../cyborg/client.js";
import {
  connectTerminalClient,
  toTerminalCommandError,
  type TerminalCommandOptions,
} from "./shared.js";
import { terminalSchema, type TerminalRow, toTerminalRow } from "./schema.js";

export interface TerminalCreateOptions extends TerminalCommandOptions {
  cwd?: string;
  name?: string;
  // Bind the terminal to a workspace (terminal/CLI-UI unification). With this set,
  // the CLI routes through the cyborg:start_terminal RPC (instead of Paseo's
  // workspace-less create_terminal), so the daemon stamps the workspaceId onto the
  // session — which is what makes it appear in that workspace's UI Terminals sidebar.
  workspace?: string;
  // Auth for the cyborg path (dev-mode token or email). Only used when --workspace
  // is set; the Paseo path needs no cyborg auth.
  email?: string;
  token?: string;
  // Target a specific daemon by id when several are connected (the cyborg path).
  daemon?: string;
}

export async function runCreateCommand(
  options: TerminalCreateOptions,
  command: Command,
): Promise<SingleResult<TerminalRow>> {
  // Workspace-bound terminal → cyborg:start_terminal so the session carries a
  // workspaceId and surfaces in the UI sidebar (directory-sourced).
  if (options.workspace) {
    return runCyborgCreate(options);
  }
  return runPaseoCreate(options, command);
}

// Paseo path (no workspace): the original behavior — create a daemon pty with no
// workspace binding. Stays for parity with `paseo terminal create` and any caller
// that just wants an unbound shell.
async function runPaseoCreate(
  options: TerminalCreateOptions,
  _command: Command,
): Promise<SingleResult<TerminalRow>> {
  const { client } = await connectTerminalClient(options.host);
  const cwd = options.cwd ?? process.cwd();

  try {
    const payload = await client.createTerminal(cwd, options.name);
    if (!payload.terminal) {
      const error: CommandError = {
        code: "TERMINAL_CREATE_FAILED",
        message: payload.error ?? "Failed to create terminal",
      };
      throw error;
    }
    return {
      type: "single",
      data: toTerminalRow(payload.terminal),
      schema: terminalSchema,
    };
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_CREATE_FAILED", "create terminal", err);
  } finally {
    await client.close().catch(() => {}); // intentional: best-effort WS teardown; the real error is already surfaced
  }
}

// Cyborg path (--workspace): start the terminal through the workspace-aware
// cyborg:start_terminal RPC. The daemon's CyborgTerminalController stamps the
// workspaceId onto the session (and its #750 sidecar) and pushes a
// cyborg:terminals_changed directory snapshot, so any UI client watching that
// workspace sees the row appear live.
async function runCyborgCreate(options: TerminalCreateOptions): Promise<SingleResult<TerminalRow>> {
  const workspaceId = options.workspace as string;
  // Only pin a cwd when the caller explicitly passes one. Defaulting to the LOCAL
  // process.cwd() breaks a REMOTE daemon (e.g. a Linux box can't chdir to a macOS
  // /Users/... path → the pty fails to spawn / starts blank). With no cwd the owning
  // daemon spawns in its own home.
  const cwd = options.cwd;

  let client: Awaited<ReturnType<typeof connectCyborg>>;
  try {
    client = await connectCyborg({
      host: options.host,
      token: options.token,
      email: options.email,
    });
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_CREATE_FAILED", "connect to cyborg daemon", err);
  }

  try {
    const payload = await client.request<{
      ok?: boolean;
      terminalId?: string;
      error?: string;
    }>("cyborg:start_terminal", {
      workspaceId,
      ...(options.daemon ? { daemonId: options.daemon } : {}),
      ...(cwd ? { cwd } : {}),
      // Seed geometry; the UI sends a real resize once its xterm fit() runs.
      cols: 80,
      rows: 24,
    });

    if (payload.ok !== true || typeof payload.terminalId !== "string") {
      const error: CommandError = {
        code: "TERMINAL_CREATE_FAILED",
        message: payload.error ?? "Failed to create terminal",
      };
      throw error;
    }

    return {
      type: "single",
      data: toTerminalRow(
        { id: payload.terminalId, name: options.name ?? "terminal", cwd: cwd ?? "" },
        cwd ?? "",
      ),
      schema: terminalSchema,
    };
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_CREATE_FAILED", "create terminal", err);
  } finally {
    client.close();
  }
}
