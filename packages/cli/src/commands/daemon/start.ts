import { Command, Option } from "commander";
import chalk from "chalk";
import { DEFAULT_PASEO_HOME, DEFAULT_PORT } from "@getpaseo/server";
import {
  startLocalDaemonForeground,
  startLocalDaemonDetached,
  resolveLocalDaemonState,
  type DaemonStartOptions as StartOptions,
} from "./local-daemon.js";
import { getErrorMessage } from "../../utils/errors.js";

export type { DaemonStartOptions as StartOptions } from "./local-daemon.js";

type RawStartCommandOptions = StartOptions & {
  allowedHosts?: string;
};

export function startCommand(): Command {
  return new Command("start")
    .description("Start the local Paseo daemon")
    .option("--listen <listen>", "Listen target (host:port, port, or unix socket path)")
    .option("--port <port>", `Port to listen on (default: ${DEFAULT_PORT})`)
    .option("--home <path>", `Paseo home directory (default: ${DEFAULT_PASEO_HOME})`)
    .option("--foreground", "Run in foreground (don't daemonize)")
    .option("--no-relay", "Disable relay connection")
    .option("--relay-use-tls", "Use wss:// for the relay connection and pairing offers")
    .option("--no-mcp", "Disable the Agent MCP HTTP endpoint")
    .option("--no-inject-mcp", "Disable auto-injecting the Paseo MCP into created agents")
    .option(
      "--hostnames <hosts>",
      'Daemon hostnames (comma-separated, e.g. "myhost,.example.com" or "true" for any)',
    )
    .addOption(new Option("--allowed-hosts <hosts>").hideHelp())
    .action(async (options: RawStartCommandOptions) => {
      await runStart({
        ...options,
        hostnames: options.hostnames ?? options.allowedHosts,
      });
    });
}

export async function runStart(options: StartOptions): Promise<void> {
  if (options.listen && options.port) {
    console.error(chalk.red("Cannot use --listen and --port together"));
    process.exit(1);
  }

  // Cross-install detection (#733): since #744 unified the daemon home to
  // ~/.cyborg7, both the curl CLI and the desktop app manage the daemon in the
  // SAME home. The pid lock is per-home, so a second daemon started here cannot
  // bind it and would just crash on startup — and if the desktop app owns the
  // home it would compete for the daemon identity/port. Detect an already-running
  // daemon up front and no-op instead of spawning a competitor, deferring to the
  // desktop app when it owns the home, so mixing install methods stays idempotent.
  const existing = resolveLocalDaemonState({ home: options.home });
  if (existing.running && existing.pidInfo) {
    const { pid } = existing.pidInfo;
    const where = existing.listen ? ` listening on ${existing.listen}` : "";
    if (existing.pidInfo.desktopManaged) {
      console.log(
        chalk.yellow(
          `The Cyborg desktop app already manages the daemon in this home (PID ${pid}${where}).`,
        ),
      );
      console.log(
        chalk.dim(
          "It runs and updates the daemon for you, so there is nothing to start. " +
            "Quit Cyborg first if you want to run a separate headless daemon.",
        ),
      );
      return;
    }
    console.log(chalk.green(`A daemon is already running in this home (PID ${pid}${where}).`));
    console.log(chalk.dim("Nothing to do. Use `cyborg daemon restart` to restart it."));
    return;
  }

  if (!options.foreground) {
    try {
      const startup = await startLocalDaemonDetached(options);
      console.log(chalk.green(`Daemon starting in background (PID ${startup.pid ?? "unknown"}).`));
      console.log(chalk.dim(`Logs: ${startup.logPath}`));
    } catch (err) {
      exitWithError(getErrorMessage(err));
    }
    return;
  }
  try {
    const status = startLocalDaemonForeground(options);
    process.exit(status);
  } catch (err) {
    const message = getErrorMessage(err);
    exitWithError(`Failed to start daemon: ${message}`);
  }
}

function exitWithError(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}
