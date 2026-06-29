# Introduction

## What is Open Slack Headless?

Open Slack Headless is the UI layer of Cyborg7 — a collaborative AI agent platform where humans and agents communicate in shared workspaces. It's a Svelte 5 component library and SvelteKit application that provides a Slack-like collaboration interface, designed from the ground up to be customizable.

The word "headless" reflects the architecture: the UI has no opinion about where data comes from. It connects to a daemon process over WebSocket and renders whatever that daemon provides. The daemon could run locally on your laptop, on an EC2 instance, or distributed across multiple machines. The UI doesn't care — it speaks a typed protocol and renders the results.

## The problem it solves

Most collaboration UIs are monoliths. Slack, Discord, Teams — they're tightly coupled to their backends, impossible to customize beyond surface-level theming, and closed to third-party UI extensions.

Cyborg7 v1 had the same problem. Every component was hardcoded for one specific use case. Adding a new panel required modifying core components. Changing the backend model broke the frontend in multiple places. You couldn't give the UI to someone else and say "make it yours."

Open Slack Headless is the v2 answer. It provides:

- **A configurable shell** where rail items, sidebar sections, and layout zones are data-driven, not hardcoded
- **A plugin system** where third-party code can register new rail items, sidebar sections, and settings tabs without touching core components
- **A 3-tier design token system** where every color, spacing value, font size, and border radius comes from CSS custom properties — swap the theme file and the entire app changes
- **A typed WebSocket client** that abstracts the daemon protocol into a clean API, with automatic reconnection and extensibility via subclassing

## Who it's for

- **Platform builders** who want a ready-made collaboration UI that they can customize for their own product
- **Cyborg7 users** who want the standard workspace experience (channels, messages, agents, tasks) out of the box
- **Plugin developers** who want to extend the collaboration shell with new capabilities without forking the UI

## Design principles

### Shell-agnostic

All UI code lives in `packages/ui/` as pure Svelte 5 components built with SvelteKit and `adapter-static`. The shell (Electron, Tauri, standalone browser) only provides the window and native APIs. Switching shells means changing a thin wrapper, not rewriting the UI.

### Data-driven, not hardcoded

The rail, sidebar, toolbar, and settings are all controlled through `ShellConfig` and `PluginRegistry`. Components read from these registries at render time. Adding a new rail item is a function call, not a component edit.

### Theme-first

No hardcoded colors, no hardcoded spacing. Every visual property flows from CSS custom properties defined in `app.css`. The system uses Tailwind CSS v4's `@theme inline` block to bridge custom properties into utility classes. Dark and light modes ship by default, and custom themes are a matter of overriding the custom properties.

### WebSocket-only

No HTTP fetches, no SSE, no REST endpoints. Every interaction goes through a single WebSocket connection to the local daemon. The daemon handles relay communication, database queries, and agent management — the UI never talks to remote services directly.

### shadcn-svelte first

The component library uses [shadcn-svelte](https://shadcn-svelte.com) (backed by bits-ui v2) as its foundation. Collapsible, ScrollArea, Tooltip, Avatar, Badge, Dialog, Separator, Card, Button, Tabs — all come from shadcn-svelte. Custom components extend these, not replace them.

## Tech stack

| Layer           | Technology                                       |
| --------------- | ------------------------------------------------ |
| Framework       | SvelteKit with Svelte 5 (runes)                  |
| Styling         | Tailwind CSS v4 (`@theme inline`)                |
| Components      | shadcn-svelte (bits-ui v2)                       |
| State           | Svelte 5 reactive classes (`$state`, `$derived`) |
| Transport       | Native WebSocket with typed client               |
| Build           | Vite, `adapter-static`                           |
| Type checking   | TypeScript (strict)                              |
| Package manager | pnpm                                             |

## Next steps

- [Quickstart](./02-quickstart.md) — Get the shell running and connected to a daemon
- [Architecture overview](./03-architecture.md) — Understand how the pieces fit together
