# Open Slack Headless

A customizable collaboration shell built with Svelte 5. Not a purpose-built app — a configurable UI framework that consumers wire to their own backend.

Open Slack Headless provides the primitives for real-time collaboration (workspaces, channels, messages, agents, tasks) while letting you control how they look and behave. The default layout replicates Slack's UX. You can rearrange it into a dashboard, a single-agent chat, a monitoring panel, or anything else.

## Documentation

### Getting started

1. [Introduction](./01-introduction.md) — What Open Slack Headless is, who it's for, and what problem it solves
2. [Quickstart](./02-quickstart.md) — Install, connect to a daemon, and render your first workspace
3. [Architecture overview](./03-architecture.md) — How the pieces fit together: shell, core, plugins, state, and transport

### Core concepts

4. [Shell and layout](./04-shell-and-layout.md) — The workspace layout: rail, sidebar, main content area, and how they compose
5. [ShellConfig API](./05-shell-config.md) — Configuring the shell: rail items, sidebar sections, toolbar, settings tabs
6. [Plugin system](./06-plugin-system.md) — Registering plugins that add rail items, sidebar sections, and settings tabs
7. [State management](./07-state-management.md) — Reactive state with Svelte 5 runes: WorkspaceState, ChannelState, AuthState, ConnectionState
8. [WebSocket client](./08-websocket-client.md) — SlackClient and CyborgClient: connecting to the daemon, request/response, events

### Building blocks

9. [Component catalog](./09-component-catalog.md) — Every component shipped with the shell: what it does, its props, and when to use it
10. [Routing](./10-routing.md) — SvelteKit routes, workspace-scoped layouts, and how rail items map to routes
11. [Messaging](./11-messaging.md) — Sending and receiving messages, typing indicators, reactions, pagination
12. [Agents](./12-agents.md) — Creating agents, streaming events, permission requests, tool call rendering
13. [Tasks](./13-tasks.md) — Task CRUD, status lifecycle, assignment, and the task board UI

### Theming and design

14. [Design system](./14-design-system.md) — The 3-tier token system: primitives, semantic, component tokens
15. [Theming](./15-theming.md) — Dark/light mode, custom themes, the `data-theme` attribute, and CSS custom properties
16. [Typography and spacing](./16-typography-spacing.md) — Font stack, base size, the `--font-size-sm` override, spacing scale

### Integration

17. [Connecting to a daemon](./17-connecting-to-daemon.md) — Auth flow, JWT tokens, session persistence, reconnection
18. [Shell wrappers](./18-shell-wrappers.md) — Running in Electron, Tauri, or a standalone browser — `adapter-static` and native bridges
19. [Extending the client](./19-extending-client.md) — Subclassing CyborgClient, adding custom message types, handling extension events

### Reference

20. [Type reference](./20-type-reference.md) — Complete TypeScript type definitions: core types, agent types, plugin types
21. [Token reference](./21-token-reference.md) — Every CSS custom property and Tailwind token with dark/light values
22. [API methods](./22-api-methods.md) — Full list of SlackClient and CyborgClient methods with signatures and return types
