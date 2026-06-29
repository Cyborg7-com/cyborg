# Cybo Documentation

## Overview

1. [What is Cybo](./01-what-is-cybo.md) — The concept, why it exists, and how it compares to building agents from scratch.
2. [Quick Start](./02-quick-start.md) — Install, create your first agent, and run it in under 2 minutes.

## Core Concepts

3. [Agent Anatomy](./03-agent-anatomy.md) — The two files that define a Cybo: `cybo.json` and `soul.md`.
4. [Agent Registry](./04-agent-registry.md) — How `~/.cybo/agents/` works, linking, invoking by name, and the default agent.
5. [Providers and Models](./05-providers-and-models.md) — Multi-provider support, model selection, and runtime overrides.
6. [Sessions](./06-sessions.md) — Conversation persistence, continue, resume, and ephemeral mode.

## Usage

7. [CLI Reference](./07-cli-reference.md) — Every command and flag, with examples.
8. [Interactive Mode](./08-interactive-mode.md) — The REPL, in-session commands, and workflow tips.
9. [Agent Resolution](./09-agent-resolution.md) — How cybo decides which agent to load: flags, `@slug`, cwd, default.

## Advanced

10. [Architecture](./10-architecture.md) — PI delegation, RPC protocol, zero-dependency design.
11. [Running Inside Cyborg7](./11-cyborg7-integration.md) — Daemon mode, workspace MCP tools, and what changes.
12. [Creating Distributable Agents](./12-distributable-agents.md) — Packaging, sharing, and publishing cybos.

## Reference

13. [cybo.json Schema](./13-cybo-json-schema.md) — Every field, types, defaults, and examples.
14. [Troubleshooting](./14-troubleshooting.md) — `cybo doctor`, common errors, and diagnostics.
