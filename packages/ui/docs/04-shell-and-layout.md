# Shell and Layout

## Visual anatomy

The workspace layout follows Slack's classic structure:

```
┌──────────────────────────────────────────────────────────┐
│ ┌───┬──────────┬─────────────────────────────────────┐   │
│ │   │          │ Channel Header                      │   │
│ │   │ Sidebar  ├─────────────────────────────────────┤   │
│ │ R │          │                                     │   │
│ │ A │ Channels │         Main content area           │   │
│ │ I │ Private  │                                     │   │
│ │ L │ Agents   │         (messages, tasks,           │   │
│ │   │ Members  │          settings, etc.)            │   │
│ │   │          │                                     │   │
│ │   │          ├─────────────────────────────────────┤   │
│ │   │          │ Message Input                       │   │
│ └───┴──────────┴─────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

### Rail

The leftmost column (70px wide). Contains:

- **Workspace avatar** at the top — clicking opens a dropdown to switch workspaces
- **Nav items** in a scrollable middle zone — Chat, Tasks, Audit, Memory, Skills, Logs
- **Bottom items** pinned to the bottom — Feedback (toggle popup), Settings

Each item is a `RailButton` that renders an SVG icon, a label, and an optional badge. The active item has a highlighted background (`--rail-hover`). Icons scale up on hover with a smooth 125ms transition.

Rail items are data-driven — they come from `shellConfig.navItems` and `shellConfig.bottomItems`, which are arrays of `RailItem` objects. Adding or removing items is a function call, not a template edit.

### Sidebar

A resizable panel (default 275px, minimum 215px) between the rail and the main content. It only appears on channel and agent routes.

Structure from top to bottom:

- **Workspace header** — workspace name (18px, font-black) with a chevron dropdown indicator
- **Collapsible sections** — Channels, Private, Agents, Members. Each uses shadcn-svelte `Collapsible` with a chevron that rotates on collapse
- **Plugin sections** — Dynamically rendered from `pluginRegistry.getSidebarSections()`
- **Bottom actions** — "Invite Agents" and "Invite Humans" buttons, separated by a `Separator`

The sidebar is resizable via a drag handle on the right edge. Mouse drag updates the width with a 1.3x dampening factor for smooth resizing.

### Main content area

Everything to the right of the sidebar. This is where SvelteKit routes render:

- `/channel/:channelId` — MessageList + MessageInput
- `/agent/:agentId` — Agent stream view with tool calls, permissions, composer
- `/agent/new` — Agent creation dialog
- `/tasks` — Task board
- `/settings` — Settings pages (General, Members, About, Providers)
- `/feedback` — Not a route; rendered as a popup widget from the rail

The main area has a `bg-surface` background and rounded corners with a `border-edge-dim` border, creating a subtle card effect inside the outer window.

### Workspace layout component

The workspace layout (`routes/workspace/[id]/+layout.svelte`) composes these pieces:

```svelte
<div class="flex h-full overflow-hidden">
  <WorkspaceSwitcher />
  <div class="flex flex-1 rounded-lg border border-edge-dim">
    {#if showChannelSidebar}
      <ChannelSidebar />
    {/if}
    <main class="flex flex-1 flex-col bg-surface">
      {@render children()}
    </main>
  </div>
</div>
```

`showChannelSidebar` is derived from the current route — it only shows for `/channel/*` and `/agent/*` paths.

## Responsive behavior

- The sidebar is hidden below `sm` breakpoint (640px) via `hidden sm:flex`
- The rail always shows (it's compact enough for mobile)
- On mobile-width screens, the full main area is available
- The sidebar width is constrained to a minimum of 215px

## Special elements

### Feedback widget

Feedback is not a page — it's a floating popup toggled by the Feedback rail button. The `FeedbackWidget` component renders as a `fixed` element positioned at `bottom-16 left-[60px]` (just above the rail button, to its right).

The widget contains a category selector (Bug / Feature / General), a description textarea, screenshot upload, and a send button. On success, it shows a confirmation state and auto-closes after 2 seconds.

### Workspace dropdown

Clicking the workspace avatar opens a dropdown listing:

- The current workspace with member/agent counts
- Other workspaces for quick switching
- An "Add a workspace" action

The dropdown is positioned `absolute top-11 -left-3` from the avatar and uses the design system's dropdown tokens (`--dropdown-bg`, `--dropdown-border`, `--dropdown-shadow`).

## Next steps

- [ShellConfig API](./05-shell-config.md) — How to configure rail items, sidebar visibility, and features
- [Component catalog](./09-component-catalog.md) — Full list of components and their props
