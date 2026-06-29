# ShellConfig API

`ShellConfig` is the central configuration object that controls the shell's structure. It's a singleton instance exported from `$lib/core/plugin.svelte.ts`.

```typescript
import { shellConfig } from "$lib/core/plugin.svelte.js";
```

## Configuration interface

```typescript
interface SlackShellConfig {
  appName: string;

  rail: {
    showLabels: boolean;
  };

  sidebar: {
    channels: boolean;
    privateChannels: boolean;
    members: boolean;
    settings: boolean;
  };

  features: {
    tasks: boolean;
    agents: boolean;
  };

  railItems: RailItem[];
  toolbar: ToolbarItem[];
  settingsTabs: SettingsTab[];
}
```

## `configure(overrides)`

Apply partial overrides to the shell configuration. Nested objects are shallow-merged.

```typescript
shellConfig.configure({
  appName: "Mission Control",
  sidebar: { members: false }, // hides the Members section
  features: { agents: true }, // enables the Agents section
});
```

## Rail items

### `RailItem` type

```typescript
interface RailItem {
  id: string; // Unique identifier
  label: string; // Display name below icon
  icon: string; // SVG string (rendered via {@html})
  activeIcon?: string; // Alternative SVG when active
  path: string; // Route suffix appended to /workspace/:id
  pathMatch?: string[]; // Additional paths that activate this item
  position: "nav" | "bottom";
  order: number; // Sort order within position group
  badge?: number; // Notification count (0 = hidden)
}
```

### Default rail items

| ID         | Label    | Position | Order | Path                           |
| ---------- | -------- | -------- | ----- | ------------------------------ |
| `chat`     | Chat     | nav      | 0     | `/channel`                     |
| `tasks`    | Tasks    | nav      | 1     | `/tasks`                       |
| `audit`    | Audit    | nav      | 2     | `/audit`                       |
| `memory`   | Memory   | nav      | 3     | `/memory`                      |
| `skills`   | Skills   | nav      | 4     | `/skills`                      |
| `logs`     | Logs     | nav      | 5     | `/logs`                        |
| `feedback` | Feedback | bottom   | 0     | `/feedback` (popup, not route) |
| `settings` | Settings | bottom   | 1     | `/settings`                    |

### `addRailItem(item)`

Add a new rail item or replace an existing one (matched by `id`).

```typescript
shellConfig.addRailItem({
  id: "analytics",
  label: "Analytics",
  icon: `<svg>...</svg>`,
  path: "/analytics",
  position: "nav",
  order: 6,
});
```

### `removeRailItem(id)`

Remove a rail item by ID.

```typescript
shellConfig.removeRailItem("audit");
```

### `updateRailBadge(id, badge)`

Update the badge count on a rail item.

```typescript
shellConfig.updateRailBadge("chat", 3); // shows "3"
shellConfig.updateRailBadge("chat", 0); // hides badge
shellConfig.updateRailBadge("chat", 150); // shows "99+"
```

### Computed getters

| Getter                    | Returns                               |
| ------------------------- | ------------------------------------- |
| `shellConfig.navItems`    | Nav-position items sorted by order    |
| `shellConfig.bottomItems` | Bottom-position items sorted by order |

## Toolbar

### `ToolbarItem` type

```typescript
interface ToolbarItem {
  id: string;
  label: string;
  icon?: string;
  badge?: string | number;
  variant?: "default" | "success" | "warning" | "error";
  tooltip?: string;
  onclick?: () => void;
}
```

### `addToolbarItem(item)` / `removeToolbarItem(id)`

Manage toolbar items that appear in the channel header area.

## Settings tabs

### `SettingsTab` type

```typescript
interface SettingsTab {
  id: string;
  label: string;
  href: string; // Route suffix under /settings/
  icon?: string;
}
```

### Default tabs

| ID        | Label   | Route               |
| --------- | ------- | ------------------- |
| `general` | General | `/settings`         |
| `members` | Members | `/settings/members` |
| `about`   | About   | `/settings/about`   |

### `addSettingsTab(tab)` / `removeSettingsTab(id)`

```typescript
shellConfig.addSettingsTab({
  id: "integrations",
  label: "Integrations",
  href: "/integrations",
});
```

## SVG icons

All default rail icons are available via the `RAIL_ICONS` constant:

```typescript
import { RAIL_ICONS } from "$lib/core/plugin.svelte.js";

// Available keys:
// chatOutline, chatFilled, tasksOutline, tasksFilled,
// auditOutline, auditFilled, memoryOutline, memoryFilled,
// skillsOutline, skillsFilled, logsOutline, logsFilled,
// feedback, settings
```

Icons use `var(--primary)` for fill/stroke, making them theme-aware.

## Next steps

- [Plugin system](./06-plugin-system.md) — Registering plugins that use ShellConfig under the hood
- [Shell and layout](./04-shell-and-layout.md) — How the configuration maps to the visual layout
