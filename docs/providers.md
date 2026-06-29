# Providers

Cyborg7 does not ship its own coding agent. Each daemon launches and supervises
**existing agent CLIs you have already installed and authenticated** on that
machine. Your subscriptions, your config, your skills, and your MCP servers stay
intact — Cyborg7 puts a workspace, a UI, a CLI, and a relay on top.

This page explains how providers work and how to connect each one.

## How agents run

Every daemon spawns its agents as **local child processes** on the machine that
runs the daemon. There is no cloud execution and no bridge plugin in between. When
the daemon starts an agent it injects Cyborg7's **MCP tools** so the agent can act
as a full workspace member — read channels, post messages, and work on tasks like
any human teammate.

Because agents run locally, they inherit the full access of the machine that hosts
the daemon: its files, tools, credentials, and provider logins. A prompt from a
teammate on another machine travels through the relay to your daemon, and your
daemon runs the agent locally — the relay only brokers messages, it never runs
agent code.

> [!IMPORTANT]
> At least one provider CLI must be **installed and authenticated on the machine
> running the daemon**. Agents run where the daemon runs; if no provider is
> available there, the daemon has nothing to launch.

## Two integration paths

Cyborg7 connects to providers in two ways:

- **Claude** runs through the
  [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).
  The SDK drives Claude Code directly and streams its output back to the daemon.
- **The others** — Codex, Copilot, OpenCode, and Pi — are spawned as local
  processes and driven over **stdio**, using the **Agent Client Protocol (ACP)**
  conventions (`agentclientprotocol.com`). The daemon launches the CLI, speaks the
  protocol over its standard input/output, and streams the agent's responses into
  the workspace.

In both cases the underlying CLI is yours: you install it, you log in, and the
daemon launches it. Models, modes, and permissions are discovered from the running
agent process, so you get each provider's real capabilities rather than a
hardcoded subset.

## Supported providers

Cyborg7 ships built-in support for the providers below. Install and authenticate
the underlying CLI per its own documentation, then select it when you create an
agent.

### Claude Code

Anthropic's coding agent — multi-tool, MCP support, streaming, and deep reasoning.
This is the provider driven through `@anthropic-ai/claude-agent-sdk`.

Install and authenticate Claude Code per
[Anthropic's documentation](https://docs.anthropic.com/en/docs/claude-code). Claude
Code authenticates either with an Anthropic login or an API key, following its own
setup flow.

### Codex

OpenAI's Codex workspace agent, with sandbox controls and optional network access.

Install and authenticate the
[Codex CLI](https://github.com/openai/codex) per its own documentation, then make
sure it is on your `PATH` on the daemon machine.

### Copilot

GitHub Copilot, connected over the Agent Client Protocol with dynamic modes and
session support.

Install and authenticate the
[GitHub Copilot CLI](https://github.com/features/copilot) per GitHub's
documentation. The Copilot CLI handles its own authentication; once you are signed
in there, the daemon can launch it.

### OpenCode

An open-source coding assistant with multi-provider model support.

Install and authenticate [OpenCode](https://opencode.ai/) per its own
documentation, including configuring whichever model provider you want it to use.

### Pi

A minimal, terminal-based coding agent with multi-provider LLM support. The daemon
talks to Pi through its RPC mode and passes Cyborg7's system prompts to it without
replacing Pi's own.

Install and authenticate [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
per its own documentation. Pi needs a one-time login before first use.

## Choosing a provider per agent

Providers are not mutually exclusive. With more than one CLI installed and
authenticated on a daemon, you can pick the right model and harness per agent —
for example, one agent on Claude Code and another on Codex in the same workspace.
Each agent is created with a provider and a model; the daemon resolves the rest at
launch time.

## Cybos

A **Cybo** is a custom AI personality layered on top of a provider — an identity
plus a system prompt, defined as a `cybo.json` + `soul.md` pair. A Cybo still runs
through a provider on your daemon; it just adds a name, a role, and a personality
on top. To define and run one, see [Cybos](./cybos.md).

## Custom providers

The built-in providers above cover the common agents. Because the non-Claude
integration path is ACP over stdio, the daemon can also drive other ACP-speaking
agent CLIs. The list above is the supported set in this repository; anything
beyond it is configured by you and is not covered here.

---

See the [documentation index](./README.md) for the rest of the guides, or the
[project README](../README.md) for the architecture at a glance.
