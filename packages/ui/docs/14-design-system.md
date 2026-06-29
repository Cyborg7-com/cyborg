# Design System

Open Slack Headless uses a 3-tier token system: **primitives** (raw values), **semantic** (purpose-mapped), and **component** (specific UI elements). All tokens are CSS custom properties defined in `src/app.css`, exposed to Tailwind CSS v4 via the `@theme inline` block.

## Token architecture

```
Tier 1: Primitives            Tier 2: Semantic              Tier 3: Component
─────────────────             ──────────────                ─────────────────
--gray-0: 16,18,20      →    --bg-base: #1a1d21       →   --dropdown-bg: #1a1d21
--gray-10: 33,36,40      →   --bg-surface: #222529    →   --code-bg: #1e1e1e
#6366f1                  →   --c7-accent: #6366f1     →   --btn-primary-bg: #fafafa
```

### Tier 1: Primitives

Raw color values, not used directly in components:

- `--gray-0`, `--gray-10` — base gray palette
- Brand colors: `#6366f1` (accent), `#3daa7c` (online/success), `#e01e5a` (error)

### Tier 2: Semantic tokens

Purpose-mapped tokens used throughout the codebase:

| Category        | Tokens                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------- |
| **Surfaces**    | `--bg-base`, `--bg-surface`, `--bg-elevated`, `--bg-sidebar`, `--bg-deeper`, `--bg-deepest` |
| **Text**        | `--primary`, `--secondary`, `--text-primary`, `--text-secondary`, `--text-muted`            |
| **Borders**     | `--border`, `--border-light`, `--border-dim`, `--border-subtle`                             |
| **Interactive** | `--hover-gray`, `--sidebar-hover`, `--sidebar-active`, `--rail-hover`                       |
| **Status**      | `--online` (#3daa7c), `--error` (#e01e5a), `--warning` (#e8ab5a), `--link` (#3b82f6)        |
| **Brand**       | `--c7-accent` (#6366f1), `--c7-accent-hover` (#818cf8)                                      |

### Tier 3: Component tokens

Tokens scoped to specific UI elements:

| Component     | Tokens                                                                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Buttons**   | `--btn-primary-bg`, `--btn-primary-text`, `--btn-primary-hover`, `--btn-secondary-bg`, `--btn-secondary-text`, `--btn-secondary-border`, `--btn-secondary-hover` |
| **Dropdowns** | `--dropdown-bg`, `--dropdown-border`, `--dropdown-shadow`, `--dropdown-selected`, `--dropdown-hover`, `--dropdown-name`, `--dropdown-secondary`                  |
| **Code**      | `--code-bg`, `--code-text`, `--code-border`, `--code-inline-bg`, `--code-inline-text`                                                                            |
| **Rail**      | `--rail-hover`, `--rail-label`, `--fill-icon`                                                                                                                    |
| **Modal**     | `--modal-overlay`, `--modal-shadow`                                                                                                                              |
| **Toggle**    | `--toggle-on-bg`, `--toggle-on-dot`, `--toggle-off-bg`, `--toggle-off-dot`                                                                                       |
| **Divider**   | `--divider-text`, `--divider-border`                                                                                                                             |

## Tailwind v4 integration

Tokens are bridged into Tailwind utility classes via the `@theme inline` block:

```css
@theme inline {
  --color-surface: var(--bg-base);
  --color-surface-alt: var(--bg-surface);
  --color-raised: var(--bg-elevated);
  --color-content: var(--text-primary);
  --color-content-dim: var(--text-secondary);
  --color-content-muted: var(--text-muted);
  --color-edge: var(--border);
  --color-edge-light: var(--border-light);
  --color-edge-dim: var(--border-dim);
  /* ... */
}
```

This lets you use tokens as Tailwind classes:

```svelte
<div class="bg-surface text-content border border-edge">
  <span class="text-content-muted">Muted text</span>
</div>
```

## shadcn-svelte bridge

shadcn-svelte expects specific CSS variable names. The `@theme inline` block maps our tokens to shadcn's expected format:

```css
--color-background: var(--background);
--color-foreground: var(--foreground);
--color-primary: var(--sn-primary);
--color-accent: var(--c7-accent);
--color-sidebar-background: var(--bg-sidebar);
/* ... */
```

## Font system

| Token            | Value                             | Usage                                    |
| ---------------- | --------------------------------- | ---------------------------------------- |
| `--font-lato`    | Lato, Arial, sans-serif           | Body text (default)                      |
| `--font-outfit`  | Outfit, Roboto, Arial, sans-serif | Headings                                 |
| `--font-inter`   | Inter, sans-serif                 | Alternative                              |
| `--font-size-sm` | 0.9375rem (15px)                  | Global override for Tailwind's `text-sm` |

The `--font-size-sm` override is important: it changes Tailwind's `text-sm` from 14px to 15px globally, matching the original design's base text size.

## Motion tokens

```css
--duration-instant: 50ms;
--duration-fast: 100ms;
--duration-quick: 150ms;
--duration-normal: 200ms;
--duration-moderate: 300ms;
--duration-slow: 400ms;

--ease-enter: cubic-bezier(0, 0, 0.2, 1);
--ease-exit: cubic-bezier(0.4, 0, 1, 1);
--ease-move: cubic-bezier(0.4, 0, 0.2, 1);
```

## Next steps

- [Theming](./15-theming.md) — How dark/light mode works and how to create custom themes
- [Typography and spacing](./16-typography-spacing.md) — Font stack and spacing scale details
- [Token reference](./21-token-reference.md) — Complete list of every token with values
