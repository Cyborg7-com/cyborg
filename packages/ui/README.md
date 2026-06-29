# @cyborg7/ui

Collaboration UI for Cyborg7. A customizable "blank Slack" shell built with Svelte 5 and Tailwind CSS v4.

## Stack

- **Svelte 5** (runes: `$state`, `$derived`, `$props()`)
- **SvelteKit** with `adapter-static` (no SSR)
- **Tailwind CSS v4** with `@theme` block for design tokens
- **shadcn-svelte** for base components

## Architecture

Shell-agnostic design — rail items, sidebar sections, toolbar items, and settings tabs are all data-driven via `shellConfig.configure()` and `pluginRegistry.register()`.

```
src/
  lib/
    core/
      client.ts         # WebSocket client (CyborgClient)
      types.ts          # Shared TypeScript interfaces
      state.svelte.ts   # Global reactive state (workspaceState)
      plugin.svelte.ts  # Plugin registry + shell config
    components/
      message/          # ChatMessage, MessageList, MessageInput, MessageRenderer
      composer/         # Composer toolbar/attachments/voice, EmojiPicker, mentions
      channel/          # Channel sidebar/header/search, members dialog
      panes/            # *Pane (Activity, Agents, Logs, Memory, Skills, Home, Audit)
      ui/               # shadcn-svelte primitives
      settings/         # Settings widgets (nav, theme toggle, status badge)
      *.svelte          # shared primitives (Avatar, Toolbar, ConfirmDialog, …)
    state/
      app.svelte.ts     # Application actions (selectWorkspace, inviteMember, etc.)
  routes/
    workspace/[id]/     # Workspace layout + all nested routes
      settings/         # Settings pages (workspace, members, backend)
      cybos/[cyboId]/   # Cybo edit page
```

## Key Concepts

### Connection Modes

Three login modes: cloud (EC2 relay), self-hosted (custom server), local (localhost daemon).

### WebSocket Protocol

All messages use the Paseo session envelope:

```
{ type: "session", message: { type: "cyborg:*", payload: { requestId, ...data } } }
```

`requestId` lives in `payload`, not at message root.

### Shell Config

The root `+layout.svelte` calls `shellConfig.configure()` with explicit arrays for tabs, toolbar items, etc. Adding a new tab to `DEFAULT_CONFIG` is NOT enough — it must also be added to the layout's configure call (replace, not merge).

### Design Tokens

3-tier system in `app.css`: primitives → semantic → component. Dark/light via `[data-theme]` attribute. Override tokens globally, don't change utility classes in every file.

## Development

```bash
pnpm dev          # dev server on port 5173
pnpm build        # static build (adapter-static)
pnpm check        # svelte-check (type checking)
```

## Conventions

- Svelte 5 runes only — no `export let`, no `$:`, no stores
- `$props()` for component props, `onclick={...}` for events
- `{#snippet}` + `{@render}` instead of `<slot>`
- shadcn-svelte components first, custom HTML second
- Theme tokens in CSS custom properties, not hardcoded values
- No features that don't exist in the original web app
