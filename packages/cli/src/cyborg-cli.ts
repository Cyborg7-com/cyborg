import { Command } from "commander";
import { withOutput } from "./output/index.js";
import {
  addJsonOption,
  addJsonAndDaemonHostOptions,
  collectMultiple,
} from "./utils/command-options.js";
import { resolveCliVersion } from "./version.js";
import { runWsListCommand, runWsCreateCommand } from "./commands/cyborg/workspace.js";
import { runChListCommand, runChCreateCommand } from "./commands/cyborg/channel.js";
import { runSendCommand } from "./commands/cyborg/send.js";
import { createDaemonCommand } from "./commands/daemon/index.js";
import { createTerminalCommand } from "./commands/terminal/index.js";
import { runLoginCommand } from "./commands/cyborg/login.js";
import { runWhoamiCommand } from "./commands/cyborg/whoami.js";
import { runCyborgStatusCommand } from "./commands/cyborg/status.js";
import { runSlashCommand } from "./commands/cyborg/slash.js";
import { runSlashModelCommand } from "./commands/cyborg/slash-model.js";
import { runChannelModelCommand } from "./commands/cyborg/channel-model.js";
import { runListenCommand } from "./commands/cyborg/listen.js";
import {
  runAgentCreateCommand,
  runAgentListCommand,
  runAgentPromptCommand,
  runAgentStopCommand,
  runAgentModeCommand,
  runAgentModelCommand,
} from "./commands/cyborg/agent.js";
import {
  runCyboCreateCommand,
  runCyboListCommand,
  runCyboSpawnCommand,
} from "./commands/cyborg/cybo.js";
import {
  runTaskCreateCommand,
  runTaskListCommand,
  runTaskUpdateCommand,
  runTaskArchiveCommand,
  runTaskDeleteCommand,
  runTaskBulkUpdateCommand,
} from "./commands/cyborg/task.js";
import { runProjectListCommand } from "./commands/cyborg/project.js";

function collectMentions(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export function createCyborgCli(): Command {
  const program = new Command();

  program
    .name("cyborg")
    .description("Cyborg7 — collaborative AI workspace CLI")
    .version(resolveCliVersion(), "-v, --version")
    .option("-o, --format <format>", "output format: table, json, yaml", "table")
    .option("--json", "output in JSON format")
    .option("-q, --quiet", "minimal output (IDs only)")
    .option("--no-headers", "omit table headers")
    .option("--no-color", "disable colored output");

  // Local daemon / agent host (also under `paseo daemon`) — lets a headless
  // server run `cyborg daemon start --foreground` as an agent host.
  program.addCommand(createDaemonCommand());

  // Terminal sessions on a daemon: ls / create / send-keys / capture / kill.
  program.addCommand(createTerminalCommand());

  // Auth: log in to the relay + claim a daemon under your account.
  program
    .command("login")
    .description("Authenticate to the Cyborg relay and save credentials")
    .option("--url <url>", "Relay URL (default: https://relay.cyborg7.com)")
    .option("--email <email>", "Account email")
    .option("--password <password>", "Account password (or set CYBORG_PASSWORD)")
    .option("--token <token>", "Use an existing token instead of email/password")
    .option("--user-id <id>", "User id (required with --token)")
    .action((options, command) => runLoginCommand(options, command));

  // Show the currently logged-in user (email + userId + relay) from saved creds.
  addJsonOption(
    program
      .command("whoami")
      .description("Show the currently logged-in user (email, userId, relay)"),
  ).action(withOutput(runWhoamiCommand));

  // Auth + local daemon reachability at a glance.
  addJsonAndDaemonHostOptions(
    program.command("status").description("Show auth status and local daemon reachability"),
  ).action(withOutput(runCyborgStatusCommand));

  // ─── Workspace ─────────────────────────────────────────────────────

  addJsonAndDaemonHostOptions(
    program
      .command("ws:list")
      .alias("ws")
      .description("List workspaces")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runWsListCommand));

  addJsonAndDaemonHostOptions(
    program
      .command("ws:create")
      .description("Create a workspace")
      .argument("<name>", "Workspace name")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runWsCreateCommand));

  // ─── Channels ──────────────────────────────────────────────────────

  addJsonAndDaemonHostOptions(
    program
      .command("ch:list")
      .alias("ch")
      .description("List channels in a workspace")
      .argument("<workspace-id>", "Workspace ID")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runChListCommand));

  addJsonAndDaemonHostOptions(
    program
      .command("ch:create")
      .description("Create a channel")
      .argument("<workspace-id>", "Workspace ID")
      .argument("<name>", "Channel name")
      .option("--description <text>", "Channel description")
      .option("--private", "Make channel private")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runChCreateCommand));

  // ─── Messaging ─────────────────────────────────────────────────────

  addJsonAndDaemonHostOptions(
    program
      .command("send")
      .description("Send a message to a channel")
      .argument("<workspace-id>", "Workspace ID")
      .argument("<channel-id>", "Channel ID")
      .argument("<text>", "Message text")
      .option("--mention <id>", "Mention a user or agent ID (repeatable)", collectMentions, [])
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runSendCommand));

  // Slash commands (channel actions, e.g. /summarize)
  addJsonAndDaemonHostOptions(
    program
      .command("slash")
      .description("Run a channel slash command (e.g. summarize) and wait for the result")
      .argument("<workspace-id>", "Workspace ID")
      .argument("<channel-id>", "Channel ID")
      .argument("<trigger>", "Command trigger (e.g. summarize)")
      .argument("[args...]", "Optional command arguments (e.g. message count)")
      .option(
        "--daemon <daemon-id>",
        "Target daemon (required by the relay when several are connected)",
      )
      .option("--no-wait", "Only dispatch — don't wait for the result message")
      .option("--timeout <seconds>", "How long to wait for the result", "120")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runSlashCommand));

  // Preferred model for channel AI commands (/summarize etc.). Omit provider/model
  // and pass --clear to reset to auto-resolve (the zero-config default).
  addJsonAndDaemonHostOptions(
    program
      .command("slash:model")
      .description("Set or clear your preferred model for channel AI commands (/summarize etc.)")
      .argument("<workspace-id>", "Workspace ID")
      .argument("[provider]", "Provider id (e.g. pi, claude)")
      .argument("[model]", "Model id (e.g. claude-haiku-4-5)")
      .option("--clear", "Clear the preference (back to auto-resolve)")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runSlashModelCommand));

  // Per-CHANNEL model override (wins over the user default). Omit provider/model
  // and pass --clear to inherit the default.
  addJsonAndDaemonHostOptions(
    program
      .command("ch:model")
      .description("Set or clear a channel's model override for AI commands (/summarize etc.)")
      .argument("<workspace-id>", "Workspace ID")
      .argument("<channel-id>", "Channel ID")
      .argument("[provider]", "Provider id (e.g. pi, claude)")
      .argument("[model]", "Model id (e.g. claude-haiku-4-5)")
      .option("--clear", "Clear the override (inherit the user default / auto-resolve)")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runChannelModelCommand));

  program
    .command("listen")
    .description("Stream messages from a channel (live)")
    .argument("<workspace-id>", "Workspace ID")
    .argument("<channel-id>", "Channel ID")
    .option("--host <host>", "Daemon host")
    .option("--email <email>", "Auth email (dev mode)")
    .option("--token <token>", "Auth token")
    .action(runListenCommand);

  // ─── Agents ────────────────────────────────────────────────────────

  addJsonAndDaemonHostOptions(
    program
      .command("agent:create")
      .description("Create an agent in a workspace")
      .argument("<workspace-id>", "Workspace ID")
      .option("--provider <provider>", "Agent provider", "claude")
      .option("--model <model>", "Model name")
      .option("--channel <channel-id>", "Bind agent to a channel")
      .option("--system-prompt <text>", "Custom system prompt")
      .option("--cwd <path>", "Working directory for agent")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runAgentCreateCommand));

  addJsonAndDaemonHostOptions(
    program
      .command("agent:list")
      .alias("agents")
      .description("List agents in a workspace")
      .argument("<workspace-id>", "Workspace ID")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runAgentListCommand));

  addJsonAndDaemonHostOptions(
    program
      .command("agent:prompt")
      .description("Send a prompt to an agent")
      .argument("<workspace-id>", "Workspace ID")
      .argument("<agent-id>", "Agent ID")
      .argument("<prompt>", "Prompt text")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runAgentPromptCommand));

  addJsonAndDaemonHostOptions(
    program
      .command("agent:stop")
      .description("Interrupt an agent's active run (clears a stuck/zombie turn)")
      .argument("<workspace-id>", "Workspace ID")
      .argument("<agent-id>", "Agent ID")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runAgentStopCommand));

  addJsonAndDaemonHostOptions(
    program
      .command("agent:mode")
      .description(
        "Set an agent's permission mode (default | plan | acceptEdits | bypassPermissions)",
      )
      .argument("<workspace-id>", "Workspace ID")
      .argument("<agent-id>", "Agent ID")
      .argument("<mode>", "Mode id (e.g. bypassPermissions)")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runAgentModeCommand));

  addJsonAndDaemonHostOptions(
    program
      .command("agent:model")
      .description("Set an agent's model ('default' clears the override)")
      .argument("<workspace-id>", "Workspace ID")
      .argument("<agent-id>", "Agent ID")
      .argument("<model>", "Model id (e.g. claude-opus-4-8) or 'default'")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runAgentModelCommand));

  // ─── Cybos ─────────────────────────────────────────────────────────

  addJsonAndDaemonHostOptions(
    program
      .command("cybo:create")
      .description("Create a cybo (agent template)")
      .argument("<workspace-id>", "Workspace ID")
      .argument("<slug>", "URL-safe slug (e.g., code-reviewer)")
      .argument("<name>", "Display name")
      .option("--soul <text>", "Soul (personality) as inline text")
      .option("--soul-file <path>", "Soul from a markdown file")
      .option("--provider <provider>", "Agent provider", "claude")
      .option("--model <model>", "Model name")
      .option("--description <text>", "Short description")
      .option("--avatar <emoji-or-url>", "Avatar emoji or URL")
      .option("--role <role>", "Role label (e.g., Code Reviewer)")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runCyboCreateCommand));

  addJsonAndDaemonHostOptions(
    program
      .command("cybo:list")
      .alias("cybos")
      .description("List cybos in a workspace")
      .argument("<workspace-id>", "Workspace ID")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runCyboListCommand));

  addJsonAndDaemonHostOptions(
    program
      .command("cybo:spawn")
      .description("Spawn an agent from a cybo")
      .argument("<workspace-id>", "Workspace ID")
      .argument("<cybo>", "Cybo ID or slug")
      .option("--channel <channel-id>", "Bind agent to a channel")
      .option("--cwd <path>", "Working directory for agent")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runCyboSpawnCommand));

  // ─── Tasks ─────────────────────────────────────────────────────────

  addJsonAndDaemonHostOptions(
    program
      .command("task:create")
      .description("Create a task in a workspace")
      .argument("<workspace-id>", "Workspace ID")
      .argument("<title>", "Task title")
      .option("--description <text>", "Task description")
      .option("--assignee <id>", "Assignee user or agent ID")
      .option("--due <iso>", "Due date (ISO 8601, e.g. 2026-06-30T17:00:00Z)")
      .option("--channel <channel-id>", "Channel ID (task target)")
      .option("--priority <priority>", "Priority (e.g. urgent, high, medium, low)")
      .option("--project <project-id>", "Project ID (tp_ id or chat project id)")
      .option("--parent <task-id>", "Parent task ID (creates a subtask)")
      .option("--state <state-id>", "Workflow state ID")
      .option("--start <iso>", "Start date (ISO 8601)")
      .option("--label <name>", "Label name (repeatable)", collectMultiple, [])
      .option("--cycle <cycle-id>", "Cycle ID")
      .option("--module <id>", "Module ID (repeatable)", collectMultiple, [])
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runTaskCreateCommand));

  addJsonAndDaemonHostOptions(
    program
      .command("task:list")
      .alias("tasks")
      .description("List tasks in a workspace")
      .argument("<workspace-id>", "Workspace ID")
      .option("--status <status>", "Filter by status")
      .option("--assignee <id>", "Filter by assignee user or agent ID")
      .option("--project <project-id>", "Filter by project ID")
      .option("--limit <n>", "Max number of tasks to return")
      .option("--cursor <cursor>", "Pagination cursor")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runTaskListCommand));

  addJsonAndDaemonHostOptions(
    program
      .command("task:update")
      .description("Update a task")
      .argument("<workspace-id>", "Workspace ID")
      .argument("<task-id>", "Task ID")
      .option("--status <status>", "New status")
      .option("--title <text>", "New title")
      .option("--description <text>", "New description")
      .option("--assignee <id>", "Assignee user or agent ID")
      .option("--result <text>", "Result text")
      .option("--due <iso>", "Due date (ISO 8601)")
      .option("--priority <priority>", "Priority (e.g. urgent, high, medium, low)")
      .option("--project <project-id>", "Project ID")
      .option("--parent <task-id>", "Parent task ID")
      .option("--state <state-id>", "Workflow state ID")
      .option("--start <iso>", "Start date (ISO 8601)")
      .option("--label <name>", "Label name (repeatable)", collectMultiple, [])
      .option("--cycle <cycle-id>", "Cycle ID")
      .option("--module <id>", "Module ID (repeatable)", collectMultiple, [])
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runTaskUpdateCommand));

  addJsonAndDaemonHostOptions(
    program
      .command("task:archive")
      .description("Archive a task (or restore with --unarchive)")
      .argument("<workspace-id>", "Workspace ID")
      .argument("<task-id>", "Task ID")
      .option("--unarchive", "Restore an archived task instead of archiving")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runTaskArchiveCommand));

  addJsonAndDaemonHostOptions(
    program
      .command("task:delete")
      .description("Delete a task")
      .argument("<workspace-id>", "Workspace ID")
      .argument("<task-id>", "Task ID")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runTaskDeleteCommand));

  addJsonAndDaemonHostOptions(
    program
      .command("task:bulk-update")
      .description("Update many tasks at once")
      .argument("<workspace-id>", "Workspace ID")
      .argument("<task-ids...>", "One or more task IDs")
      .option("--status <status>", "New status")
      .option("--priority <priority>", "Priority (e.g. urgent, high, medium, low)")
      .option("--assignee <id>", "Assignee user or agent ID")
      .option("--due <iso>", "Due date (ISO 8601)")
      .option("--archived", "Archive the tasks (sets archivedAt to now)")
      .option("--unarchive", "Restore the tasks (clears archivedAt)")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runTaskBulkUpdateCommand));

  // ─── Projects ──────────────────────────────────────────────────────

  addJsonAndDaemonHostOptions(
    program
      .command("project:list")
      .alias("projects")
      .description("List task projects in a workspace")
      .argument("<workspace-id>", "Workspace ID")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runProjectListCommand));

  return program;
}
