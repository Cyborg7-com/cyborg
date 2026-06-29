import { randomUUID } from "node:crypto";
import type { Command } from "commander";
// @xterm/headless is CJS — default-import the namespace (the ESM named import
// `{ Terminal }` builds but throws at runtime). Mirrors server/src/terminal/terminal.ts.
import xterm from "@xterm/headless";
import { renderError, toCommandError } from "../../output/render.js";
import { connectCyborg } from "../cyborg/client.js";
import {
  connectTerminalClient,
  resolveTerminalId,
  toTerminalCommandError,
  type TerminalCommandOptions,
} from "./shared.js";

export interface TerminalCaptureOptions extends TerminalCommandOptions {
  start?: string;
  end?: string;
  scrollback?: boolean;
  ansi?: boolean;
  // Cyborg/relay path — capture a possibly-REMOTE daemon's terminal screen.
  workspace?: string;
  daemon?: string;
  email?: string;
  token?: string;
}

export async function runCaptureCommand(
  terminalId: string,
  _options: TerminalCaptureOptions,
  command: Command,
): Promise<void> {
  const options = command.optsWithGlobals() as TerminalCaptureOptions;

  try {
    const payload = await executeCaptureCommand(terminalId, options);
    if (options.json) {
      process.stdout.write(
        JSON.stringify(
          {
            terminalId: payload.terminalId,
            lines: payload.lines,
            totalLines: payload.totalLines,
          },
          null,
          2,
        ) + "\n",
      );
      return;
    }

    if (payload.lines.length > 0) {
      process.stdout.write(payload.lines.join("\n") + "\n");
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

async function executeCaptureCommand(
  terminalId: string,
  options: TerminalCaptureOptions,
): Promise<{ terminalId: string; lines: string[]; totalLines: number }> {
  // Cyborg/relay path: capture a (possibly remote) daemon's terminal by subscribing
  // over the relay, replaying the daemon's screen ring through a headless xterm.
  if (options.workspace) {
    return runCyborgCapture(terminalId, options);
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

    const start = options.scrollback ? 0 : parseLineNumber("--start", options.start);
    const end = parseLineNumber("--end", options.end);

    return await client.captureTerminal(resolvedId, {
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
      stripAnsi: !options.ansi,
    });
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_CAPTURE_FAILED", "capture terminal output", err);
  } finally {
    await client.close().catch(() => {}); // intentional: best-effort WS teardown; the real error is already surfaced
  }
}

// Capture a (possibly remote) terminal's screen over the relay: subscribe, collect
// the daemon's replayed output ring (ANSI), and render it through a headless xterm
// to recover the visible screen + scrollback as plain lines. Mirrors how the UI
// paints a re-attach, but server-less.
async function runCyborgCapture(
  terminalId: string,
  options: TerminalCaptureOptions,
): Promise<{ terminalId: string; lines: string[]; totalLines: number }> {
  let client: Awaited<ReturnType<typeof connectCyborg>>;
  try {
    client = await connectCyborg({
      host: options.host,
      token: options.token,
      email: options.email,
    });
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_CAPTURE_FAILED", "connect to cyborg relay", err);
  }

  const daemonScope = options.daemon ? { daemonId: options.daemon } : {};
  try {
    let cols = 120;
    let rows = 40;
    const chunks: string[] = [];
    const off = client.onBroadcast((type, payload) => {
      const p = payload as {
        terminalId?: string;
        data?: string;
        state?: { rows?: number; cols?: number };
      };
      if (p.terminalId !== terminalId) return;
      if (type === "cyborg:terminal_snapshot" && p.state?.rows) {
        rows = p.state.rows;
        cols = p.state.cols ?? cols;
      }
      if (type === "cyborg:terminal_output" && typeof p.data === "string") {
        chunks.push(p.data);
      }
    });
    client.fire("cyborg:subscribe_terminal", {
      workspaceId: options.workspace,
      ...daemonScope,
      terminalId,
      attachId: randomUUID(),
    });
    // The daemon replays the screen ring immediately on subscribe; give it a beat to
    // arrive (and to cover a cold-daemon re-attach), then stop listening.
    await new Promise((r) => setTimeout(r, 1500));
    off();
    client.fire("cyborg:unsubscribe_terminal", {
      workspaceId: options.workspace,
      ...daemonScope,
      terminalId,
    });

    const term = new xterm.Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
    // Join all replayed chunks into one write: xterm parses the whole stream and
    // fires the callback once its write queue has drained, so a single write is
    // equivalent to (and simpler than) per-chunk callback bookkeeping.
    await new Promise<void>((resolve) => {
      if (chunks.length === 0) return resolve();
      term.write(chunks.join(""), resolve);
    });

    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    term.dispose();
    return { terminalId, lines, totalLines: lines.length };
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_CAPTURE_FAILED", "capture terminal output", err);
  } finally {
    client.close();
  }
}

function parseLineNumber(flag: string, value?: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw {
      code: "INVALID_LINE_NUMBER",
      message: `Invalid ${flag} value: ${value}`,
      details: "Use an integer line number.",
    };
  }
  return parsed;
}
