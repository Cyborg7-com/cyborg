<script lang="ts">
  // Built-in recipe glyphs (lucide-shaped, stroke = currentColor) so they adapt to
  // the theme like GitHubIcon. Rendered inside the integrations card icon-tile.
  //   standup       → users
  //   retro         → message-square / repeat
  //   blocker_sweep → shield-alert
  import { cn } from "$lib/utils.js";

  let {
    name,
    size = 22,
    class: className = "",
  }: {
    name: "standup" | "retro" | "blocker_sweep";
    size?: number;
    class?: string;
  } = $props();
</script>

<svg
  class={cn("shrink-0", className)}
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if name === "standup"}
    <!-- users -->
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  {:else if name === "retro"}
    <!-- repeat -->
    <path d="m17 2 4 4-4 4" />
    <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
    <path d="m7 22-4-4 4-4" />
    <path d="M21 13v1a4 4 0 0 1-4 4H3" />
  {:else}
    <!-- shield-alert -->
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    <path d="M12 8v4" />
    <path d="M12 16h.01" />
  {/if}
</svg>
