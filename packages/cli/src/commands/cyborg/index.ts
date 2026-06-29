import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runWsListCommand, runWsCreateCommand } from "./workspace.js";
import { runChListCommand, runChCreateCommand } from "./channel.js";
import { runSendCommand } from "./send.js";
import { runSlashCommand } from "./slash.js";
import { runListenCommand } from "./listen.js";
import { runAgentCreateCommand, runAgentListCommand, runAgentPromptCommand } from "./agent.js";
import { runCyboCreateCommand, runCyboListCommand, runCyboSpawnCommand } from "./cybo.js";

export function createCyborgCommand(): Command {
  const cyborg = new Command("cyborg").description("Cyborg7 collaborative workspace commands");

  // Workspace commands
  addJsonAndDaemonHostOptions(
    cyborg
      .command("ws:list")
      .description("List workspaces")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runWsListCommand));

  addJsonAndDaemonHostOptions(
    cyborg
      .command("ws:create")
      .description("Create a workspace")
      .argument("<name>", "Workspace name")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runWsCreateCommand));

  // Channel commands
  addJsonAndDaemonHostOptions(
    cyborg
      .command("ch:list")
      .description("List channels in a workspace")
      .argument("<workspace-id>", "Workspace ID")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runChListCommand));

  addJsonAndDaemonHostOptions(
    cyborg
      .command("ch:create")
      .description("Create a channel")
      .argument("<workspace-id>", "Workspace ID")
      .argument("<name>", "Channel name")
      .option("--description <text>", "Channel description")
      .option("--private", "Make channel private")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runChCreateCommand));

  // Messaging
  addJsonAndDaemonHostOptions(
    cyborg
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
    cyborg
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

  // Listen (stream messages)
  cyborg
    .command("listen")
    .description("Stream messages from a channel (live)")
    .argument("<workspace-id>", "Workspace ID")
    .argument("<channel-id>", "Channel ID")
    .option("--host <host>", "Daemon host")
    .option("--email <email>", "Auth email (dev mode)")
    .option("--token <token>", "Auth token")
    .action(runListenCommand);

  // Agent commands
  addJsonAndDaemonHostOptions(
    cyborg
      .command("agent:create")
      .description("Create an agent in a workspace")
      .argument("<workspace-id>", "Workspace ID")
      .option("--provider <provider>", "Agent provider", "claude")
      .option("--model <model>", "Model name")
      .option("--channel <channel-id>", "Bind agent to a channel")
      .option("--system-prompt <text>", "Custom system prompt")
      .option("--cwd <path>", "Working directory for agent")
      .option("--daemon <daemon-id>", "Target a specific daemon by id")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runAgentCreateCommand));

  addJsonAndDaemonHostOptions(
    cyborg
      .command("agent:list")
      .description("List agents in a workspace")
      .argument("<workspace-id>", "Workspace ID")
      .option("--daemon <daemon-id>", "Target a specific daemon by id")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runAgentListCommand));

  addJsonAndDaemonHostOptions(
    cyborg
      .command("agent:prompt")
      .description("Send a prompt to an agent and stream response")
      .argument("<workspace-id>", "Workspace ID")
      .argument("<agent-id>", "Agent ID")
      .argument("<prompt>", "Prompt text")
      .option("--no-stream", "Fire-and-forget without streaming output")
      .option("--daemon <daemon-id>", "Target a specific daemon by id")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runAgentPromptCommand));

  // Cybo commands
  addJsonAndDaemonHostOptions(
    cyborg
      .command("cybo:create")
      .description("Create a cybo (agent template)")
      .argument("<workspace-id>", "Workspace ID")
      .argument("<slug>", "URL-safe slug (e.g. code-reviewer)")
      .argument("<name>", "Display name")
      .option("--soul <text>", "Personality/instructions (markdown)")
      .option("--soul-file <path>", "Read soul from file")
      .option("--provider <provider>", "Agent provider", "claude")
      .option("--model <model>", "Model name")
      .option("--description <text>", "Short description")
      .option("--avatar <emoji>", "Avatar emoji or URL")
      .option("--role <role>", "Role title (e.g. Research Assistant)")
      .option(
        "--tool-grants <json>",
        "Composio tool grants as JSON, or @<path> to read from a file",
      )
      .option("--daemon <daemon-id>", "Target a specific daemon by id")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runCyboCreateCommand));

  addJsonAndDaemonHostOptions(
    cyborg
      .command("cybo:list")
      .description("List cybos in a workspace")
      .argument("<workspace-id>", "Workspace ID")
      .option("--daemon <daemon-id>", "Target a specific daemon by id")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runCyboListCommand));

  addJsonAndDaemonHostOptions(
    cyborg
      .command("cybo:spawn")
      .description("Spawn an agent from a cybo")
      .argument("<workspace-id>", "Workspace ID")
      .argument("<cybo>", "Cybo ID or slug")
      .option("--channel <channel-id>", "Bind to channel")
      .option("--cwd <path>", "Working directory")
      .option("--daemon <daemon-id>", "Target a specific daemon by id")
      .option("--email <email>", "Auth email (dev mode)")
      .option("--token <token>", "Auth token"),
  ).action(withOutput(runCyboSpawnCommand));

  return cyborg;
}

function collectMentions(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}
