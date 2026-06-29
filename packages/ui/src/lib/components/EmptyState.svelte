<script lang="ts">
  // Reusable contextual empty-state primitive (#526). Renders a centered
  // (optional) icon + title + description, with an optional action button or
  // custom action snippet. The single source for "nothing here" surfaces —
  // empty channels, archived channels, failed loads, and the list panes
  // (Activity / Logs / Memory / Skills / Threads, etc.). Purely presentational:
  // colors come from design tokens, never hardcoded.
  //
  // Flexible so each surface keeps its exact look while sharing one scaffold:
  //  - `class`            — container layout (padding / fill / box). Defaults to
  //                         the full-area centered card used by channel views.
  //  - `icon` + `iconWrap`— `iconWrap` (default) wraps the icon in the standard
  //                         44px badge; pass `iconWrap={false}` to render the
  //                         icon snippet bare (caller supplies its own glyph/box).
  //  - `noIcon`           — render no icon at all (compact, text-only states).
  //  - `titleClass` / `descriptionClass` — typography overrides; default to the
  //                         canonical sizes so new call sites stay uniform.
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils.js";

  type Variant = "new" | "archived" | "error" | "search" | "info";

  let {
    variant = "info",
    title,
    description,
    actionLabel,
    onAction,
    action,
    icon,
    iconWrap = true,
    noIcon = false,
    class: className = "h-full px-6 py-12",
    titleClass = "text-[15px] font-bold text-content",
    descriptionClass = "mt-1 max-w-[320px] text-[13px] leading-relaxed text-content-muted",
  }: {
    variant?: Variant;
    title: string;
    description?: string;
    // Built-in action button (omit both to render no CTA).
    actionLabel?: string;
    onAction?: () => void;
    // Custom action area (overrides actionLabel/onAction when provided).
    action?: Snippet;
    // Custom icon (overrides the variant's default glyph).
    icon?: Snippet;
    // Wrap the icon in the standard badge (true) or render it bare (false).
    iconWrap?: boolean;
    // Render no icon/badge at all.
    noIcon?: boolean;
    class?: string;
    titleClass?: string;
    descriptionClass?: string;
  } = $props();

  // The accent ring/tint per variant. Error leans on --color-error, archived on a
  // neutral muted tone, the rest on the muted/dim content tokens.
  const tone = $derived(
    variant === "error"
      ? "text-error"
      : variant === "archived"
        ? "text-content-dim"
        : "text-content-muted",
  );
</script>

<!-- No live-region role here: EmptyState can hold an interactive action
     (button/link), and wrapping focusable content in an aria-live container is an
     ARIA anti-pattern. -->
<div class={cn("flex flex-col items-center justify-center text-center", className)}>
  {#if !noIcon}
    {#if iconWrap}
      <div class={cn("mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted", tone)}>
        {#if icon}
          {@render icon()}
        {:else if variant === "archived"}
          <!-- Padlock -->
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        {:else if variant === "error"}
          <!-- Alert triangle -->
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        {:else if variant === "search"}
          <!-- Magnifier -->
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        {:else}
          <!-- Speech bubbles (new / info) -->
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        {/if}
      </div>
    {:else if icon}
      <div class="mb-3">{@render icon()}</div>
    {/if}
  {/if}

  <h3 class={titleClass}>{title}</h3>
  {#if description}
    <p class={descriptionClass}>{description}</p>
  {/if}

  {#if action}
    <div class="mt-4">{@render action()}</div>
  {:else if actionLabel && onAction}
    <button
      type="button"
      onclick={onAction}
      class="mt-4 cursor-pointer rounded-lg border border-edge px-3 py-1.5 text-[13px] font-medium text-content transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      {actionLabel}
    </button>
  {/if}
</div>
