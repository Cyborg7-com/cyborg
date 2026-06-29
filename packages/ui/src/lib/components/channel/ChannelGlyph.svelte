<script lang="ts">
  // Shared channel iconography — replaces the lock/hash/archive SVGs that were
  // inlined (and drifting) across the channel views and list rows. `kind` picks
  // the glyph; `class` controls size/color.
  //   • public  — inline text "#" prefix (channel headers / titles).
  //   • hash     — the standalone drawn "#" icon (list rows, search, switcher,
  //                browse) that was inlined 7× with the same stroked path.
  //   • private  — filled padlock (channel headers / details).
  //   • archive  — filled archive box.
  // `strokeWidth` only applies to the stroked `hash` glyph (e.g. bump it for an
  // unread row).
  let {
    kind,
    class: cls = "",
    strokeWidth = 1.5,
  }: {
    kind: "public" | "hash" | "private" | "archive";
    class?: string;
    strokeWidth?: number;
  } = $props();
</script>

{#if kind === "public"}
  <span class={cls} aria-hidden="true">#</span>
{:else if kind === "hash"}
  <svg
    class={cls}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width={strokeWidth}
    stroke-linecap="round"
    aria-hidden="true"
  >
    <path d="M3 6h10M3 10h10M6.5 3L5 13M11 3L9.5 13" />
  </svg>
{:else if kind === "private"}
  <svg class={cls} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path
      d="M12 7H4V5a4 4 0 118 0v2zm-6 0h4V5a2 2 0 10-4 0v2zm-3 1a1 1 0 00-1 1v5a1 1 0 001 1h10a1 1 0 001-1V9a1 1 0 00-1-1H3z"
    />
  </svg>
{:else}
  <svg class={cls} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path
      d="M2 3a1 1 0 011-1h10a1 1 0 011 1v2a1 1 0 01-1 1H3a1 1 0 01-1-1V3zm1 4h10v6a1 1 0 01-1 1H4a1 1 0 01-1-1V7zm3 2a1 1 0 000 2h4a1 1 0 100-2H6z"
    />
  </svg>
{/if}
