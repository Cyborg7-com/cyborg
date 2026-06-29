<script lang="ts">
  // Renders a task's resolved assignee as an avatar that reads, at a glance, as
  // a HUMAN, a CYBO, an AGENT, or UNASSIGNED — the key differentiation the Tasks
  // board needs (a flat round photo can't tell a teammate from a bot).
  //
  // Treatment per kind:
  //   user      → plain round Avatar (photo / colored initials). No ring, no badge.
  //   cybo      → Avatar + a solid accent ring + a tiny spark glyph badge.
  //   agent     → Avatar + a gradient accent ring + a tiny bot glyph badge.
  //   unknown   → same non-human treatment as a cybo (still a machine identity).
  //   null      → a dashed-circle "Unassigned" placeholder (no Avatar at all).
  //
  // Pure presentation over a ResolvedAssignee (resolveAssignee output). The ring
  // lives on a wrapper so the underlying Avatar's image/emoji/initials branches
  // are untouched; the badge is an absolutely-positioned overlay. Colors come
  // from theme tokens only.
  import Avatar from "$lib/components/Avatar.svelte";
  import type { ResolvedAssignee } from "$lib/tasks/assignee.js";
  import { cn } from "$lib/utils.js";

  let {
    assignee,
    size = 18,
    class: className = "",
  }: {
    // null = nobody assigned → render the dashed placeholder.
    assignee: ResolvedAssignee | null;
    size?: number;
    class?: string;
  } = $props();

  // A non-human identity (cybo / agent / unknown) gets the ring + badge. A human
  // (user) stays a plain avatar; unassigned (null) is handled separately.
  const isMachine = $derived(
    assignee != null && (assignee.kind === "cybo" || assignee.kind === "agent" || assignee.kind === "unknown"),
  );
  const isAgent = $derived(assignee?.kind === "agent");

  // Badge sits at the bottom-right; scale it to the avatar so it stays a small,
  // legible dot at any size. Min 11px so the glyph never collapses.
  const badge = $derived(Math.max(11, Math.round(size * 0.62)));
  const glyph = $derived(Math.max(7, badge - 4));
</script>

{#if !assignee}
  <!-- Unassigned: a quiet dashed circle, no name resolution. -->
  <span
    title="Unassigned"
    aria-label="Unassigned"
    class={cn(
      "inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-edge-light text-content-muted",
      className,
    )}
    style:width="{size}px"
    style:height="{size}px"
  >
    <svg
      width={Math.max(8, Math.round(size * 0.5))}
      height={Math.max(8, Math.round(size * 0.5))}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
    </svg>
  </span>
{:else if isMachine}
  <!-- Cybo / agent / unknown: avatar with an accent ring + a corner glyph badge
       so it reads as non-human. Agents get a gradient ring (vs the cybo's solid
       ring) to tell the two machine kinds apart when it's cheap to. -->
  <span
    class={cn("relative inline-flex shrink-0", className)}
    style:width="{size}px"
    style:height="{size}px"
  >
    <span
      class={cn(
        "flex h-full w-full items-center justify-center rounded-full p-[1.5px]",
        isAgent
          ? "bg-gradient-to-br from-accent to-info"
          : "bg-accent",
      )}
    >
      <span class="flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-surface">
        <Avatar
          name={assignee.name}
          avatar={assignee.avatarUrl}
          width={size - 3}
          fontSize={Math.max(7, Math.round((size - 3) * 0.4))}
        />
      </span>
    </span>

    <!-- Corner badge: spark for a cybo, bot face for an agent. Bordered with the
         avatar-ring token so it punches out cleanly over any avatar art. -->
    <span
      class="absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full border-[1.5px] border-avatar-ring bg-accent text-accent-foreground"
      style:width="{badge}px"
      style:height="{badge}px"
    >
      {#if isAgent}
        <!-- bot -->
        <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="5" y="8" width="14" height="11" rx="2.5" />
          <path d="M12 8V4" /><circle cx="12" cy="3" r="1" />
          <circle cx="9.5" cy="13" r="0.6" fill="currentColor" /><circle cx="14.5" cy="13" r="0.6" fill="currentColor" />
        </svg>
      {:else}
        <!-- spark -->
        <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2l1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6L12 2z" />
        </svg>
      {/if}
    </span>
  </span>
{:else}
  <!-- Human: a plain round avatar, no ring, no badge. -->
  <span class={cn("inline-flex shrink-0", className)}>
    <Avatar
      name={assignee.name}
      avatar={assignee.avatarUrl}
      width={size}
      fontSize={Math.max(8, Math.round(size * 0.4))}
    />
  </span>
{/if}
