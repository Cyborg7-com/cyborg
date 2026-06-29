# Routing

Open Slack Headless uses SvelteKit's file-based routing. All workspace content lives under `/workspace/[id]/`.

## Route map

```
/                                    → Redirect to /login or /workspace
/login                               → Authentication page
/workspace                           → Workspace selector
/workspace/[id]                      → Workspace home (redirects to first channel)
/workspace/[id]/channel/[channelId]  → Channel message view
/workspace/[id]/agent/new            → Create new agent
/workspace/[id]/agent/[agentId]      → Agent interaction view
/workspace/[id]/tasks                → Task board
/workspace/[id]/tasks/[taskId]       → Task detail
/workspace/[id]/settings             → General settings
/workspace/[id]/settings/members     → Member management
/workspace/[id]/settings/about       → Workspace info
/workspace/[id]/settings/providers   → AI provider configuration
```

## Layouts

### Root layout (`routes/+layout.svelte`)

Applies the global theme, font, and toast provider. Reads the `data-theme` attribute for dark/light mode.

### Workspace layout (`routes/workspace/[id]/+layout.svelte`)

The main workspace shell. Handles:

1. **Session restoration** — If the user navigates directly to a workspace URL, the layout restores the WebSocket connection from `localStorage`
2. **Layout composition** — Renders `WorkspaceSwitcher` (rail) + optionally `ChannelSidebar` + main content area
3. **Loading state** — Shows a spinner while reconnecting

```
WorkspaceSwitcher | ChannelSidebar? | <slot />
```

The sidebar conditionally renders based on the current route:

```typescript
const showChannelSidebar = $derived(
  pathname.startsWith(`/workspace/${wsId}/channel`) ||
    pathname.startsWith(`/workspace/${wsId}/agent`),
);
```

### Settings layout (`routes/workspace/[id]/settings/+layout.svelte`)

Adds the settings navigation sidebar (`SettingsNav`) alongside the settings content area.

## How rail items map to routes

Each `RailItem` has a `path` property. When clicked, the `WorkspaceSwitcher` navigates to `/workspace/${wsId}${item.path}`:

| Rail item | Path        | Route                        |
| --------- | ----------- | ---------------------------- |
| Chat      | `/channel`  | First channel (special case) |
| Tasks     | `/tasks`    | `workspace/[id]/tasks/`      |
| Audit     | `/audit`    | Route TBD                    |
| Memory    | `/memory`   | Route TBD                    |
| Skills    | `/skills`   | Route TBD                    |
| Logs      | `/logs`     | Route TBD                    |
| Feedback  | `/feedback` | Not a route — toggles popup  |
| Settings  | `/settings` | `workspace/[id]/settings/`   |

The Chat item has special handling: instead of navigating to `/channel`, it finds the first channel and navigates to `/channel/${firstChannel.id}`.

## Active state detection

The `isItemActive()` function determines which rail item is highlighted:

```typescript
function isItemActive(item: RailItem): boolean {
  if (item.id === "feedback") return feedbackOpen;
  const paths = item.pathMatch ?? [item.path];
  return paths.some((p) => pathname.startsWith(`/workspace/${wsId}${p}`));
}
```

The Chat item uses `pathMatch: ["/channel", "/agent", "/threads"]` to stay highlighted on both channel and agent routes.

## Adding new routes

To add a route for a new rail item:

1. Create the route directory: `src/routes/workspace/[id]/my-feature/+page.svelte`
2. Add the rail item via `shellConfig.addRailItem()`
3. The workspace layout will render your page in the main content area

If the new route needs the sidebar, update the `showChannelSidebar` derived in the workspace layout.

## Next steps

- [Shell and layout](./04-shell-and-layout.md) — Visual structure that routes render into
- [ShellConfig API](./05-shell-config.md) — Adding rail items for new routes
