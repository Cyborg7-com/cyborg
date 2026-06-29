# packages/ui — Contributing Guide

## What this is

A customizable "Open Slack Headless" collaboration shell. Not a product — a framework. Consumers configure the shell via `shellConfig` and extend it via `pluginRegistry`. Every visual element is data-driven and themeable.

## Design philosophy

1. **Pixel-perfect replication of the original** — the source of truth is `~/personal/cyborg7-core/` (Next.js web app at root, NOT `/mobile/`). Match its layout, spacing, colors, font sizes, and interaction patterns exactly.
2. **shadcn-svelte over custom components** — use Collapsible, ScrollArea, Tooltip, Avatar, Badge, Dialog, Separator, etc. Don't build from scratch what shadcn already provides.
3. **Theme tokens, never hardcoded** — all visual values (font sizes, colors, spacing) come from CSS custom properties in `src/app.css` via `@theme inline`. Override tokens globally; never scatter `text-[15px]` across files when `text-sm` can be redefined.
4. **Data-driven, not hardcoded** — rail items, sidebar sections, toolbar badges, settings tabs come from `shellConfig` and `pluginRegistry`. Components iterate config arrays; they don't contain static HTML for specific features.
5. **Remove, don't disable** — if a feature shouldn't exist, delete it from the type system. No `enabled: false` flags, no dead code behind feature gates.
6. **No invented features** — if the original doesn't have it, we don't add it. DMs didn't exist in the original web UI, so there's no DM type, no DM config, no DM component.

## Architecture

### Shell config (`src/lib/core/plugin.svelte.ts`)

```typescript
shellConfig.configure({
  appName: "MyApp",
  rail: { showLabels: true },
  features: { agents: true, tasks: true },
  toolbar: [{ id: "mode", label: "Solo", variant: "warning" }],
  settingsTabs: [{ id: "general", label: "General", href: "" }],
});
```

Exposes: `shellConfig.navItems`, `shellConfig.bottomItems`, `shellConfig.toolbar`, etc.

Mutation methods: `addRailItem()`, `removeRailItem()`, `updateRailBadge()`, `addToolbarItem()`, etc.

### Rail items

- Type: `RailItem` — `id`, `label`, `icon` (SVG string), `activeIcon`, `path`, `pathMatch`, `position` ("nav"|"bottom"), `order`, `badge`.
- Default 8 items: Chat, Tasks, Audit, Memory, Skills, Logs (nav) + Feedback, Settings (bottom).
- Each has outline/filled SVG icon variants for inactive/active states.
- Icons stored in `RAIL_ICONS` constant, rendered via `{@html icon}`.

### Plugin registry

```typescript
pluginRegistry.register({
  id: "my-plugin",
  name: "My Plugin",
  railItems: [{ ... }],
  sidebarSections: () => [{ id: "custom", label: "Custom", items: [...] }],
  settingsTabs: [{ id: "custom", label: "Custom", href: "/custom" }],
});
```

Plugins inject rail items and sidebar sections that render alongside defaults.

### Sidebar (`ChannelSidebar.svelte`)

- Collapsible sections (shadcn Collapsible) for Channels, Private, Agents, Members
- ScrollArea (shadcn) for overflow
- Tooltip (shadcn) on action buttons
- Resize handle (min 215px, drag to resize, persisted)
- Plugin sections rendered from `pluginRegistry.getSidebarSections()`
- Bottom actions: Invite Agents, Invite Humans

### Component patterns

- `WorkspaceSwitcher.svelte` — icon rail with data-driven nav/bottom items via `RailButton`
- `RailButton.svelte` — reusable rail icon button with badge, hover scale, active state
- `ChannelSidebar.svelte` — collapsible sidebar with channels, agents, members, plugins

## Token system (`src/app.css`)

3-tier: primitives (CSS vars) -> semantic (`@theme` block) -> component classes.

Key overrides:

- `--font-size-sm` / `--font-size-sm--line-height` — global body text size (15px)
- `--sidebar-active`, `--sidebar-hover`, `--rail-hover` — interaction states
- `--bg-sidebar` — sidebar background
- Dark/light via `[data-theme]` attribute

## What to check before submitting

1. `npx svelte-check --threshold error` — zero errors
2. Dev server renders correctly at `localhost:5173`
3. Rail shows all 8 items with correct icons
4. Sidebar sections collapse/expand
5. Theme tokens used, no hardcoded pixel values for standard sizes
6. shadcn components used where applicable
7. No features that don't exist in the original
