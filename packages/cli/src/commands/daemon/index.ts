import { Command, Option } from "commander";
import { startCommand } from "./start.js";
import { runStatusCommand } from "./status.js";
import { runStopCommand } from "./stop.js";
import { runRestartCommand } from "./restart.js";
import { runDaemonClaimCommand } from "./claim.js";
import { runDaemonUpdateCommand } from "./update.js";
import { runDoctorCommand } from "./doctor.js";
import { runSetPasswordCommand } from "./set-password.js";
import { pairCommand } from "./pair.js";
import { withOutput } from "../../output/index.js";
import { addJsonOption } from "../../utils/command-options.js";

function resolveHostnamesOption(hostnames: unknown, allowedHosts: unknown): string | undefined {
  if (typeof hostnames === "string") return hostnames;
  if (typeof allowedHosts === "string") return allowedHosts;
  return undefined;
}

export function createDaemonCommand(): Command {
  const daemon = new Command("daemon").description("Manage the Paseo daemon");

  daemon.addCommand(startCommand());
  daemon.addCommand(pairCommand());

  addJsonOption(daemon.command("status").description("Show local daemon status"))
    .option("--home <path>", "Paseo home directory (default: ~/.cyborg7)")
    .action(withOutput(runStatusCommand));

  addJsonOption(
    daemon
      .command("doctor")
      .description("Diagnose the daemon: version, relay, online state, update available"),
  )
    .option("--home <path>", "Paseo home directory (default: ~/.cyborg7)")
    .action(withOutput(runDoctorCommand));

  addJsonOption(daemon.command("stop").description("Stop the local daemon"))
    .option("--home <path>", "Paseo home directory (default: ~/.cyborg7)")
    .option("--timeout <seconds>", "Wait timeout before failing (default: 15)")
    .option("--force", "Send SIGKILL if graceful stop times out")
    .option("--kill-timeout <seconds>", "Wait after SIGKILL before failing (default: 3)")
    .action(withOutput(runStopCommand));

  addJsonOption(daemon.command("restart").description("Restart the local daemon"))
    .option("--home <path>", "Paseo home directory (default: ~/.cyborg7)")
    .option("--timeout <seconds>", "Wait timeout before force step (default: 15)")
    .option("--force", "Send SIGKILL if graceful stop times out")
    .option(
      "--listen <listen>",
      "Listen target for restarted daemon (host:port, port, or unix socket)",
    )
    .option("--port <port>", "Port for restarted daemon listen target")
    .option("--no-relay", "Disable relay on restarted daemon")
    .option("--no-mcp", "Disable Agent MCP on restarted daemon")
    .option("--no-inject-mcp", "Disable auto-injecting the Paseo MCP into created agents")
    .option(
      "--hostnames <hosts>",
      'Daemon hostnames (comma-separated, e.g. "myhost,.example.com" or "true" for any)',
    )
    .addOption(new Option("--allowed-hosts <hosts>").hideHelp())
    .action(
      withOutput((...args) => {
        const [options, command] = args.slice(-2) as [(typeof args)[number], Command];
        return runRestartCommand(
          {
            ...options,
            hostnames: resolveHostnamesOption(options.hostnames, options.allowedHosts),
          },
          command,
        );
      }),
    );

  addJsonOption(
    daemon
      .command("set-password")
      .description("Prompt for and save a hashed daemon password to config.json"),
  )
    .option("--home <path>", "Paseo home directory (default: ~/.cyborg7)")
    .action(withOutput(runSetPasswordCommand));

  addJsonOption(
    daemon
      .command("update")
      .description("Update the daemon to the latest code/package and restart it"),
  )
    .option("--home <path>", "Paseo home directory (default: ~/.cyborg7)")
    .option("--port <port>", "Port for the restarted daemon listen target")
    .option("--listen <listen>", "Listen target for the restarted daemon")
    .option("--no-build", "Skip the build step (source installs)")
    .option("--timeout <seconds>", "Stop timeout before force step (default: 15)")
    .option("--force", "Update + restart even if already on the latest version")
    .option(
      "--verify-timeout <seconds>",
      "Wait for the updated daemon to come online before rolling back (default: 30)",
    )
    .action(withOutput(runDaemonUpdateCommand));

  addJsonOption(
    daemon
      .command("claim")
      .description("Claim this daemon for your logged-in account (writes daemon-owner)"),
  )
    .option("--home <path>", "Paseo home directory (default: ~/.cyborg7)")
    .option("--force", "Reassign even if already claimed by another user")
    .action(withOutput(runDaemonClaimCommand));

  return daemon;
}
