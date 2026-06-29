# Theming

Open Slack Headless supports dark and light themes out of the box, with the infrastructure for custom themes.

## How it works

Themes are applied via the `data-theme` attribute on the `<html>` element:

```html
<html data-theme="dark"></html>
```

CSS custom properties switch values based on this attribute:

```css
@layer base {
  :root,
  [data-theme="dark"] {
    --bg-base: #1a1d21;
    --text-primary: #d1d2d3;
    --c7-accent: #6366f1;
    /* ... */
  }

  [data-theme="light"] {
    --bg-base: #ffffff;
    --text-primary: #1d1c1d;
    --c7-accent: #6366f1;
    /* ... */
  }
}
```

Tailwind v4 uses a custom variant to scope dark-mode utilities:

```css
@custom-variant dark (&:is([data-theme="dark"] *));
```

## Theme state

Theme preferences are managed by `PreferencesState`:

```typescript
import { preferencesState } from "$lib/state/preferences.svelte.js";

// Get current theme
preferencesState.theme; // "dark" | "light" | "system"
preferencesState.resolvedTheme; // "dark" | "light" (resolves "system")

// Set theme
preferencesState.setTheme("light");
preferencesState.setTheme("system"); // follows OS preference
```

Changes are:

- Persisted to `localStorage` under `cyborg7-theme`
- Applied immediately via `document.documentElement.setAttribute("data-theme", ...)`
- Reflected in all components that use design tokens

## System theme

When `theme` is set to `"system"`, the resolved theme follows the OS preference:

```typescript
window.matchMedia("(prefers-color-scheme: dark)").matches;
```

A `change` event listener updates the UI automatically when the OS theme changes.

## Flash prevention

The `app.html` includes an inline script that sets the theme before Svelte hydrates:

```html
<script>
  try {
    document.documentElement.dataset.theme = localStorage.getItem("cyborg7-theme") || "dark";
  } catch (e) {}
</script>
```

This prevents the flash of wrong-theme content that happens when the server renders one theme and the client switches to another.

## Creating a custom theme

To create a custom theme:

1. Add a new `[data-theme="your-theme"]` block in `app.css`
2. Override the semantic and component tokens you want to change
3. The accent color, surfaces, and text values are the minimum

```css
[data-theme="ocean"] {
  --bg-base: #0a1929;
  --bg-surface: #132f4c;
  --bg-elevated: #1a3a5c;
  --text-primary: #b2bac2;
  --text-secondary: #8796a5;
  --c7-accent: #0288d1;
  --c7-accent-hover: #03a9f4;
  /* ... override as many tokens as needed */
}
```

3. Add "ocean" to the theme type and toggle UI

## Token categories to override

At minimum, a custom theme should override:

| Category    | Tokens                                                                      | Count |
| ----------- | --------------------------------------------------------------------------- | ----- |
| Surfaces    | `--bg-base`, `--bg-surface`, `--bg-elevated`, `--bg-sidebar`, `--bg-deeper` | 5     |
| Text        | `--primary`, `--text-primary`, `--text-secondary`, `--text-muted`           | 4     |
| Borders     | `--border`, `--border-light`, `--border-dim`                                | 3     |
| Accent      | `--c7-accent`, `--c7-accent-hover`                                          | 2     |
| Interactive | `--hover-gray`, `--sidebar-hover`, `--sidebar-active`, `--rail-hover`       | 4     |

Total: ~18 tokens for a complete theme. The component tokens (buttons, dropdowns, code blocks) will inherit from these if structured well.

## Next steps

- [Design system](./14-design-system.md) — Token architecture
- [Typography and spacing](./16-typography-spacing.md) — Font and spacing tokens
