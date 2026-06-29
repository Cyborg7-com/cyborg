import type { Command } from "commander";
import { renderError, toCommandError } from "../../output/render.js";
import { connectCyborg } from "../cyborg/client.js";
import {
  connectTerminalClient,
  resolveTerminalId,
  toTerminalCommandError,
  type TerminalCommandOptions,
} from "./shared.js";

export interface TerminalSendKeysOptions extends TerminalCommandOptions {
  literal?: boolean;
  // Cyborg/relay path — send keys to a possibly-REMOTE daemon's terminal.
  workspace?: string;
  daemon?: string;
  email?: string;
  token?: string;
}

export async function runSendKeysCommand(
  terminalId: string,
  keys: string[],
  _options: TerminalSendKeysOptions,
  command: Command,
): Promise<void> {
  const options = command.optsWithGlobals() as TerminalSendKeysOptions;

  try {
    const payload = await executeSendKeysCommand(terminalId, keys, options);
    if (options.json) {
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    }
  } catch (err) {
    const output = renderError(toCommandError(err), {
      format: options.json ? "json" : "table",
      noColor: options.color === false,
    });
    process.stderr.write(output + "\n");
    process.exit(1);
  }
}

async function executeSendKeysCommand(
  terminalId: string,
  keys: string[],
  options: TerminalSendKeysOptions,
): Promise<{ terminalId: string; keysSent: number }> {
  const data = keys.map((key) => resolveKeyToken(key, options.literal === true)).join("");

  // Cyborg/relay path: forward keystrokes to a (possibly remote) daemon's terminal
  // by daemonId. terminal_input is one-way (no ack), so we fire + brief drain.
  if (options.workspace) {
    let client: Awaited<ReturnType<typeof connectCyborg>>;
    try {
      client = await connectCyborg({
        host: options.host,
        token: options.token,
        email: options.email,
      });
    } catch (err) {
      throw toTerminalCommandError("TERMINAL_SEND_KEYS_FAILED", "connect to cyborg relay", err);
    }
    try {
      client.fire("cyborg:terminal_input", {
        workspaceId: options.workspace,
        ...(options.daemon ? { daemonId: options.daemon } : {}),
        terminalId,
        data,
      });
      // Let the relay forward to the daemon before we tear the socket down.
      await new Promise((r) => setTimeout(r, 250));
      return { terminalId, keysSent: data.length };
    } catch (err) {
      throw toTerminalCommandError("TERMINAL_SEND_KEYS_FAILED", "send terminal keys", err);
    } finally {
      client.close();
    }
  }

  const { client } = await connectTerminalClient(options.host);

  try {
    const resolvedId = await resolveTerminalId(client, terminalId);
    if (!resolvedId) {
      throw {
        code: "TERMINAL_NOT_FOUND",
        message: `No terminal found matching: ${terminalId}`,
        details: "Use `paseo terminal ls --all` to list available terminals.",
      };
    }

    client.sendTerminalInput(resolvedId, { type: "input", data });

    return {
      terminalId: resolvedId,
      keysSent: data.length,
    };
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_SEND_KEYS_FAILED", "send terminal keys", err);
  } finally {
    await client.close().catch(() => {}); // intentional: best-effort WS teardown; the real error is already surfaced
  }
}

function resolveKeyToken(key: string, literal: boolean): string {
  if (literal) {
    return key;
  }

  switch (key) {
    case "Enter":
      return "\r";
    case "Tab":
      return "\t";
    case "Escape":
      return "\u001b";
    case "Space":
      return " ";
    case "BSpace":
      return "\u007f";
    case "C-c":
      return "\u0003";
    case "C-d":
      return "\u0004";
    case "C-z":
      return "\u001a";
    case "C-l":
      return "\u000c";
    case "C-a":
      return "\u0001";
    case "C-e":
      return "\u0005";
    default:
      return key;
  }
}
