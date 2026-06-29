<script lang="ts" module>
  /**
   * iOS-style relative timestamp for conversation rows (iMessage convention):
   * today → clock time, yesterday → "Yesterday", within a week → weekday,
   * older → short date. Returns null for missing/zero timestamps so callers
   * can simply omit the time column when no recency data exists (DATA RULE:
   * never invent a timestamp).
   */
  export function conversationTime(ms: number | null | undefined): string | null {
    if (!ms || ms <= 0) return null;
    const then = new Date(ms);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const DAY = 86_400_000;
    if (ms >= startOfToday) {
      return then.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }
    if (ms >= startOfToday - DAY) return "Yesterday";
    if (ms >= startOfToday - 6 * DAY) {
      return then.toLocaleDateString(undefined, { weekday: "short" });
    }
    return then.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
  }
</script>

<script lang="ts">
  // The shared mobile conversation row (S3): one ~54pt iOS-style row used by
  // the Chats tab / drawer (ChannelSidebar mobile branch), the DMs tab, and
  // the Home dashboard — so channel/DM/agent rows can never drift apart.
  //
  // Layout: leading visual (channel → rounded-square #/lock tile on a subtle
  // accent tint; DM → 42px Avatar + presence dot; agent → caller-supplied
  // avatar via the `leading` snippet) · name (16px semibold, bold when unread)
  // over an optional muted preview line · trailing column: relative time above
  // an accent unread pill (99+ cap). Hairline separator inset past the leading
  // visual; hidden on the last row of a run (iOS-style).
  import type { Snippet } from "svelte";
  import Avatar from "$lib/components/Avatar.svelte";
  import ChannelGlyph from "./ChannelGlyph.svelte";
  import { cn } from "$lib/utils.js";

  let {
    kind = "channel",
    name,
    isPrivate = false,
    image = null,
    presence = null,
    preview = null,
    time = null,
    unreadCount = 0,
    unread = false,
    active = false,
    muted = false,
    ariaLabel,
    onclick,
    oncontextmenu,
    leading,
    nameAccessory,
    trailing,
  }: {
    /** Drives the default leading visual when no `leading` snippet is given. */
    kind?: "channel" | "dm" | "agent";
    name: string;
    /** Channel rows: lock glyph instead of #. */
    isPrivate?: boolean;
    /** DM rows: avatar image URL (falls back to initials). */
    image?: string | null;
    /** DM rows: presence dot overlay on the avatar. */
    presence?: "online" | "away" | null;
    /** Optional muted second line (presence text, folder, …) — never invented. */
    preview?: string | null;
    /** Pre-formatted relative time (see conversationTime). Omitted when null. */
    time?: string | null;
    /** Unread pill count (accent bg, 99+ cap). 0 hides the pill. */
    unreadCount?: number;
    /** Bold + brighter name (unread flag, independent of the count pill). */
    unread?: boolean;
    /** Currently-open conversation (drawer case): subtle tint + aria-current. */
    active?: boolean;
    /** Muted conversation: dimmed name + leading visual. */
    muted?: boolean;
    ariaLabel?: string;
    onclick: () => void;
    oncontextmenu?: (e: MouseEvent) => void;
    /** Replaces the default leading visual (e.g. CyboSessionAvatar tiles). */
    leading?: Snippet;
    /** Inline after the name: draft pencil, mute icon, status emoji, tags. */
    nameAccessory?: Snippet;
    /** Extra trailing content next to the pill: kebab menus, perm badges, …. */
    trailing?: Snippet;
  } = $props();
</script>

<div
  role="button"
  tabindex="0"
  aria-label={ariaLabel ?? name}
  aria-current={active ? "page" : undefined}
  {onclick}
  {oncontextmenu}
  onkeydown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onclick();
    }
  }}
  class="conv-row pressable-row relative flex w-full min-h-[54px] cursor-pointer items-center gap-3 px-4 py-1.5 text-left"
>
  <!-- Leading visual -->
  {#if leading}
    {@render leading()}
  {:else if kind === "dm"}
    <Avatar {name} {image} status={presence} width={42} fontSize={16} class={cn(muted && "opacity-50")} />
  {:else if kind === "agent"}
    <Avatar {name} {image} width={42} fontSize={16} borderRadius={12} class={cn(muted && "opacity-50")} />
  {:else}
    <!-- Plain glyph, no tile box (Slack iOS): a tinted square reads as a
         washed-out placeholder on a dark list. Bold/bright when unread, muted
         otherwise, so the leading visual carries the same unread signal as the
         name. -->
    <span
      class={cn(
        "flex h-[42px] w-[42px] shrink-0 items-center justify-center",
        unread ? "text-content" : "text-content-muted",
        muted && "opacity-50",
      )}
      aria-hidden="true"
    >
      {#if isPrivate}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      {:else}
        <ChannelGlyph kind="hash" class="w-[22px] h-[22px]" strokeWidth={unread ? 1.9 : 1.5} />
      {/if}
    </span>
  {/if}

  <!-- Name + optional preview -->
  <span class="flex min-w-0 flex-1 flex-col justify-center gap-px">
    <span class="flex min-w-0 items-center gap-1.5">
      <span
        class={cn(
          "truncate text-[16px] leading-[21px]",
          unread ? "font-semibold text-content" : "font-normal text-content-dim",
          muted && "opacity-50",
        )}
      >{name}</span>
      {#if nameAccessory}
        {@render nameAccessory()}
      {/if}
    </span>
    {#if preview}
      <span class="truncate text-[14px] leading-[19px] text-content-muted">{preview}</span>
    {/if}
  </span>

  <!-- Trailing column: relative time over unread pill / accessories -->
  {#if time || unreadCount > 0 || trailing}
    <span class="flex shrink-0 flex-col items-end justify-center gap-[3px]">
      {#if time}
        <span class="text-[13px] leading-[16px] text-content-muted tabular-nums">{time}</span>
      {/if}
      {#if unreadCount > 0 || trailing}
        <span class="flex items-center gap-1.5">
          {#if trailing}
            {@render trailing()}
          {/if}
          {#if unreadCount > 0}
            <!-- #524: subtle one-shot pop on appear/increment. Keying on the
                 count remounts the pill so the animation replays each change;
                 animate-pulse-once is reduced-motion-guarded in app.css. -->
            {#key unreadCount}
              <span
                class="animate-pulse-once flex h-[19px] min-w-[19px] items-center justify-center rounded-full bg-accent px-[6px] text-[12px] font-bold leading-none text-accent-foreground"
              >{unreadCount > 99 ? "99+" : unreadCount}</span>
            {/key}
          {/if}
        </span>
      {/if}
    </span>
  {/if}

  <!-- No per-row separators: hairlines under some rows but not their section
       headers create a Mach-band striping illusion on a dark list (read as
       "zebra bands" in QA). Slack iOS-style dark lists separate rows with
       spacing alone; hairlines stay reserved for chrome and grouped settings
       lists. -->
</div>
