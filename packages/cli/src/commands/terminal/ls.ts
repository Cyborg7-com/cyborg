import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import { connectCyborg } from "../cyborg/client.js";
import {
  connectTerminalClient,
  toTerminalCommandError,
  type TerminalCommandOptions,
} from "./shared.js";
import { terminalSchema, type TerminalRow, toTerminalRow } from "./schema.js";

type TerminalListEntry = Parameters<typeof toTerminalRow>[0];

export interface TerminalLsOptions extends TerminalCommandOptions {
  all?: boolean;
  cwd?: string;
  // Cyborg/relay path — list terminals on a possibly-REMOTE daemon. --workspace
  // routes through cyborg:list_terminals; --daemon targets a specific daemon (the
  // relay forwards by daemonId); --token/--email authenticate against the relay
  // (use --host wss://relay.cyborg7.com/api/ws to reach the cloud relay).
  workspace?: string;
  daemon?: string;
  email?: string;
  token?: string;
}

// One directory entry as returned by cyborg:list_terminals (daemon-scoped).
interface CyborgTerminalDirEntry {
  terminalId: string;
  workspaceId: string;
  daemonId?: string | null;
  cwd?: string | null;
  title?: string;
  live: boolean;
}

export async function runLsCommand(
  options: TerminalLsOptions,
  _command: Command,
): Promise<ListResult<TerminalRow>> {
  // Workspace-scoped → cyborg path so it reaches a (possibly remote) daemon via the
  // relay. The bare Paseo path (below) only sees the directly-connected daemon.
  if (options.workspace) {
    return runCyborgLs(options);
  }

  const { client } = await connectTerminalClient(options.host);
  const cwd = options.all ? undefined : (options.cwd ?? process.cwd());

  try {
    const payload =
      cwd === undefined ? await client.listTerminals() : await client.listTerminals(cwd);
    return {
      type: "list",
      data: payload.terminals.map((terminal: TerminalListEntry) =>
        toTerminalRow(terminal, payload.cwd ?? cwd),
      ),
      schema: terminalSchema,
    };
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_LIST_FAILED", "list terminals", err);
  } finally {
    await client.close().catch(() => {}); // intentional: best-effort WS teardown; the real error is already surfaced
  }
}

// List the caller's tracked terminals on a workspace's daemon over the relay. With
// --daemon the relay routes to that specific (remote) daemon; without it the relay
// fans out across the workspace's daemons and merges. Owner-scoped server-side.
async function runCyborgLs(options: TerminalLsOptions): Promise<ListResult<TerminalRow>> {
  const workspaceId = options.workspace as string;
  let client: Awaited<ReturnType<typeof connectCyborg>>;
  try {
    client = await connectCyborg({
      host: options.host,
      token: options.token,
      email: options.email,
    });
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_LIST_FAILED", "connect to cyborg relay", err);
  }

  try {
    const payload = await client.request<{ terminals?: CyborgTerminalDirEntry[] }>(
      "cyborg:list_terminals",
      {
        workspaceId,
        ...(options.daemon ? { daemonId: options.daemon } : {}),
      },
    );
    const terminals = payload.terminals ?? [];
    return {
      type: "list",
      data: terminals.map((t) =>
        toTerminalRow(
          { id: t.terminalId, name: t.title ?? "terminal", cwd: t.cwd ?? "" },
          t.cwd ?? "",
        ),
      ),
      schema: terminalSchema,
    };
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_LIST_FAILED", "list terminals", err);
  } finally {
    client.close();
  }
}
