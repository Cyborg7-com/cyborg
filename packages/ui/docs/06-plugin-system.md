# Plugin System

Plugins extend the shell without modifying core components. A plugin can add rail items, sidebar sections, and settings tabs — all through a registration API.

## Plugin interface

```typescript
interface SlackPlugin {
  id: string; // Unique identifier
  name: string; // Human-readable name
  railItems?: RailItem[]; // Items to add to the rail
  sidebarSections?: () => SidebarSection[]; // Dynamic sidebar sections
  settingsTabs?: SettingsTab[]; // Settings page tabs
  onRegister?: () => void; // Called after registration
}
```

## Registering a plugin

```typescript
import { pluginRegistry } from "$lib/core/plugin.svelte.js";

pluginRegistry.register({
  id: "my-plugin",
  name: "My Plugin",

  railItems: [
    {
      id: "my-feature",
      label: "Feature",
      icon: `<svg>...</svg>`,
      path: "/my-feature",
      position: "nav",
      order: 7,
    },
  ],

  sidebarSections: () => [
    {
      id: "my-section",
      label: "My Section",
      items: [
        { id: "item-1", label: "Item One", href: "/workspace/123/my-feature" },
        { id: "item-2", label: "Item Two", status: "online" },
      ],
      actions: [{ label: "Add", onclick: () => console.log("add clicked") }],
    },
  ],

  settingsTabs: [
    {
      id: "my-settings",
      label: "My Plugin",
      href: "/my-plugin",
    },
  ],

  onRegister: () => {
    console.log("Plugin registered");
  },
});
```

When a plugin is registered:

1. Its `railItems` are added to `shellConfig` via `addRailItem()`
2. Its `settingsTabs` are added via `addSettingsTab()`
3. Its `onRegister` callback is invoked
4. Its `sidebarSections` function is called at render time by the `ChannelSidebar`

## Sidebar sections

The `sidebarSections` property is a function (not a static array) so it can return reactive data:

```typescript
interface SidebarSection {
  id: string;
  label: string;
  items: SidebarItem[];
  actions?: SidebarAction[];
}

interface SidebarItem {
  id: string;
  label: string;
  href?: string;
  icon?: Component; // Svelte component
  badge?: string | number;
  status?: "online" | "idle" | "error" | "offline";
  active?: boolean;
  onclick?: () => void;
}

interface SidebarAction {
  label: string;
  icon?: string;
  onclick: () => void;
}
```

Sidebar sections render as collapsible groups in the `ChannelSidebar`, between the built-in sections (Channels, Private, Agents) and the Members section. Each item can have a status dot, a badge, or a click handler.

## Unregistering a plugin

```typescript
pluginRegistry.unregister("my-plugin");
```

This removes all rail items and settings tabs that the plugin added.

## Querying plugins

```typescript
pluginRegistry.getAll(); // All registered plugins
pluginRegistry.get("my-plugin"); // Get by ID
pluginRegistry.getSidebarSections(); // All sidebar sections from all plugins
```

## The agents plugin

The agents plugin (`lib/plugins/agents/`) is the reference implementation. It:

- Extends `SlackClient` into `CyborgClient` with agent-specific methods
- Manages agent streaming state (`AgentStreamState`)
- Provides provider discovery (`ProviderState`)
- Renders agent-specific components (AgentStreamView, PermissionCard, AgentComposer)

It doesn't use the `PluginRegistry.register()` API directly because it integrates at a deeper level (extending the WebSocket client). Future plugins that only need UI integration should use the registry.

## Next steps

- [State management](./07-state-management.md) — How state classes power the reactive UI
- [ShellConfig API](./05-shell-config.md) — Lower-level configuration that plugins build on
