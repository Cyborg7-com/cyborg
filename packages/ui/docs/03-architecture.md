# Architecture Overview

## System context

Open Slack Headless is one layer in a distributed system:

```
┌─────────────────────────────────────────────────────┐
│  Shell (Electron / Tauri / Browser)                 │
│  ┌───────────────────────────────────────────────┐  │
│  │  Open Slack Headless (SvelteKit + Svelte 5)   │  │
│  │  ┌──────────┐  ┌──────────┐  ┌────────────┐  │  │
│  │  │  Core     │  │  Plugins │  │  Components│  │  │
│  │  │  ├ Client │  │  ├ Agents│  │  ├ Sidebar │  │  │
│  │  │  ├ State  │  │  └ ...   │  │  ├ Messages│  │  │
│  │  │  ├ Config │  │          │  │  ├ Rail    │  │  │
│  │  │  └ Types  │  │          │  │  └ ...     │  │  │
│  │  └──────────┘  └──────────┘  └────────────┘  │  │
│  └──────────────────┬────────────────────────────┘  │
│                     │ WebSocket                     │
└─────────────────────┼───────────────────────────────┘
                      │
              ┌───────┴───────┐
              │  Local Daemon  │
              │  (Paseo fork)  │
              │  ├ Agent mgmt  │
              │  ├ SQLite cache│
              │  ├ Auth        │
              │  └ Relay conn  │
              └───────┬───────┘
                      │ WebSocket
              ┌───────┴───────┐
              │    Relay       │
              │  (msg broker)  │
              └───────┬───────┘
                      │ async write
              ┌───────┴───────┐
              │  PostgreSQL    │
              │  (shared)      │
              └───────────────┘
```

The UI never talks to PostgreSQL or the relay directly. Everything goes through the local daemon via a single WebSocket connection.

## Internal architecture

### Directory structure

```
src/
├── app.css                     # Design tokens (Tailwind v4 @theme)
├── app.html                    # HTML shell
├── app.d.ts                    # SvelteKit type declarations
│
├── lib/
│   ├── core/                   # Framework-level primitives
│   │   ├── client.ts           # SlackClient — WebSocket transport
│   │   ├── state.svelte.ts     # Reactive state singletons
│   │   ├── plugin.svelte.ts    # ShellConfig + PluginRegistry
│   │   ├── types.ts            # Core domain types
│   │   └── index.ts            # Public API barrel
│   │
│   ├── plugins/                # Feature plugins
│   │   └── agents/             # Agent management plugin
│   │       ├── types.ts        # Agent-specific types
│   │       ├── state.svelte.ts # Agent stream + provider state
│   │       ├── index.ts        # Public API barrel
│   │       └── components/     # Agent UI components
│   │
│   ├── state/                  # App-level state
│   │   ├── app.svelte.ts       # Re-exports + high-level actions
│   │   └── preferences.svelte.ts # Theme preferences
│   │
│   ├── components/             # Shell components (foldered by feature)
│   │   ├── message/            # ChatMessage, MessageList, MessageInput, …
│   │   ├── composer/           # Composer*, EmojiPicker, MentionAutocomplete
│   │   ├── channel/            # Channel*, AddChannelMembersDialog
│   │   ├── panes/              # *Pane (Activity, Agents, Logs, Memory, …)
│   │   ├── settings/           # Settings page components
│   │   ├── ui/                 # shadcn-svelte components
│   │   ├── WorkspaceSwitcher.svelte   # shared primitives at root:
│   │   ├── RailButton.svelte
│   │   ├── Toolbar.svelte
│   │   ├── Avatar.svelte
│   │   ├── ConfirmDialog.svelte
│   │   └── …                   # ConnectionStatus, ProfileMenu, SetStatusModal, …
│   │
│   ├── ws-client.ts            # CyborgClient (extends SlackClient)
│   ├── types.ts                # Type re-exports
│   ├── utils.ts                # Utility functions
│   └── index.ts                # Package public API
│
└── routes/                     # SvelteKit file-based routes
    ├── +layout.svelte          # Root layout (theme, fonts)
    ├── +page.svelte            # Redirect to /login or /workspace
    ├── login/                  # Auth page
    └── workspace/
        ├── +page.svelte        # Workspace selector
        └── [id]/               # Workspace-scoped routes
            ├── +layout.svelte  # Workspace layout (rail + sidebar + main)
            ├── channel/[channelId]/
            ├── agent/[agentId]/
            ├── agent/new/
            ├── tasks/
            ├── settings/
            └── ...
```

### Layer responsibilities

| Layer             | Path                 | Responsibility                                                                                                 |
| ----------------- | -------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Core**          | `lib/core/`          | WebSocket client, reactive state classes, shell configuration, domain types. No UI — pure TypeScript.          |
| **Plugins**       | `lib/plugins/`       | Feature modules that extend the core. Each plugin owns its types, state, and components. Currently: `agents`.  |
| **State**         | `lib/state/`         | App-level state that connects core + plugins to the UI. Actions like `connectToServer()`, `selectWorkspace()`. |
| **Components**    | `lib/components/`    | Svelte 5 components that render the shell. Read from state, emit events, never call WebSocket directly.        |
| **Routes**        | `routes/`            | SvelteKit pages that compose components into full views. Thin wrappers — logic lives in state/components.      |
| **shadcn-svelte** | `lib/components/ui/` | Base component library (bits-ui v2). Not modified — used as-is.                                                |

### Data flow

```
User interaction (click, type, submit)
  │
  ▼
Component handler (e.g., MessageInput.onsubmit)
  │
  ▼
State action (e.g., sendMessage())
  │
  ▼
Client method (e.g., coreClient.sendMessage())
  │
  ▼
WebSocket → Daemon → Relay → Other daemons
  │
  ▼
Event arrives (e.g., "channel_message")
  │
  ▼
Client event handler → State mutation (e.g., channelState.addMessage())
  │
  ▼
Svelte reactivity → UI re-renders
```

Components never call WebSocket methods directly. They call state actions, which call client methods. Events flow back through the client into state, and Svelte's reactivity propagates changes to the UI.

### Extension model

The architecture supports two extension points:

1. **Plugins** (`PluginRegistry.register()`) — Add rail items, sidebar sections, and settings tabs at runtime. The agents plugin is the reference implementation.

2. **Client subclassing** (`CyborgClient extends SlackClient`) — Add new message types by overriding `handleExtensionMessage()`. The agent streaming protocol is implemented this way.

## Next steps

- [Shell and layout](./04-shell-and-layout.md) — Visual structure of the workspace
- [ShellConfig API](./05-shell-config.md) — Configuration API reference
- [Plugin system](./06-plugin-system.md) — How to write and register plugins
