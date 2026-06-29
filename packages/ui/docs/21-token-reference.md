# Token Reference

Complete list of CSS custom properties defined in `src/app.css`. Values shown for both dark and light themes.

## Brand

| Token                   | Dark      | Light     |
| ----------------------- | --------- | --------- |
| `--brand-primary`       | `#ffffff` | `#18181b` |
| `--brand-primary-dark`  | `#d4d4d4` | `#09090b` |
| `--brand-primary-light` | `#e5e5e5` | `#27272a` |
| `--brand-contrast`      | `#09090b` | `#ffffff` |
| `--c7-accent`           | `#6366f1` | `#6366f1` |
| `--c7-accent-hover`     | `#818cf8` | `#4f46e5` |

## Surfaces

| Token           | Dark        | Light     | Tailwind class   |
| --------------- | ----------- | --------- | ---------------- |
| `--bg-base`     | `#1a1d21`   | `#ffffff` | `bg-surface`     |
| `--bg-surface`  | `#222529`   | `#fbfbfb` | `bg-surface-alt` |
| `--bg-elevated` | `#2a2d31`   | `#eaeaea` | `bg-raised`      |
| `--bg-sidebar`  | `#10121499` | `#fbfbfb` | `bg-sidebar-bg`  |
| `--bg-deeper`   | `#161719`   | `#f9fafb` | `bg-deeper`      |
| `--bg-deepest`  | `#0d1117`   | `#f3f4f6` | `bg-deepest`     |

## Text

| Token              | Dark        | Light     | Tailwind class       |
| ------------------ | ----------- | --------- | -------------------- |
| `--primary`        | `#f8f8f8`   | `#111827` | `text-white`         |
| `--secondary`      | `#e0e0e0cc` | `#6b7280` | —                    |
| `--text-primary`   | `#d1d2d3`   | `#111827` | `text-content`       |
| `--text-secondary` | `#9b9c9e`   | `#6b7280` | `text-content-dim`   |
| `--text-muted`     | `#616061`   | `#9ca3af` | `text-content-muted` |
| `--channel-gray`   | `#d1d2d3`   | `#111827` | `text-channel-gray`  |
| `--sidebar-item`   | `#d1d2d3`   | `#4a494a` | `text-sidebar-gray`  |
| `--icon-gray`      | `#b1b1b2`   | `#6b7280` | `text-icon-gray`     |

## Borders

| Token             | Dark        | Light       | Tailwind class         |
| ----------------- | ----------- | ----------- | ---------------------- |
| `--border`        | `#383a3e`   | `#eeeff1`   | `border-edge`          |
| `--border-light`  | `#565759`   | `#e0e0e0`   | `border-edge-light`    |
| `--border-dim`    | `#797c814d` | `#e5e7eb`   | `border-edge-dim`      |
| `--border-subtle` | `#797c8126` | `#d1d5db40` | `border-border-subtle` |

## Interactive states

| Token              | Dark                     | Light              |
| ------------------ | ------------------------ | ------------------ |
| `--hover-gray`     | `#f8f8f814`              | `#e5e7eb`          |
| `--sidebar-hover`  | `rgba(248,248,248,0.08)` | `rgba(0,0,0,0.05)` |
| `--sidebar-active` | `rgba(248,248,248,0.18)` | `#000000`          |
| `--rail-hover`     | `rgba(248,248,248,0.25)` | `rgba(0,0,0,0.08)` |
| `--rail-label`     | `#b1b1b2`                | `#6b7280`          |
| `--fill-icon`      | `#e8e8e8b3`              | `#6b7280`          |

## Status colors

| Token       | Dark      | Light     | Tailwind class                |
| ----------- | --------- | --------- | ----------------------------- |
| `--online`  | `#3daa7c` | `#3daa7c` | `bg-online` / `text-online`   |
| `--error`   | `#e01e5a` | `#e01e5a` | `bg-error` / `text-error`     |
| `--warning` | `#e8ab5a` | `#e8ab5a` | `bg-warning` / `text-warning` |
| `--link`    | `#3b82f6` | `#3b82f6` | `text-link`                   |
| `--info`    | `#67e8f9` | `#67e8f9` | `text-info`                   |
| `--review`  | `#a78bfa` | `#a78bfa` | `text-review`                 |
| `--pin`     | `#f59e0b` | `#f59e0b` | `text-pin`                    |

## Buttons

| Token                    | Dark      | Light     |
| ------------------------ | --------- | --------- |
| `--btn-primary-bg`       | `#fafafa` | `#18181b` |
| `--btn-primary-text`     | `#18181b` | `#ffffff` |
| `--btn-primary-hover`    | `#e4e4e7` | `#27272a` |
| `--btn-secondary-bg`     | `#27272a` | `#ffffff` |
| `--btn-secondary-text`   | `#fafafa` | `#18181b` |
| `--btn-secondary-border` | `#3f3f46` | `#e4e4e7` |
| `--btn-secondary-hover`  | `#3f3f46` | `#f4f4f5` |

## Dropdowns

| Token                  | Dark                         | Light                         |
| ---------------------- | ---------------------------- | ----------------------------- |
| `--dropdown-bg`        | `#1a1d21`                    | `#ffffff`                     |
| `--dropdown-border`    | `#383a3e`                    | `rgba(0,0,0,0.08)`            |
| `--dropdown-shadow`    | `0 4px 16px rgba(0,0,0,0.4)` | `0 4px 12px rgba(0,0,0,0.08)` |
| `--dropdown-selected`  | `rgba(79,179,237,0.12)`      | `#f0f4f8`                     |
| `--dropdown-hover`     | `rgba(255,255,255,0.06)`     | `#f5f7fa`                     |
| `--dropdown-name`      | `#d1d2d3`                    | `#1d1c1d`                     |
| `--dropdown-secondary` | `#9b9c9e`                    | `#656565`                     |

## Code

| Token                | Dark                    | Light                   |
| -------------------- | ----------------------- | ----------------------- |
| `--code-bg`          | `#1e1e1e`               | `#f6f8fa`               |
| `--code-text`        | `#d4d4d4`               | `#24292e`               |
| `--code-border`      | `#383a3e`               | `#e1e4e8`               |
| `--code-inline-bg`   | `rgba(110,118,129,0.4)` | `rgba(175,184,193,0.2)` |
| `--code-inline-text` | `#e06c75`               | `#c7254e`               |

## Toggle

| Token              | Dark      | Light     |
| ------------------ | --------- | --------- |
| `--toggle-on-bg`   | `#ffffff` | `#111827` |
| `--toggle-on-dot`  | `#111827` | `#ffffff` |
| `--toggle-off-bg`  | `#4b5563` | `#d1d5db` |
| `--toggle-off-dot` | `#ffffff` | `#ffffff` |

## Modal / Overlay

| Token             | Dark                                                            | Light                  |
| ----------------- | --------------------------------------------------------------- | ---------------------- |
| `--modal-overlay` | `rgba(0,0,0,0.6)`                                               | `rgba(0,0,0,0.4)`      |
| `--modal-shadow`  | `0 0 0 1px rgba(29,28,29,0.13), 0 18px 48px 0 rgba(0,0,0,0.35)` | `... rgba(0,0,0,0.12)` |
| `--overlay-bg`    | `rgba(0,0,0,0.6)`                                               | `rgba(0,0,0,0.4)`      |

## Score / Health

| Token              | Dark      | Light     |
| ------------------ | --------- | --------- |
| `--score-healthy`  | `#6ee7b7` | `#059669` |
| `--score-warning`  | `#fcd34d` | `#b45309` |
| `--score-critical` | `#fca5a5` | `#b91c1c` |

## Mentions

| Token            | Dark                    | Light                   |
| ---------------- | ----------------------- | ----------------------- |
| `--mention-text` | `#5bb5f0`               | `#1264a3`               |
| `--mention-bg`   | `rgba(91,181,240,0.13)` | `rgba(29,155,209,0.07)` |

## Motion

| Token                 | Value                          |
| --------------------- | ------------------------------ |
| `--duration-instant`  | `50ms`                         |
| `--duration-fast`     | `100ms`                        |
| `--duration-quick`    | `150ms`                        |
| `--duration-normal`   | `200ms`                        |
| `--duration-moderate` | `300ms`                        |
| `--duration-slow`     | `400ms`                        |
| `--ease-enter`        | `cubic-bezier(0, 0, 0.2, 1)`   |
| `--ease-exit`         | `cubic-bezier(0.4, 0, 1, 1)`   |
| `--ease-move`         | `cubic-bezier(0.4, 0, 0.2, 1)` |

## Misc

| Token              | Dark                     | Light              |
| ------------------ | ------------------------ | ------------------ |
| `--caret-color`    | `#ffffff`                | `#1d1c1d`          |
| `--avatar-ring`    | `#1a1d21`                | `#ffffff`          |
| `--focus-ring`     | `rgb(18,100,163)`        | `rgb(18,100,163)`  |
| `--highlight-bg`   | `#e8912d40`              | `#e8912d30`        |
| `--msg-hover-bg`   | `rgba(248,248,248,0.04)` | `rgba(0,0,0,0.04)` |
| `--divider-text`   | `#ababad`                | `#1d1c1d`          |
| `--divider-border` | `rgba(255,255,255,0.08)` | `#d0d0d0`          |
