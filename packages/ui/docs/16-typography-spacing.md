# Typography and Spacing

## Font stack

| Token           | Value                                     | Usage                              |
| --------------- | ----------------------------------------- | ---------------------------------- |
| `--font-lato`   | `"Lato", "Arial", sans-serif`             | Body text, messages, sidebar items |
| `--font-outfit` | `"Outfit", "Roboto", "Arial", sans-serif` | Headings, workspace name           |
| `--font-inter`  | `"Inter", sans-serif`                     | Alternative for UI elements        |

Fonts are loaded in `app.html` via Google Fonts:

```html
<link
  href="https://fonts.googleapis.com/css2?family=Lato:wght@400;700;900&family=Outfit:wght@400;600;700&display=swap"
  rel="stylesheet"
/>
```

## Base font size

The design uses 15px as the base text size, not the browser default 16px or Tailwind's default 14px for `text-sm`. This is achieved by overriding Tailwind v4's `--font-size-sm` token:

```css
@theme inline {
  --font-size-sm: 0.9375rem; /* 15px */
  --font-size-sm--line-height: 1.375rem; /* 22px */
}
```

This means every `text-sm` in the codebase renders at 15px/22px instead of Tailwind's default 14px/20px.

## Type scale in use

| Element         | Size           | Weight         | Token/Class                             |
| --------------- | -------------- | -------------- | --------------------------------------- |
| Workspace name  | 18px           | 900 (black)    | `text-[18px] font-black`                |
| Section headers | 13px           | 600 (semibold) | `text-[13px] font-semibold`             |
| Sidebar items   | 15px (text-sm) | 400/600        | `text-sm` / `font-semibold` when active |
| Messages        | 15px (text-sm) | 400            | `text-sm`                               |
| Badges          | 10px           | 700 (bold)     | `text-[10px] font-bold`                 |
| Rail labels     | 11px           | 700 (bold)     | `text-[11px] font-bold`                 |
| Timestamps      | 12px           | 400            | `text-xs`                               |
| Tooltips        | 12px           | 400            | `text-xs`                               |

## Spacing conventions

The shell uses consistent spacing patterns:

| Context                | Value                     | Class                        |
| ---------------------- | ------------------------- | ---------------------------- |
| Rail width             | 70px                      | `w-[4.375rem]`               |
| Sidebar min width      | 215px                     | `min-width: 215px`           |
| Sidebar default width  | 275px                     | Reactive `$state`            |
| Sidebar item height    | 28px                      | `h-7`                        |
| Sidebar item padding   | `pl-4 pr-2.5`             | Left padding for indent      |
| Section gap            | `mt-3` (12px)             | Between collapsible sections |
| Rail icon size         | 36px container, 20px icon | `w-9 h-9` / `h-5 w-5`        |
| Workspace avatar       | 36px                      | `size-9`                     |
| Content padding        | `px-4 py-3`               | Standard panel padding       |
| Section header padding | `px-2 py-1`               | Inside collapsible headers   |

## Color conventions for text

| Role                 | Dark mode | Light mode | Class                                |
| -------------------- | --------- | ---------- | ------------------------------------ |
| Primary text         | `#f8f8f8` | `#1d1c1d`  | `text-white` (mapped to `--primary`) |
| Channel/member names | `#d1d2d3` | `#1d1c1d`  | `text-sidebar-gray`                  |
| Secondary text       | `#9b9c9e` | `#616061`  | `text-content-dim`                   |
| Muted text           | `#616061` | `#ababad`  | `text-content-muted`                 |
| Active item text     | `#ffffff` | `#1d1c1d`  | `text-white font-semibold`           |

## Next steps

- [Design system](./14-design-system.md) — Full token architecture
- [Token reference](./21-token-reference.md) — Complete token list with values
