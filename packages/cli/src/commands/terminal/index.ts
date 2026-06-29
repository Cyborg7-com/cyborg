import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addDaemonHostOption, addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runCaptureCommand } from "./capture.js";
import { runCreateCommand } from "./create.js";
import { runKillCommand } from "./kill.js";
import { runLsCommand } from "./ls.js";
import { runSendKeysCommand } from "./send-keys.js";

export function createTerminalCommand(): Command {
  const terminal = new Command("terminal").description("Manage workspace terminals");

  addJsonAndDaemonHostOptions(
    terminal
      .command("ls")
      .description("List terminals (use --workspace to reach a remote daemon via the relay)")
      .option("--all", "List terminals across all workspaces")
      .option("--cwd <path>", "Workspace directory")
      // Cyborg/relay path: list a (possibly remote) daemon's terminals.
      .option("--workspace <id>", "List terminals in a workspace (routes via the relay)")
      .option("--daemon <id>", "Target a specific daemon by id (with --workspace)")
      .option("--email <email>", "Auth email (dev mode, with --workspace)")
      .option("--token <token>", "Auth token (with --workspace)"),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    terminal
      .command("create")
      .description("Create a terminal")
      .option("--cwd <path>", "Working directory")
      .option("--name <name>", "Terminal name")
      // Bind the terminal to a workspace so it appears in that workspace's UI
      // Terminals sidebar (routes through the cyborg:start_terminal RPC).
      .option("--workspace <id>", "Bind the terminal to a workspace (shows in the UI sidebar)")
      .option("--daemon <id>", "Target daemon by id (with --workspace, when several are connected)")
      .option("--email <email>", "Auth email (dev mode, with --workspace)")
      .option("--token <token>", "Auth token (with --workspace)"),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(
    terminal
      .command("kill")
      .description("Kill a terminal")
      .argument("<terminal-id>", "Terminal ID, ID prefix, or name"),
  ).action(withOutput(runKillCommand));

  addDaemonHostOption(
    terminal
      .command("capture")
      .description(
        "Capture terminal output (use --workspace to reach a remote daemon via the relay)",
      )
      .argument("<terminal-id>", "Terminal ID, ID prefix, or name")
      .option("--start <n>", "Capture start line")
      .option("--end <n>", "Capture end line")
      .option("-S, --scrollback", "Capture from the beginning of scrollback")
      .option("--ansi", "Preserve ANSI escape codes")
      .option("--json", "Output in JSON format")
      // Cyborg/relay path.
      .option("--workspace <id>", "Capture a workspace terminal (routes via the relay)")
      .option("--daemon <id>", "Target a specific daemon by id (with --workspace)")
      .option("--email <email>", "Auth email (dev mode, with --workspace)")
      .option("--token <token>", "Auth token (with --workspace)"),
  ).action(runCaptureCommand);

  addDaemonHostOption(
    terminal
      .command("send-keys")
      .description(
        "Send keys to a terminal (use --workspace to reach a remote daemon via the relay)",
      )
      .argument("<terminal-id>", "Terminal ID, ID prefix, or name")
      .argument("<keys...>", "Keys to send")
      .option("-l, --literal", "Send raw keys without interpreting special tokens")
      .option("--json", "Output in JSON format")
      // Cyborg/relay path.
      .option("--workspace <id>", "Send to a workspace terminal (routes via the relay)")
      .option("--daemon <id>", "Target a specific daemon by id (with --workspace)")
      .option("--email <email>", "Auth email (dev mode, with --workspace)")
      .option("--token <token>", "Auth token (with --workspace)"),
  ).action(runSendKeysCommand);

  return terminal;
}
