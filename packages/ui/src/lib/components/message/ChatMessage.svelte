<script lang="ts">
  import type { Snippet } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { Message } from "$lib/types.js";
  import { CHANNEL_SLASH_COMMANDS } from "$lib/components/composer/slash-commands.js";
  import { cn, formatTime, formatSize, isExternalSlack } from "$lib/utils.js";
  import Emoji from "$lib/components/Emoji.svelte";
  import { authState, workspaceState, openThread, pinMessage, saveMessage, savedState, retrySendMessage } from "$lib/state/app.svelte.js";
  import { cyboState } from "$lib/plugins/agents/state.svelte.js";
  import { profilePanelState } from "$lib/profile-panel.svelte.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import type { MentionMeta } from "$lib/render-markdown.js";
  import { downloadFile } from "$lib/download.js";
  import { isTauriIOS, saveImageToPhotos, saveVideoToPhotos, saveFile } from "$lib/mobile/push.js";
  import { haptic } from "$lib/mobile/haptics.js";
  import Avatar from "../Avatar.svelte";
  import AuthorAvatar from "./AuthorAvatar.svelte";
  import { authorName } from "./message-author.js";
  import MessageRenderer from "./MessageRenderer.svelte";
  import MessageActionBar from "./MessageActionBar.svelte";
  import BlurHashImage from "./BlurHashImage.svelte";
  import VoicePlayer from "./VoicePlayer.svelte";
  import VideoPlayer from "./VideoPlayer.svelte";
  import ImagePreviewModal from "./ImagePreviewModal.svelte";
  import ImageViewerModal from "./ImageViewerModal.svelte";
  import AttachmentContextMenu from "./AttachmentContextMenu.svelte";
  import AttachmentActionSheet from "./AttachmentActionSheet.svelte";
  import LinkPreview from "./LinkPreview.svelte";
  import ReleaseCard from "./ReleaseCard.svelte";
  import EventCard from "./EventCard.svelte";
  import { swipeToReply } from "$lib/actions/swipeToReply.js";

  let {
    message,
    grouped = false,
    showAvatar = true,
    showRoleBadge = true,
    showHoverToolbar = true,
    hideThread = false,
    readOnly = false,
    embedded = false,
    timestampMode = "hover",
    avatarWidth = 36,
    avatarFontSize = 14,
    statusEmoji,
    statusTooltip,
    hoverActions,
    onClickName,
    onMentionClick,
    onChannelClick,
    onReaction,
    onEdit,
    onDelete,
    onRetry,
    onLongPress,
    editRequestId = null,
    editRequestNonce = 0,
    class: className = "",
  }: {
    message: Message;
    grouped?: boolean;
    showAvatar?: boolean;
    showRoleBadge?: boolean;
    showHoverToolbar?: boolean;
    hideThread?: boolean;
    // Channel preview (non-member, read-only): render reactions as static pills
    // (no toggle) and let the parent strip the hover toolbar / thread footer.
    readOnly?: boolean;
    // Embedded in a host card (e.g. the Saved pane), where the parent owns the
    // surface + insets. Drops the row's own horizontal padding / full-bleed
    // negative margin, its hover background, and its inter-group top margin so the
    // row aligns to the card's padding instead of painting a second, mismatched
    // box inside it. Default (false) = the normal full-bleed list row.
    embedded?: boolean;
    timestampMode?: "hover" | "always" | "inline";
    avatarWidth?: number;
    avatarFontSize?: number;
    statusEmoji?: string | null;
    statusTooltip?: string | null;
    hoverActions?: Snippet;
    onClickName?: (name: string, agentId?: string | null) => void;
    // MESSAGE-RENDER P0: clicks on rendered @mentions / #channels in the body.
    onMentionClick?: (name: string) => void;
    onChannelClick?: (name: string) => void;
    onReaction?: (messageId: string, emoji: string) => void;
    onEdit?: (messageId: string, newText: string) => void;
    onDelete?: (messageId: string) => void;
    // Retry a FAILED optimistic send. Defaults to the channel retry; the DM
    // surface passes retrySendDmMessage so the right list/peer is targeted.
    onRetry?: (localId: string) => void;
    // MOBILE: long-press on the message row opens the action sheet (parent
    // holds the sheet state). Mobile-gated + harmless off-mobile.
    onLongPress?: (messageId: string) => void;
    // MOBILE: lets the long-press action sheet (rendered by the parent) trigger
    // this row's inline editor. The parent bumps `editRequestNonce` and sets
    // `editRequestId` to a message id; when it matches us we open the editor.
    editRequestId?: string | null;
    editRequestNonce?: number;
    class?: string;
  } = $props();

  const isAgent = $derived(message.fromType === "agent");
  // Message-intrinsic name: fromName, else the fromId prefix (#507).
  const intrinsicName = $derived(authorName(message));
  // For an agent message the intrinsic name is often missing — fromName is unset,
  // so authorName() falls back to the bare fromId prefix ("728c6bcf"). Resolve the
  // real cybo name from the live roster (same lookup as <AuthorAvatar>: direct
  // cybo id, else the agentId → cyboId mapping) before showing that prefix.
  const rosterAgentName = $derived.by(() => {
    if (!isAgent) return null;
    const byId = cyboState.list?.find((c) => c.id === message.fromId);
    if (byId) return byId.name;
    const cyboId = workspaceState.agents?.find((a) => a.agentId === message.fromId)?.cyboId;
    return (cyboId ? cyboState.list?.find((c) => c.id === cyboId)?.name : null) ?? null;
  });
  // Header display name. Humans keep the intrinsic name unchanged. Agents prefer
  // the roster name only when the intrinsic one is just the bare id prefix (i.e.
  // fromName was missing) — a real fromName always wins.
  const displayName = $derived(
    isAgent && rosterAgentName && intrinsicName === message.fromId.slice(0, 8)
      ? rosterAgentName
      : intrinsicName,
  );
  // (A) A human message that is a registered channel slash command (e.g. the
  // user's "/summarize", posted to the channel) renders as a subtle command chip
  // instead of plain text — still attributed to the user via the normal header.
  const slashCommand = $derived.by(() => {
    if (message.fromType !== "human" || !message.text) return null;
    const m = message.text.match(/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i);
    if (!m) return null;
    const trigger = m[1].toLowerCase();
    if (!CHANNEL_SLASH_COMMANDS.some((c) => c.trigger === trigger)) return null;
    return { trigger, args: (m[2] ?? "").trim() };
  });
  // Only treat an @name as "mine" when this message actually mentions my userId,
  // so a coincidental same-name mention of someone else isn't highlighted.
  const selfMentionNames = $derived(
    authState.user && message.mentions?.includes(authState.user.id)
      ? ([authState.user.name, authState.user.email?.split("@")[0]].filter(Boolean) as string[])
      : [],
  );
  // Mention metadata for render: tooltips + human/agent distinction. Cybos are
  // the @agent roster; workspace members are humans (treated as participants).
  const mentionLookup = $derived.by(() => {
    const map = new Map<string, MentionMeta>();
    for (const m of workspaceState.members) {
      const label = (m.name ?? m.email.split("@")[0]).toLowerCase();
      map.set(label, { type: "human", isParticipant: true });
    }
    for (const c of cyboState.list) {
      map.set(c.name.toLowerCase(), { type: "agent", role: c.role ?? undefined, isParticipant: true });
    }
    return map;
  });
  // Whether this message is mine — gates the unfurl dismiss affordance (only the
  // author can remove their own link previews).
  const isOwn = $derived(!!authState.user && message.fromId === authState.user.id);
  // Per-message send status (optimistic lifecycle). Only my OWN still-optimistic
  // rows carry it; a reconciled "sent" marker auto-clears once the row settles, so
  // the steady state shows nothing. "failed" exposes a Retry affordance.
  const sendStatus = $derived(isOwn ? message.sendStatus : undefined);
  // Retry handler for a failed send: the DM surface injects retrySendDmMessage;
  // everywhere else (channels) falls back to the channel retry.
  const retry = $derived(onRetry ?? retrySendMessage);
  // Locally-dismissed unfurl URLs (hide-only, no relay round-trip). A SvelteSet
  // so re-adding to it re-renders. Keyed by URL since unfurls have no own id.
  const dismissedUnfurls = new SvelteSet<string>();
  // Visible unfurls = first 3, minus any locally dismissed (compact/Slack-like).
  const visibleUnfurls = $derived(
    (message.unfurls ?? []).slice(0, 3).filter((u) => !dismissedUnfurls.has(u.url)),
  );
  // Structured cards (from a GitHub webhook). When present we render the rich card
  // instead of the plain text fallback. `release` has its own renderer; every other
  // event (PR/issue/push/CI/deploy) goes through the generic EventCard.
  const releaseCard = $derived(message.card?.kind === "release" ? message.card : null);
  // Approval cards (#600, kind "approval") are interactive and rendered by their
  // own component (PR2) — exclude them here so this stays a GitHub event card.
  const eventCard = $derived(
    message.card && message.card.kind !== "release" && message.card.kind !== "approval"
      ? message.card
      : null,
  );
  // A webhook-sourced post (GitHub release, CI ping, …). Badged + given a bot/repo
  // avatar so it never shows the token owner's face.
  const isWebhook = $derived(message.source === "webhook");

  // ─── Inline edit (P5 polish; replaces window.prompt) ───
  let editing = $state(false);
  let editText = $state("");

  function startEdit(): void {
    editText = message.text;
    editing = true;
  }
  function cancelEdit(): void {
    editing = false;
  }
  function saveEdit(): void {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== message.text) onEdit?.(message.id, trimmed);
    editing = false;
  }
  function editKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      saveEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  }

  // ─── Mobile long-press → action sheet (V1 MessageBubble parity) ───
  // Start a ~450ms timer on touchstart; cancel if the finger moves >10px
  // (scroll), lifts, or the touch is cancelled before it fires. When it fires:
  // haptic tick + onLongPress(id). `suppressNextClick` swallows the synthetic
  // click iOS dispatches after the press so the long-press doesn't also count
  // as a tap. We DON'T disable text selection globally — only the bubble's
  // native callout/selection is neutralized while a press is in flight.
  const LONG_PRESS_MS = 450;
  const MOVE_TOLERANCE = 10;
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let pressStartX = 0;
  let pressStartY = 0;
  let suppressNextClick = false;

  function clearPressTimer(): void {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  function onTouchStart(e: TouchEvent): void {
    if (!onLongPress || !viewportState.isMobile || editing) return;
    const t = e.touches[0];
    if (!t) return;
    pressStartX = t.clientX;
    pressStartY = t.clientY;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      suppressNextClick = true;
      haptic("light");
      onLongPress?.(message.id);
    }, LONG_PRESS_MS);
  }

  function onTouchMove(e: TouchEvent): void {
    if (!pressTimer) return;
    const t = e.touches[0];
    if (!t) return;
    if (
      Math.abs(t.clientX - pressStartX) > MOVE_TOLERANCE ||
      Math.abs(t.clientY - pressStartY) > MOVE_TOLERANCE
    ) {
      clearPressTimer();
    }
  }

  function onBubbleClickCapture(e: MouseEvent): void {
    if (suppressNextClick) {
      suppressNextClick = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // ─── Mobile long-press → attachment action sheet ───
  // The hover-download overlay and the oncontextmenu menu are BOTH dead on touch
  // (no hover, no right-click), so on iOS "Copy image"/"Save video" were
  // unreachable. Mirror the message-row long-press, scoped per attachment: a
  // ~450ms timer on touchstart, cancel on move/lift, fire → open the sheet for
  // THIS attachment. Mobile-gated (viewportState.isMobile) so desktop keeps its
  // right-click menu untouched. Each attachment gets its own timer/handlers via
  // a small factory so the captured `att` is correct.
  let attachmentSheet = $state<{ url: string; type: string; name: string } | null>(null);
  let attPressTimer: ReturnType<typeof setTimeout> | null = null;
  let attPressStartX = 0;
  let attPressStartY = 0;
  // Swallow the synthetic click iOS dispatches after a long-press so it doesn't
  // also open the image preview / start video playback.
  let suppressNextAttClick = false;

  function clearAttPressTimer(): void {
    if (attPressTimer) {
      clearTimeout(attPressTimer);
      attPressTimer = null;
    }
  }

  function onAttTouchStart(att: { url: string; type: string; name: string }, e: TouchEvent): void {
    if (!viewportState.isMobile) return;
    // Reset the suppress flag at the START of every gesture. The synthetic click
    // iOS fires after a long-press can land on the action-sheet backdrop (which
    // mounts over the whole viewport) instead of the attachment, so
    // onAttClickCapture never runs and the flag would otherwise stay stuck true
    // — swallowing the user's NEXT genuine tap. Clearing here guarantees each
    // new press starts clean.
    suppressNextAttClick = false;
    const t = e.touches[0];
    if (!t) return;
    // The attachment wrappers sit INSIDE the message body div, which has its own
    // long-press → message action sheet. Without this, one press on an image
    // would arm BOTH timers and open both sheets. stopPropagation keeps the
    // attachment press from also triggering the message-row handler.
    e.stopPropagation();
    attPressStartX = t.clientX;
    attPressStartY = t.clientY;
    clearAttPressTimer();
    attPressTimer = setTimeout(() => {
      attPressTimer = null;
      suppressNextAttClick = true;
      haptic("light");
      attachmentSheet = { url: att.url, type: att.type, name: att.name };
    }, LONG_PRESS_MS);
  }

  function onAttTouchMove(e: TouchEvent): void {
    if (!attPressTimer) return;
    const t = e.touches[0];
    if (!t) return;
    if (
      Math.abs(t.clientX - attPressStartX) > MOVE_TOLERANCE ||
      Math.abs(t.clientY - attPressStartY) > MOVE_TOLERANCE
    ) {
      clearAttPressTimer();
    }
  }

  function onAttClickCapture(e: MouseEvent): void {
    if (suppressNextAttClick) {
      suppressNextAttClick = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // Edit-request bridge: when the parent's action sheet asks to edit THIS
  // message (id match), open the inline editor. Keyed by a nonce so repeated
  // edit requests for the same id re-trigger.
  let lastEditNonce = 0;
  $effect(() => {
    const nonce = editRequestNonce;
    if (nonce !== lastEditNonce && editRequestId === message.id && !message.deleted) {
      lastEditNonce = nonce;
      startEdit();
    } else if (nonce !== lastEditNonce) {
      lastEditNonce = nonce;
    }
  });

  // Download/save an attachment. On the iOS Tauri shell the web blob/`<a download>`
  // path is a no-op inside the WKWebView (no Downloads, no Photos/Files bridge),
  // so route by MIME type to the native plugin: images → Photos, videos → Photos,
  // everything else → the document-export sheet. Web/desktop keep the blob
  // download. `att` carries the cross-origin S3/CloudFront `url` + `name`.
  const onIos = isTauriIOS();
  function downloadAttachment(att: { url: string; type: string; name: string }): void {
    if (onIos) {
      if (att.type.startsWith("image/")) {
        void saveImageToPhotos(att.url);
      } else if (att.type.startsWith("video/")) {
        void saveVideoToPhotos(att.url);
      } else {
        void saveFile(att.url, att.name);
      }
      return;
    }
    void downloadFile(att.url, att.name);
  }
  const timeStr = $derived(formatTime(message.createdAt));
  // Full-date tooltip on hover (v1 MessageItem) — e.g. "Mon, Jun 2, 2026 3:04 PM".
  const fullDateStr = $derived(
    new Date(message.createdAt).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
  );

  // Click the sender's name/avatar → open their profile panel (humans + agents).
  // An explicit onClickName override (mention-navigation path) still wins.
  function handleNameClick(): void {
    if (onClickName) {
      onClickName(displayName, isAgent ? message.fromId : null);
      return;
    }
    if (message.fromType === "system") return;
    // Carry the daemon that produced a slash result so its profile sheet can show
    // which daemon ran it.
    profilePanelState.open(isAgent ? "agent" : "human", message.fromId, message.daemonId);
  }

  // Reaction tooltip: resolve a reactor display name → avatar image by matching
  // against the workspace member roster (case-insensitive on name, then on the
  // email local-part). Falls back to initials in the Avatar component when there
  // is no image / no match. Names aren't unique keys, but the roster is small and
  // this is a cosmetic hover affordance.
  const memberImageByName = $derived.by(() => {
    const map = new Map<string, string | null>();
    for (const m of workspaceState.members) {
      const img = m.image ?? m.imageUrl ?? authState.getMemberImage(m.userId);
      if (m.name) map.set(m.name.toLowerCase(), img ?? null);
      const local = m.email?.split("@")[0];
      if (local && !map.has(local.toLowerCase())) map.set(local.toLowerCase(), img ?? null);
    }
    return map;
  });
  function reactorImage(name: string): string | null {
    return memberImageByName.get(name.toLowerCase()) ?? null;
  }

  // Image preview (replaces opening a new tab) — keeps the hover download overlay.
  // On mobile, ImageViewerModal is used (full-screen Photos-grade viewer);
  // on desktop, ImagePreviewModal is used (lightbox). Both accept the same shape.
  let previewImage = $state<{ url: string; name?: string; blurhash?: string | null; thumbnails?: { w360?: string; w720?: string; w1080?: string } } | null>(null);
  // Right-click "Copy image / Copy link / Download" menu for an attachment.
  // Positioned at the cursor; closes itself on outside-click / Esc / scroll.
  let attachmentMenu = $state<{ url: string; type: string; name: string; x: number; y: number } | null>(null);
  // Personal save (#609): offer it on any persisted, non-deleted, non-system
  // message — saving works on other people's messages too. Excludes optimistic
  // sends (sendStatus set = not yet persisted server-side, so it has no stable id
  // to bookmark) and system messages. readOnly surfaces (e.g. Pinned/Saved panes)
  // pass showHoverToolbar={false}, so the in-row bar never shows there anyway.
  const canSave = $derived(
    !message.deleted &&
      message.fromType !== "system" &&
      !message.sendStatus &&
      !!workspaceState.current,
  );
  const isSaved = $derived(savedState.isSaved(message.id));
  const hasActions = $derived(!message.deleted && (onReaction || onEdit || onDelete || canSave));
  let hovered = $state(false);
  // Keep the action bar visible while its popover (more-menu / emoji picker) is
  // open, even if the pointer leaves the row — fixes the unreachable delete when
  // the menu opens above the row.
  let menuOpen = $state(false);

  // ── Swipe-to-reply (#523): short rightward drag on a mobile message row opens
  // the thread (reply), with a spring snap-back. Touch-only + reduced-motion-safe
  // (the gesture is simply off under reduced motion; tap / long-press unchanged).
  // `openThread` is the reply target, so it's disabled when there's no thread to
  // open (hideThread / readOnly) or while editing inline. ──
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let swipeProgress = $state(0);
  const swipeEnabled = $derived(
    viewportState.isMobile && !prefersReducedMotion && !hideThread && !readOnly && !editing,
  );
</script>

<!-- Per-message send status: clock (pending) → check (sent, briefly) → alert +
     Retry (failed). Own optimistic messages only; absent on settled rows. -->
{#snippet sendStatusIndicator()}
  {#if sendStatus === "pending"}
    <span class="inline-flex items-center text-content-muted" title="Sending…" aria-label="Sending">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
      </svg>
    </span>
  {:else if sendStatus === "sent"}
    <span class="inline-flex items-center text-online" title="Sent" aria-label="Sent">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 6L9 17l-5-5" />
      </svg>
    </span>
  {:else if sendStatus === "failed"}
    <button
      type="button"
      onclick={() => retry(message.id)}
      class="inline-flex items-center gap-1 rounded text-error hover:underline cursor-pointer"
      title="Failed to send — click to retry"
      aria-label="Failed to send, retry"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span class="text-[11px] font-medium">Retry</span>
    </button>
  {/if}
{/snippet}

<!-- Hover reveals the action bar — a pointer-only progressive enhancement (the
     same actions are reachable from the message menu), so no keyboard handler. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  data-msg-id={message.id}
  use:swipeToReply={{
    enabled: swipeEnabled,
    onReply: () => openThread(message),
    onProgress: (r) => (swipeProgress = r),
  }}
  onmouseenter={() => {
    // On mobile a touch emulates mouseenter — never show the desktop hover
    // toolbar / hover background there; the long-press action sheet is the
    // mobile path. Keeps taps clean (no toolbar/bg flash on touch).
    if (!viewportState.isMobile) hovered = true;
  }}
  onmouseleave={() => (hovered = false)}
  class={cn(
    // P4a visual pass: 2px inside a group (py-[1px] × adjacent rows), 14px
    // between groups (mt-[12px] + 1px + 1px). px-4 gutters on mobile, px-5 on
    // desktop (negative margin keeps the hover bg full-bleed in the list).
    "relative flex items-start gap-3 rounded transition-colors py-[1px]",
    // Embedded: the host card owns the surface + insets, so drop the row's own
    // horizontal padding / full-bleed margin, its hover tint, and the inter-group
    // top margin — otherwise it paints a second, mismatched box inside the card.
    embedded ? "" : viewportState.isMobile ? "px-4 -mx-4" : "px-5 -mx-5",
    hovered && !embedded && "bg-surface-alt",
    !embedded && (grouped ? "" : "mt-[12px]"),
    // MESSAGE-RENDER P0: pinned-row tint — left-border accent + faint bg on the
    // whole row so pinned messages stay visible even when grouped (the "Pinned"
    // label only shows on the first message of a group). Matches v1 MessageItem.
    message.pinnedAt && "border-l-2 border-warning/70 bg-warning/[0.04]",
    className,
  )}
>
  {#if swipeEnabled}
    <!-- Swipe-to-reply affordance (#523): sits in the left gutter (off-screen at
         rest via -ml-7), emerges + fades in as the row is pulled right; the row
         translation is handled by the swipeToReply action. Decorative — the same
         reply action is reachable via the long-press menu. -->
    <div
      class="pointer-events-none absolute left-0 top-1/2 z-0 -ml-7 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-accent/15 text-accent"
      style="opacity: {swipeProgress}; scale: {0.6 + swipeProgress * 0.4};"
      aria-hidden="true"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 17 4 12 9 7" />
        <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
      </svg>
    </div>
  {/if}
  {#if (hovered || menuOpen) && showHoverToolbar && hasActions}
    <div class="absolute -top-3 right-2 z-10 flex items-center rounded-md border border-edge bg-surface-alt shadow-lg">
      <MessageActionBar
        {message}
        {onReaction}
        {onEdit}
        onStartEdit={startEdit}
        {onDelete}
        onPin={() => pinMessage(message.id, !message.pinnedAt)}
        onSave={canSave ? () => saveMessage(message, !isSaved) : undefined}
        saved={isSaved}
        onMenuOpenChange={(o) => (menuOpen = o)}
        onReplyInThread={hideThread ? undefined : () => openThread(message)}
      />
    </div>
  {:else if hovered && showHoverToolbar && hoverActions}
    <div class="absolute -top-3 right-2 z-10 flex items-center rounded-md border border-edge bg-surface-alt shadow-lg">
      {@render hoverActions()}
    </div>
  {/if}

  <!-- Avatar or spacer -->
  {#if grouped}
    <div class="shrink-0 flex items-start justify-center pt-0.5" style:width="{avatarWidth}px">
      <span
        class={["whitespace-nowrap text-[11px] text-content-muted transition-opacity", hovered ? "opacity-100" : "opacity-0"]}
        title={fullDateStr}
      >
        {timeStr}
      </span>
    </div>
  {:else if showAvatar}
    <button
      type="button"
      class="shrink-0 cursor-pointer mt-0.5 p-0 border-0 bg-transparent"
      onclick={handleNameClick}
    >
      <AuthorAvatar {message} width={avatarWidth} fontSize={avatarFontSize} />
    </button>
  {:else}
    <div style:width="{avatarWidth}px" class="shrink-0"></div>
  {/if}

  <!-- Body -->
  <!-- MOBILE long-press gesture lives here so it covers the message text but
       not the avatar/name buttons. While a press is in flight we neutralize
       iOS's native text-selection/callout on THIS row only (not globally) so
       the long-press isn't hijacked by the selection magnifier. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="flex-1 min-w-0"
    ontouchstart={onTouchStart}
    ontouchmove={onTouchMove}
    ontouchend={clearPressTimer}
    ontouchcancel={clearPressTimer}
    onclickcapture={onBubbleClickCapture}
    style={viewportState.isMobile && !editing
      ? "-webkit-touch-callout: none; -webkit-user-select: none; user-select: none;"
      : undefined}
  >
    {#if !grouped}
      <div class="flex items-baseline gap-2">
        <!-- P4a: token-based color (text-white was invisible on the light theme)
             + semibold per the redesign type ramp (16/15/13/11). -->
        <button
          type="button"
          class="text-[15px] font-semibold text-content hover:underline cursor-pointer p-0 border-0 bg-transparent"
          onclick={handleNameClick}
        >
          {displayName}
        </button>

        {#if statusEmoji}
          <span class="inline-flex items-center leading-none cursor-default" title={statusTooltip || statusEmoji}>
            <Emoji emoji={statusEmoji} size={14} />
          </span>
        {/if}

        {#if isAgent && showRoleBadge}
          <span class="role-badge">Agent</span>
        {/if}

        {#if message.source === "mcp"}
          <!-- Automation marker: posted via the MCP write tools, not typed by hand. -->
          <span class="role-badge" title="Posted via MCP automation">mcp</span>
        {/if}

        {#if isWebhook}
          <!-- Automation marker: posted via an inbound webhook (CI, GitHub, …). -->
          <span class="role-badge" title="Posted via an inbound webhook">webhook</span>
        {/if}

        {#if !isAgent && isExternalSlack(message.fromId)}
          <!-- External marker: this author is a mirrored Slack guest user. -->
          <span class="role-badge" title="From a Slack workspace">Slack</span>
        {/if}

        <!-- P4a: 11px timestamp per the redesign type ramp. -->
        <span class="text-[11px] text-content-muted ml-1 cursor-default" title={fullDateStr}>{timeStr}</span>

        {#if message.updatedAt && message.createdAt && message.updatedAt - message.createdAt > 2000 && !message.deleted}
          <span class="text-[11px] text-content-dim">(edited)</span>
        {/if}

        {#if sendStatus}
          {@render sendStatusIndicator()}
        {/if}
      </div>
    {/if}

    {#if message.pinnedAt}
      <div class="mb-0.5 flex items-center gap-1 text-[11px] font-medium text-warning">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M16 3v2l-1 1v5l3 3v2h-5v6h-2v-6H6v-2l3-3V6L8 5V3z" /></svg>
        Pinned
      </div>
    {/if}

    {#if message.deleted}
      <div class="text-[14px] mt-0.5 italic text-content-muted">(message deleted)</div>
    {:else if editing}
      <div class="mt-0.5">
        <!-- svelte-ignore a11y_autofocus -->
        <textarea
          bind:value={editText}
          onkeydown={editKeydown}
          autofocus
          rows="2"
          class="w-full resize-none rounded-md border border-edge bg-transparent px-2 py-1.5 text-[15px] text-content outline-none focus:border-content-dim"
        ></textarea>
        <div class="mt-1 flex items-center gap-2 text-[11px] text-content-muted">
          <button type="button" class="text-link hover:underline" onclick={saveEdit}>Save</button>
          <button type="button" class="hover:text-content" onclick={cancelEdit}>Cancel</button>
          <span>· escape to cancel · enter to save</span>
        </div>
      </div>
    {:else if slashCommand}
      <div class="mt-0.5 inline-flex max-w-full items-start gap-1.5 rounded-md border border-edge bg-surface-alt px-2 py-1 text-[13px]">
        <svg class="mt-0.5 h-3.5 w-3.5 shrink-0 text-content-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
        </svg>
        <span class="font-mono font-semibold text-content">/{slashCommand.trigger}</span>
        {#if slashCommand.args}
          <span class="whitespace-pre-wrap break-words font-mono text-content-muted">{slashCommand.args}</span>
        {/if}
      </div>
    {:else if releaseCard}
      <!-- Rich GitHub release card — replaces the plain-text fallback. -->
      <ReleaseCard card={releaseCard} {mentionLookup} />
    {:else if eventCard}
      <!-- Generic GitHub event card (PR/issue/push/CI/deploy). -->
      <EventCard card={eventCard} {mentionLookup} />
    {:else if message.text}
      <!-- P4a: 16px body on mobile (Slack iOS parity), 15px on desktop; 1.45
           line-height on both. Presentation only — MessageRenderer untouched. -->
      <div class={cn("mt-0.5 leading-[1.45]", viewportState.isMobile ? "text-[16px]" : "text-[15px]")}>
        <MessageRenderer
          text={message.text}
          selfNames={selfMentionNames}
          {mentionLookup}
          {onMentionClick}
          {onChannelClick}
        />
      </div>
    {/if}

    <!-- Grouped rows have no header line, so surface the send status inline below
         the body (the non-grouped header already shows it). -->
    {#if grouped && sendStatus && !message.deleted}
      <div class="mt-0.5 flex items-center">
        {@render sendStatusIndicator()}
      </div>
    {/if}

    {#if message.attachments && message.attachments.length > 0}
      <div class="mt-1.5 flex flex-col gap-1.5">
        {#each message.attachments as att (att.key)}
          {#if att.type.startsWith("image/")}
            <!-- group/img scopes the hover affordances to the image, not the row -->
            <!-- Right-click → Slack-style Copy image / Copy link / Download menu
                 at the cursor. ADDED alongside the zoom click + hover overlay. -->
            <div
              class="group/img relative inline-block w-fit"
              oncontextmenu={(e) => {
                e.preventDefault();
                // Stop the opening right-click from bubbling to the menu's own
                // window-level contextmenu/mousedown dismiss handler, which would
                // otherwise close it in the same tick (menu never appears).
                e.stopPropagation();
                attachmentMenu = { url: att.url, type: att.type, name: att.name, x: e.clientX, y: e.clientY };
              }}
              ontouchstart={(e) => onAttTouchStart(att, e)}
              ontouchmove={onAttTouchMove}
              ontouchend={clearAttPressTimer}
              ontouchcancel={clearAttPressTimer}
              onclickcapture={onAttClickCapture}
              role="presentation"
            >
              <button
                type="button"
                class="block w-fit cursor-zoom-in border-0 bg-transparent p-0"
                onclick={() => (previewImage = { url: att.url, name: att.name, blurhash: att.blurhash ?? null, thumbnails: att.thumbnails })}
                title="Preview"
                aria-label={`Preview ${att.name}`}
              >
                <BlurHashImage
                  src={att.url}
                  alt={att.name}
                  width={att.width ?? 0}
                  height={att.height ?? 0}
                  blurhash={att.blurhash}
                  thumbnails={att.thumbnails}
                />
              </button>
              <!-- Hover download overlay (Slack-parity, v1 ImageDownloadOverlay).
                   stopPropagation so the click doesn't open the preview modal.
                   On iOS → native Save to Photos (downloadAttachment); web/desktop
                   blob the cross-origin URL so it saves, not navigates. -->
              <!-- Hover overlay is desktop-only: on touch there's no hover, so it
                   would be permanently invisible (dead). Mobile reaches Save via
                   long-press → AttachmentActionSheet instead. `hidden sm:block`
                   matches viewportState.isMobile (≤639px). text-white (was
                   text-accent-foreground, which is dark on the black pill). -->
              <button
                type="button"
                onclick={(e) => {
                  e.stopPropagation();
                  downloadAttachment(att);
                }}
                class="absolute top-2 right-2 hidden rounded-md bg-black/70 p-1.5 text-white opacity-0 transition-opacity hover:bg-black/85 group-hover/img:opacity-100 sm:block"
                title={`Download ${att.name}`}
                aria-label={`Download ${att.name}`}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M8 2v9M4 7l4 4 4-4M3 14h10"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <span class="sr-only">Download</span>
              </button>
            </div>
          {:else if att.type.startsWith("video/")}
            <!-- group/vid scopes the hover save affordance to the player. Right-click
                 opens the same Copy link / Download menu as images (Download routes
                 to saveVideoToPhotos on iOS, blob download on web). -->
            <div
              class="group/vid relative w-fit"
              oncontextmenu={(e) => {
                e.preventDefault();
                // Stop the opening right-click from bubbling to the menu's own
                // window-level contextmenu/mousedown dismiss handler, which would
                // otherwise close it in the same tick (menu never appears).
                e.stopPropagation();
                attachmentMenu = { url: att.url, type: att.type, name: att.name, x: e.clientX, y: e.clientY };
              }}
              ontouchstart={(e) => onAttTouchStart(att, e)}
              ontouchmove={onAttTouchMove}
              ontouchend={clearAttPressTimer}
              ontouchcancel={clearAttPressTimer}
              onclickcapture={onAttClickCapture}
              role="presentation"
            >
              <VideoPlayer {att} />
              <!-- Hover save overlay — mirrors the image one. stopPropagation so the
                   tap doesn't start playback; downloadAttachment routes video → Photos
                   on iOS, blob download on web/desktop. -->
              <!-- Hover overlay is desktop-only (no hover on touch). Mobile uses
                   long-press → AttachmentActionSheet for Save video. `hidden
                   sm:block` matches viewportState.isMobile. text-white (was
                   text-accent-foreground, dark on the black pill). -->
              <button
                type="button"
                onclick={(e) => {
                  e.stopPropagation();
                  downloadAttachment(att);
                }}
                class="absolute top-2 right-2 z-10 hidden rounded-md bg-black/70 p-1.5 text-white opacity-0 transition-opacity hover:bg-black/85 group-hover/vid:opacity-100 sm:block"
                title={onIos ? `Save ${att.name} to Photos` : `Download ${att.name}`}
                aria-label={onIos ? `Save ${att.name} to Photos` : `Download ${att.name}`}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M8 2v9M4 7l4 4 4-4M3 14h10"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <span class="sr-only">{onIos ? "Save to Photos" : "Download"}</span>
              </button>
            </div>
          {:else if att.type.startsWith("audio/")}
            <VoicePlayer src={att.url} type={att.type} />
          {:else}
            <!-- Generic file card: icon + name + size. Clicking the card itself
                 does NOT download — download is opt-in via the explicit button on
                 the right (and the right-click menu). Cross-origin `download` is
                 ignored by browsers, so downloadAttachment blobs the file (web) /
                 routes to the native export sheet (iOS) instead of navigating. -->
            <div
              class="group/file inline-flex w-fit items-center gap-2 rounded-lg border border-edge bg-raised px-3 py-2 text-left text-[13px] text-content"
              oncontextmenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                attachmentMenu = { url: att.url, type: att.type, name: att.name, x: e.clientX, y: e.clientY };
              }}
              ontouchstart={(e) => onAttTouchStart(att, e)}
              ontouchmove={onAttTouchMove}
              ontouchend={clearAttPressTimer}
              ontouchcancel={clearAttPressTimer}
              onclickcapture={onAttClickCapture}
              role="presentation"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-content-dim">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
              </svg>
              <span class="flex min-w-0 flex-col">
                <span class="max-w-[220px] truncate font-medium">{att.name}</span>
                <span class="text-[11px] text-content-muted">{formatSize(att.size)}</span>
              </span>
              <!-- 44pt touch-target + .pressable :active feedback (coarse pointers)
                   so the always-visible download button is reliably tappable on
                   touch; desktop keeps its hover color + compact density. -->
              <button
                type="button"
                onclick={() => downloadAttachment(att)}
                class="touch-target pressable ml-1 flex shrink-0 items-center justify-center rounded-md p-1.5 text-content-dim transition-colors hover:bg-[var(--dropdown-hover)] hover:text-content"
                title={onIos ? `Save ${att.name}` : `Download ${att.name}`}
                aria-label={onIos ? `Save ${att.name}` : `Download ${att.name}`}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 2v9M4 7l4 4 4-4M3 14h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </div>
          {/if}
        {/each}
      </div>
    {/if}

    {#if !message.deleted && visibleUnfurls.length > 0}
      <!-- URL unfurls / link previews (Tier 2). Capped at 3, Slack-like. The
           author can dismiss their own (local hide only — no relay clear). -->
      <div class="flex flex-col">
        {#each visibleUnfurls as uf (uf.url)}
          <LinkPreview unfurl={uf} canDismiss={isOwn} onDismiss={() => dismissedUnfurls.add(uf.url)} />
        {/each}
      </div>
    {/if}

    {#if !hideThread && (message.replyCount ?? 0) > 0}
      <!-- MESSAGE-RENDER P0: rich thread indicator — stacked participant avatars,
           reply count, "Last reply HH:MM" (swaps to "View thread" on hover).
           Matches v1 MessageItem.tsx. -->
      <!-- P4a restyle: compact 13px accent text row ("N replies →"), 44pt touch
           target on mobile via touch-target-row. Same data (participant avatar
           stack at 20px, last-reply time, hover swap) and same openThread wiring. -->
      <button
        type="button"
        onclick={() => openThread(message)}
        class="group/thread touch-target-row mt-1 flex w-full max-w-[50%] cursor-pointer items-center gap-1.5 rounded-lg border border-transparent px-2 py-1 -ml-2 text-[13px] text-accent transition-colors hover:border-edge hover:bg-raised focus:outline-none"
      >
        {#if message.threadParticipants && message.threadParticipants.length > 0}
          <div class="flex items-center -space-x-1">
            {#each message.threadParticipants.slice(0, 3) as p, i (p.name + i)}
              <Avatar name={p.name} width={20} fontSize={9} image={p.image} />
            {/each}
          </div>
        {:else}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-content-muted"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
        {/if}
        <span class="whitespace-nowrap font-medium group-hover/thread:underline">
          {message.replyCount}
          {message.replyCount === 1 ? "reply" : "replies"}
        </span>
        {#if message.lastReplyAt}
          <span class="whitespace-nowrap text-[11px] text-content-muted group-hover/thread:hidden">
            · {formatTime(message.lastReplyAt)}
          </span>
        {/if}
        <span class="hidden text-[11px] text-content-muted group-hover/thread:inline">View thread</span>
        <svg
          class={cn(
            "ml-auto h-3 w-3",
            viewportState.isMobile ? "block" : "hidden text-content-muted group-hover/thread:block",
          )}
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M5.7 13.7l5-5a1 1 0 000-1.4l-5-5a1 1 0 00-1.4 1.4L8.58 8l-4.3 4.3a1 1 0 001.42 1.4z" />
        </svg>
      </button>
    {/if}

    {#if message.reactions && message.reactions.length > 0}
      <!-- P4a chip restyle: 13px on a ≥28px-tall rounded-full chip, surface bg
           with a hairline-colored border; own reaction = accent tint + accent
           text; tabular count. Toggle wiring (onReaction) unchanged. -->
      <div class="flex flex-wrap gap-[4px] mt-1">
        {#each message.reactions as reaction}
          <div class="group/reaction relative">
            <button
              type="button"
              disabled={readOnly}
              onclick={() => onReaction?.(message.id, reaction.emoji)}
              class={cn(
                // P4a chip sizing/idiom (28px tall, 13px, accent-tinted own
                // reaction) merged with the channel-preview readOnly behavior:
                // in preview the chip is a static pill — no pointer cursor, no
                // press scale, no hover affordance.
                "inline-flex min-h-[28px] select-none items-center gap-1.5 rounded-full border px-[10px] text-[13px] font-medium transition-transform transition-colors",
                readOnly
                  ? "cursor-default"
                  : "cursor-pointer active:scale-110",
                reaction.reacted
                  ? "border-accent/40 bg-accent/15 text-accent"
                  : readOnly
                    ? "border-[color:var(--hairline)] bg-surface-alt text-content-dim"
                    : "border-[color:var(--hairline)] bg-surface-alt text-content-dim hover:border-content-muted hover:text-content",
              )}
            >
              <Emoji emoji={reaction.emoji} size={16} />
              <span class="tabular-nums">{reaction.count}</span>
            </button>
            <!-- MESSAGE-RENDER P0+: styled reactor popover (replaces native title).
                 An avatar row (images / initials) + reactor names, with "+N more"
                 past the first ~10. Names map to member avatars via the roster. -->
            {#if reaction.reactorNames && reaction.reactorNames.length > 0}
              {@const names = reaction.reactorNames}
              {@const shown = names.slice(0, 10)}
              {@const extra = names.length - shown.length}
              <div
                class="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 w-max max-w-[240px] -translate-x-1/2 rounded-lg border border-edge bg-surface-alt p-2 opacity-0 shadow-xl transition-opacity group-hover/reaction:opacity-100"
                role="tooltip"
              >
                <div class="flex items-center gap-2">
                  <span class="shrink-0"><Emoji emoji={reaction.emoji} size={18} /></span>
                  <div class="flex items-center -space-x-1.5">
                    {#each shown.slice(0, 6) as rn (rn)}
                      <span class="rounded-full ring-2 ring-surface-alt">
                        <Avatar name={rn} width={20} fontSize={9} image={reactorImage(rn)} />
                      </span>
                    {/each}
                    {#if shown.length > 6}
                      <span class="flex h-5 w-5 items-center justify-center rounded-full bg-raised text-[9px] font-semibold text-content-dim ring-2 ring-surface-alt">
                        +{shown.length - 6}
                      </span>
                    {/if}
                  </div>
                </div>
                <div class="mt-1.5 whitespace-normal break-words text-left text-[11px] leading-snug text-content">
                  <span class="font-semibold">{shown.join(", ")}</span>{#if extra > 0}<span class="text-content-dim"> and {extra} more</span>{/if}
                  <span class="text-content-dim"> reacted</span>
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

{#if viewportState.isMobile}
  <ImageViewerModal image={previewImage} onClose={() => (previewImage = null)} />
{:else}
  <ImagePreviewModal image={previewImage} onClose={() => (previewImage = null)} />
{/if}

{#if attachmentMenu}
  <AttachmentContextMenu
    url={attachmentMenu.url}
    type={attachmentMenu.type}
    name={attachmentMenu.name}
    x={attachmentMenu.x}
    y={attachmentMenu.y}
    onClose={() => (attachmentMenu = null)}
  />
{/if}

<!-- Mobile-only: long-press an attachment opens this bottom sheet (the touch
     path for Copy image / Save video / Copy link, all unreachable via the
     hover overlay / right-click menu on iOS). Opened by onAttTouchStart. -->
{#if attachmentSheet}
  <AttachmentActionSheet
    url={attachmentSheet.url}
    type={attachmentSheet.type}
    name={attachmentSheet.name}
    onClose={() => (attachmentSheet = null)}
  />
{/if}
