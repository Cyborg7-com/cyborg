<!--
  PanelHeader — the shared "title + close (X) + bottom border" header that every
  slide-in side panel (Profile / Thread / Pinned, and future ones) used to
  hand-roll with drifting padding, font sizes, title color, and three different
  X-icon SVGs (#529). One canonical box + close button (with aria-label +
  focus-ring + touch-target).

  Props:
  - `title`      — the panel title.
  - `onClose`    — close handler for the X button.
  - `closeLabel` — accessible name / tooltip for the X button (default "Close").
  - `subtitle`   — optional snippet rendered under the title (e.g. Thread's
                   mobile "#channel" line).
  - `actions`    — optional snippet rendered to the left of the close button.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    title,
    onClose,
    closeLabel = "Close",
    subtitle,
    actions,
  }: {
    title: string;
    onClose: () => void;
    closeLabel?: string;
    subtitle?: Snippet;
    actions?: Snippet;
  } = $props();
</script>

<header class="flex shrink-0 items-center justify-between gap-2 border-b border-edge px-4 py-3">
  <div class="flex min-w-0 flex-col leading-tight">
    <span class="text-[15px] font-semibold text-content">{title}</span>
    {#if subtitle}
      {@render subtitle()}
    {/if}
  </div>
  <div class="flex shrink-0 items-center gap-1">
    {#if actions}
      {@render actions()}
    {/if}
    <button
      type="button"
      onclick={onClose}
      class="rounded p-1 text-content-dim transition-colors hover:bg-edge hover:text-content focus-ring touch-target"
      title={closeLabel}
      aria-label={closeLabel}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  </div>
</header>
