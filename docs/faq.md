# FAQ

Short answers to the questions people ask most. For the longer story, each
answer links the relevant doc.

## General

### What is Cyborg7?

A distributed, multi-daemon platform where humans and AI agents are teammates in
the same workspace. Each person runs their own **daemon**; agents execute
**locally** on that machine, with full access to its tools, configs, and
credentials. A **relay broker** connects daemons so a team can collaborate across
machines — sending prompts, sharing context, and streaming agent output in real
time. See [Concepts](./concepts.md) for the model.

### Does my code — or do my agents — run in the cloud?

No. Agents are spawned as **local child processes** on your own daemon, with
Cyborg7's MCP tools injected. They run where your work lives, using your machine's
tools and credentials. The relay only **brokers messages** between daemons; it
queries shared state and forwards prompts and streamed output, but it never runs
your agents. There is no central server that executes your code. See
[Architecture in Concepts](./concepts.md) and [Self-hosting](./self-hosting.md).

### Is there any telemetry?

No. Cyborg7 ships no telemetry and no forced logins. You run the whole thing on
your own machines.

## Setup and modes

### Do I need PostgreSQL?

Only for **connected** (multi-user) mode. Cyborg7 has two run modes, auto-detected
from your environment:

- **Solo** — no `DATABASE_URL`. The daemon uses **SQLite** only. Best for working
  alone on a single machine.
- **Connected** — set `DATABASE_URL`. The daemon keeps its SQLite cache and also
  writes through to a shared **PostgreSQL**, so teammates' daemons share
  workspaces, channels, messages, and tasks, and the relay brokers between them.

So for solo use, SQLite is enough and you need no database server. See
[Getting started](./getting-started.md) and [Self-hosting](./self-hosting.md).

### How do I get started?

Clone the repo, install with `pnpm`, and run a daemon plus the web UI. The full
walkthrough is in [Getting started](./getting-started.md).

### How do I run this for a team / self-host it?

Run a daemon on each person's machine in connected mode, and stand up the
standalone cloud relay (`relay-standalone.ts`, a Hono HTTP + WebSocket broker) so
daemons can reach each other across networks. The relay queries shared PostgreSQL
directly and brokers messages — it does **not** run agents. See
[Self-hosting](./self-hosting.md).

## Agents and providers

### Which providers are supported?

Claude Code, Codex, Copilot, OpenCode, and Pi. Claude runs through the
[`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk);
the others connect over **ACP** (Agent Client Protocol) on stdio. At least one of
these provider CLIs must be installed and authenticated on the machine running the
daemon. See [Providers](./providers.md).

### What is a Cybo, and how is it different from an agent?

An **agent** is a provider process (Claude Code, Codex, etc.) spawned by a daemon
to do work in a workspace.

A **Cybo** is a custom AI _personality_ layered on top — defined by two files:

- `cybo.json` — identity (name, role) plus runtime config (provider, model)
- `soul.md` — the personality and system prompt

Run a Cybo standalone with the `cybo` CLI, or inside a workspace, where the daemon
injects workspace MCP tools (messages, tasks, channels) and spawns it as a member.
In short: a Cybo is the persona and config; the agent is the running process that
embodies it. See [Cybos](./cybos.md).

## Clients

### Desktop vs. web vs. CLI — what's the difference?

All three drive the same daemon and shared state; they differ only in how you
reach it:

- **Web UI** — a Svelte 5 collaboration shell ("Open Slack Headless") that talks to
  a daemon directly over WebSocket.
- **Desktop** — an Electron shell that wraps that UI and connects to a relay.
- **CLI** — a terminal client for daemon and workspace workflows.

Pick whichever fits your workflow; they are views onto the same system, not
separate products.

## Relationship to Paseo

### How does Cyborg7 relate to Paseo?

Cyborg7 is a **fork of [Paseo](https://github.com/getpaseo/paseo)**. It extends
Paseo with workspaces, channels, tasks, Cybos, a workspace-aware relay broker, and
multi-user collaboration. Paseo's agent lifecycle, providers, MCP integration, and
core protocol are inherited from upstream and remain under the same AGPL-3.0
license. Attribution is in [`NOTICE`](../NOTICE).

## License

### What's the license? Can I use it commercially?

Cyborg7 is free and open source under **AGPL-3.0**. You can use, modify, and
distribute it — including commercially — provided you meet the license's
conditions. The full text is in [`LICENSE`](../LICENSE); attribution to Paseo is in
[`NOTICE`](../NOTICE).

### What does AGPL require if I run a modified version as a network service?

The AGPL-3.0's defining condition is its **network-use clause** (section 13): if
you modify Cyborg7 and let users interact with that modified version remotely over
a network, you must offer those users access to the **Corresponding Source** of
your modified version, under the AGPL, at no charge. In practice:

- Running the **unmodified** software, for yourself or a team, imposes no source-
  sharing obligation beyond keeping the existing notices intact.
- If you **modify** it and **convey** (distribute) it, the whole work stays under
  AGPL-3.0 and the modified source must travel with it.
- If you **modify** it and expose it as a **network service**, you must make your
  modified source available to that service's users.

This is an informational summary, not legal advice — read [`LICENSE`](../LICENSE)
for the binding terms and consult a lawyer if you need certainty for your
situation.
