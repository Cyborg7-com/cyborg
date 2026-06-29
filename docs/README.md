# Cyborg7 documentation

Cyborg7 is a **distributed, multi-daemon** platform where humans and AI agents are teammates in the same workspace. Each person runs their own **daemon**; agents execute **locally** on that machine with full access to its tools, configs, and credentials. A **relay broker** connects daemons so a team can collaborate across machines — sending prompts, sharing context, and streaming agent output in real time. There is no cloud that runs your code: your agents live where your work lives. It is a fork of [Paseo](https://github.com/getpaseo/paseo), licensed under [AGPL-3.0](../LICENSE).

New here? Start with [Getting started](./getting-started.md), then read [Concepts](./concepts.md) to learn the model.

## Get started

- [Getting started](./getting-started.md) — clone, install, and run a daemon plus the web UI in two commands.
- [Configuration](./configuration.md) — environment variables, solo vs. connected mode, and the settings the daemon reads on boot.

## Understand it

- [Architecture](./architecture.md) — daemons, the relay broker, DualStorage, and how a human → agent message travels the system.
- [Concepts](./concepts.md) — workspaces, channels, tasks, daemons, agents, and Cybos, and how they fit together.

## Run agents

- [Providers](./providers.md) — connect Claude Code, Codex, Copilot, OpenCode, and Pi, and how they're driven (claude-agent-sdk vs. ACP over stdio).
- [Cybos](./cybos.md) — custom AI personalities defined by `cybo.json` + `soul.md`, run standalone or inside a workspace.
- [CLI](./cli.md) — the terminal CLI for daemon and workspace workflows.

## Operate it

- [Self-hosting](./self-hosting.md) — run the daemon and the standalone cloud relay on your own infrastructure.
- [Troubleshooting](./troubleshooting.md) — common problems and how to diagnose them.

## More

- [FAQ](./faq.md) — short answers to the questions people ask most.

## Project docs

- [README](../README.md) — project overview, quickstart, and architecture at a glance.
- [Contributing](../CONTRIBUTING.md) — how to build, test, and open a pull request.
- [Security](../SECURITY.md) — how to report a vulnerability privately.
