# Component Catalog

All components are in `src/lib/components/`, foldered by feature: `message/`, `composer/`,
`channel/`, `panes/`, plus `ui/` (shadcn-svelte primitives) and `settings/`. Shared
primitives (Avatar, Toolbar, ConfirmDialog, …) live at the `components/` root. They use
Svelte 5 runes (`$props()`, `$state`, `$derived`) and the project's design tokens.

## Shell components

### WorkspaceSwitcher

**File:** `WorkspaceSwitcher.svelte`

The left rail. Renders the workspace avatar, nav rail items, bottom rail items, workspace dropdown, and the feedback popup widget.

| Prop     | Type | Description                                            |
| -------- | ---- | ------------------------------------------------------ |
| _(none)_ | —    | Reads from `shellConfig`, `workspaceState`, and `page` |

Key behaviors:

- Workspace avatar opens a dropdown to switch workspaces
- Rail items navigate to workspace-scoped routes via `goto()`
- Feedback item toggles a popup instead of navigating
- Active state derived from current URL path

### RailButton

**File:** `RailButton.svelte`

A single icon button in the rail.

| Prop      | Type         | Default | Description                                             |
| --------- | ------------ | ------- | ------------------------------------------------------- |
| `label`   | `string`     | —       | Text below the icon                                     |
| `icon`    | `string`     | —       | SVG string rendered via `{@html}`                       |
| `active`  | `boolean`    | `false` | Highlighted background state                            |
| `badge`   | `number`     | `0`     | Notification count (hidden when 0, shows "99+" over 99) |
| `onclick` | `() => void` | —       | Click handler                                           |

### ChannelSidebar

**File:** `channel/ChannelSidebar.svelte`

Resizable sidebar with collapsible sections for channels, private channels, agents, members, and plugin sections.

| Prop     | Type | Description                                                                  |
| -------- | ---- | ---------------------------------------------------------------------------- |
| _(none)_ | —    | Reads from `workspaceState`, `channelState`, `shellConfig`, `pluginRegistry` |

Key behaviors:

- Resizable via drag handle (min 215px)
- Hidden below `sm` breakpoint
- Sections controlled by `shellConfig.sidebar` flags
- Plugin sections from `pluginRegistry.getSidebarSections()`
- Agent items show status dots and permission badges

### ChannelHeader

**File:** `channel/ChannelHeader.svelte`

Header bar above the message area showing channel name and metadata.

### MessageList

**File:** `message/MessageList.svelte`

Scrollable message history with infinite scroll for older messages.

Key behaviors:

- Renders `ChatMessage` for each message
- Scroll-to-bottom on new messages
- Load more on scroll to top (calls `loadMoreMessages()`)
- Shows loading spinner during fetch

### ChatMessage

**File:** `message/ChatMessage.svelte`

Individual message display with avatar, name, timestamp, and text.

| Prop      | Type      | Description                      |
| --------- | --------- | -------------------------------- |
| `message` | `Message` | The message to render            |
| `isOwn`   | `boolean` | Whether the current user sent it |

### MessageInput

**File:** `message/MessageInput.svelte`

Text input for composing messages. Composes the `composer/` sub-components
(toolbar, attachments, link modal, voice recorder, emoji picker, mention autocomplete).

Key behaviors:

- Enter to send, Shift+Enter for newline
- Sends typing indicators on input (debounced)
- Placeholder shows channel name

### Toolbar

**File:** `Toolbar.svelte`

Renders toolbar items from `shellConfig.toolbar` as icon buttons with optional badges and tooltips.

### FeedbackWidget

**File:** `FeedbackWidget.svelte`

Floating popup for submitting feedback.

| Prop      | Type         | Default | Description                        |
| --------- | ------------ | ------- | ---------------------------------- |
| `open`    | `boolean`    | `false` | Whether the popup is visible       |
| `onclose` | `() => void` | —       | Called when the popup should close |

Features:

- Category selector: Bug, Feature, General
- Description textarea (required)
- Screenshot upload with preview
- Success state with auto-close after 2 seconds

### ConnectionStatus

**File:** `ConnectionStatus.svelte`

Displays the current WebSocket connection status (connected, reconnecting, disconnected).

### ConfirmDialog

**File:** `ConfirmDialog.svelte`

Generic confirmation dialog built on shadcn-svelte Dialog.

### Avatar

**File:** `Avatar.svelte`

User avatar with fallback initials and optional status indicator.

## Settings components

Located in `lib/components/settings/`:

### SettingsNav

Navigation sidebar for the settings page. Renders tabs from `shellConfig.settingsTabs`.

### ThemeToggle

Toggle switch between dark and light themes. Uses `preferencesState.setTheme()`.

## Agent components

Located in `lib/plugins/agents/components/`:

### AgentStreamView

Full-screen agent interaction view with timeline rendering. Shows tool calls, messages, reasoning, errors, and compaction notices.

### AgentComposer

Chat-style input for sending prompts to an agent. Includes slash command palette, model selector, and mode selector.

### PermissionCard

Displays a permission request from an agent with approve/deny actions.

### ToolCallDetail

Renders the details of a tool call (shell command, file read, edit diff, search results, etc.) with syntax-aware formatting.

### AgentModeSelector / AgentModelSelector

Dropdown selectors for agent mode and model, integrated into the composer.

### SlashCommandPalette

Autocomplete popup for agent slash commands triggered by typing `/`.

### Provider settings components

`ProviderDetail.svelte`, `ProviderRow.svelte`, `StatusBadge.svelte` — settings page for managing AI providers.

## shadcn-svelte components

Located in `lib/components/ui/`. These are generated by the shadcn-svelte CLI and used as-is:

Avatar, Badge, Button, Card, Collapsible, Dialog, DropdownMenu, ScrollArea, Separator, Sheet, Skeleton, Sonner (toasts), Tabs, Tooltip

## Next steps

- [Shell and layout](./04-shell-and-layout.md) — How components compose into the workspace layout
- [Design system](./14-design-system.md) — Tokens that control component styling
