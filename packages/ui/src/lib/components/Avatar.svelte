<script lang="ts">
  import { cn, getInitials, nameToColor, resolveAvatarSource } from "$lib/utils.js";

  let {
    name,
    width = 36,
    size,
    fontSize = 16,
    fontWeight = 600,
    borderRadius = "50%",
    image,
    avatar,
    overdueWarning = false,
    status = null,
    class: className = "",
  }: {
    name: string;
    width?: number;
    /**
     * Optional named size token. When provided it overrides `width` with a
     * fixed pixel value; when omitted, the numeric `width` prop is used as-is
     * (backward-compatible). Mapping (matches Mattermost xs..xl + our usage):
     *   xs = 20px, sm = 24px, md = 36px (default width), lg = 48px, xl = 72px
     */
    size?: "xs" | "sm" | "md" | "lg" | "xl";
    fontSize?: number;
    fontWeight?: number | string;
    borderRadius?: number | string;
    image?: string | null;
    /**
     * Raw avatar string that may be an image URL OR a single emoji (cybo
     * avatars). When provided it is resolved via the ONE shared
     * `resolveAvatarSource` rule, so Avatar renders the emoji branch natively
     * instead of each cybo surface re-deciding with its own regex. Mutually
     * exclusive with `image` in practice; if both are passed, `avatar` wins.
     * Omitting it keeps the legacy `image` + initials behavior unchanged.
     */
    avatar?: string | null;
    overdueWarning?: boolean;
    /**
     * Optional presence indicator. When set (non-null) a small dot is rendered
     * at the bottom-right of the avatar. When null/undefined nothing extra is
     * rendered (current behavior — callers opt in).
     */
    status?: "online" | "away" | "offline" | null;
    class?: string;
  } = $props();

  /** Named size token → fixed pixel width. */
  const SIZE_TOKENS = { xs: 20, sm: 24, md: 36, lg: 48, xl: 72 } as const;

  // Effective avatar width: named `size` token wins, else the numeric `width`.
  const effectiveWidth = $derived(size ? SIZE_TOKENS[size] : width);

  // Presence dot color, matching the presence-dot classes used in ChannelSidebar.
  // Away and offline share one grey treatment (away = manual toggle OR app
  // closed); only "active" is green. No DND.
  // Solid fills — the away/offline dot was bg-content-dim/40 (40% opacity), so
  // the avatar + background bled through and it read as a half-painted dot.
  const STATUS_COLORS = {
    online: "bg-online",
    away: "bg-content-dim",
    offline: "bg-content-dim",
  } as const;

  // When a raw `avatar` string is supplied, resolve it through the ONE shared
  // rule (image | emoji | initials). Otherwise keep the legacy contract: the
  // `image` prop is the URL and absence of it falls through to initials —
  // identical to the pre-emoji behavior, so existing callers are untouched.
  const source = $derived(avatar != null ? resolveAvatarSource(avatar, name) : null);
  const resolvedImage = $derived(source ? (source.kind === "image" ? source.value : null) : image);
  const emoji = $derived(source?.kind === "emoji" ? source.value : null);

  let imgFailed = $state(false);

  $effect(() => {
    // oxlint-disable-next-line eslint/no-unused-expressions -- track reactive dependency to reset on image change
    resolvedImage;
    imgFailed = false;
  });

  // Deterministic per-name swatch comes from the ONE shared util (utils.ts
  // nameToColor) so an identity gets the same color on every surface — see #528.
  const badgeSize = $derived(Math.max(10, Math.round(effectiveWidth * 0.35)));
</script>

<!-- Reusable presence dot, matching ChannelSidebar's dot style. -->
{#snippet statusDot()}
  {#if status}
    <span
      title={status === "online" ? "Active" : "Away"}
      class={cn(
        "absolute -bottom-0.5 -right-0.5 w-[8px] h-[8px] rounded-full border-[1.5px] border-avatar-ring",
        STATUS_COLORS[status],
      )}
    ></span>
  {/if}
{/snippet}

<!-- The avatar glyph itself (image | emoji | initials). One snippet so every
     wrapper context — overdue badge, presence dot, bare — renders the same
     three branches; `extraClass` carries the per-context className that was
     previously inlined on each leaf. Image + initials are byte-for-byte the
     legacy markup; emoji is the new branch, sized/rounded like initials. -->
{#snippet glyph(extraClass: string | undefined)}
  {#if resolvedImage && !imgFailed}
    <img
      style:width="{effectiveWidth}px"
      style:height="{effectiveWidth}px"
      style:border-radius={typeof borderRadius === "number" ? `${borderRadius}px` : borderRadius}
      class={cn("overflow-hidden object-cover shrink-0", extraClass)}
      src={resolvedImage}
      alt=""
      onerror={() => (imgFailed = true)}
    />
  {:else if emoji}
    <div
      style:width="{effectiveWidth}px"
      style:height="{effectiveWidth}px"
      style:border-radius={typeof borderRadius === "number" ? `${borderRadius}px` : borderRadius}
      style:font-size="{Math.round(effectiveWidth * 0.6)}px"
      class={cn(
        "shrink-0 leading-none font-sans flex items-center justify-center bg-surface-alt select-none",
        extraClass,
      )}
    >
      <span aria-hidden="true">{emoji}</span>
    </div>
  {:else}
    <div
      style:width="{effectiveWidth}px"
      style:height="{effectiveWidth}px"
      style:border-radius={typeof borderRadius === "number" ? `${borderRadius}px` : borderRadius}
      style:font-size="{fontSize}px"
      style:font-weight={fontWeight}
      style:background-color={nameToColor(name || "?")}
      class={cn(
        "shrink-0 uppercase font-sans flex items-center justify-center text-accent-foreground",
        extraClass,
      )}
    >
      <span class="select-none">{getInitials(name || "?")}</span>
    </div>
  {/if}
{/snippet}

{#if overdueWarning}
  <div class={cn("relative shrink-0", className)} style:width="{effectiveWidth}px" style:height="{effectiveWidth}px">
    {@render glyph(undefined)}
    <span
      title="Heartbeat overdue"
      class="absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full"
      style:width="{badgeSize}px"
      style:height="{badgeSize}px"
      style:background-color="#f59e0b"
      style:border="2px solid var(--bg-base, #0e0e0e)"
    >
      <svg width={Math.max(6, badgeSize - 6)} height={Math.max(6, badgeSize - 6)} viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M6 1.5L11 10.5H1L6 1.5Z" fill="#0e0e0e" />
        <rect x="5.4" y="5" width="1.2" height="3" fill="#f59e0b" />
        <rect x="5.4" y="8.5" width="1.2" height="1.2" fill="#f59e0b" />
      </svg>
    </span>
  </div>
{:else if status}
  <!-- Relative wrapper only when a presence dot needs to overlay. -->
  <div class={cn("relative shrink-0", className)} style:width="{effectiveWidth}px" style:height="{effectiveWidth}px">
    {@render glyph(undefined)}
    {@render statusDot()}
  </div>
{:else}
  {@render glyph(className)}
{/if}
