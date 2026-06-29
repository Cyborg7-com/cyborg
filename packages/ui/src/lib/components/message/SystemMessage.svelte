<script lang="ts">
  // Richer system-message rendering. System messages (join/leave/role changes,
  // channel created/archived, daemon offline, AI not configured, etc.) used to
  // render as a single line of dim centered text. This component keeps that as
  // the fallback but, when it can classify the event, renders an icon + styled
  // pill so channel events read at a glance — Mattermost system_message_helpers
  // parity. Classification is heuristic (on alertType first, then text keywords)
  // so it degrades gracefully for messages it doesn't recognize.
  import type { Message } from "$lib/types.js";
  import { Button } from "$lib/components/ui/button/index.js";

  let {
    message,
    onAiSettings,
  }: {
    message: Message;
    // CTA for the "no AI configured" alert → workspace AI settings.
    onAiSettings?: () => void;
  } = $props();

  // Multi-line system notes (e.g. the /status report) render as a left-aligned,
  // non-truncating block instead of the single-line pill below — the pill's
  // `truncate` (white-space: nowrap) would collapse a multi-row report to one
  // ellipsized line. Gated on a newline so every existing single-line system
  // message keeps the pill treatment unchanged.
  const isMultiline = $derived((message.text ?? "").includes("\n"));

  type SystemKind =
    | "join"
    | "leave"
    | "role"
    | "channel"
    | "archived"
    | "offline"
    | "error"
    | "pinned"
    | "info";

  // Classify the event. alertType is authoritative when present; otherwise infer
  // from the text. Unknown → "info" (neutral icon, same dim treatment as before).
  const kind = $derived.by<SystemKind>(() => {
    if (message.alertType === "no_daemon_configured") return "error";
    if (message.alertType === "slash_daemons_offline") return "offline";
    const t = (message.text ?? "").toLowerCase();
    if (/\b(joined|added|invited|welcome)\b/.test(t)) return "join";
    if (/\b(left|removed|kicked)\b/.test(t)) return "leave";
    if (/\b(role|admin|promoted|demoted|now an?)\b/.test(t)) return "role";
    if (/\barchived\b/.test(t)) return "archived";
    if (/\b(offline|disconnected|unavailable|down)\b/.test(t)) return "offline";
    if (/\b(created|renamed|set the topic|description)\b/.test(t)) return "channel";
    if (/\b(pinned|unpinned)\b/.test(t)) return "pinned";
    if (/\b(error|failed|couldn't|cannot)\b/.test(t)) return "error";
    return "info";
  });

  // Per-kind accent color token. Neutral kinds inherit the dim text color, so the
  // visual change for ordinary system lines stays subtle.
  const accent = $derived(
    kind === "join"
      ? "var(--health-ok-text, var(--text-secondary))"
      : kind === "leave" || kind === "archived"
        ? "var(--text-muted, var(--text-secondary))"
        : kind === "role" || kind === "channel" || kind === "pinned"
          ? "var(--color-link)"
          : kind === "offline"
            ? "var(--score-warning, var(--text-secondary))"
            : kind === "error"
              ? "var(--color-error, var(--text-secondary))"
              : "var(--text-secondary)",
  );
</script>

{#if isMultiline}
  <!-- Multi-line system note (e.g. /status): a readable, non-truncating block. -->
  <div class="flex justify-center px-5 py-1.5">
    <div
      class="max-w-full overflow-hidden whitespace-pre-wrap break-words rounded-md border border-edge bg-surface-alt px-3 py-2 text-[12px] leading-relaxed text-content-muted"
    >{message.text}</div>
  </div>
{:else}
<div class="flex flex-col items-center justify-center gap-1.5 px-5 py-1.5">
  <div
    class="inline-flex max-w-full items-center gap-2 rounded-full border border-edge bg-surface-alt px-3 py-1"
  >
    <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center" style="color: {accent};">
      {#if kind === "join"}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><line x1="19" y1="8" x2="19" y2="14" /><line x1="22" y1="11" x2="16" y2="11" />
        </svg>
      {:else if kind === "leave"}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><line x1="22" y1="11" x2="16" y2="11" />
        </svg>
      {:else if kind === "role"}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 2l2.4 7.4H22l-6 4.6 2.3 7.4-6.3-4.6L5.7 21.4 8 14 2 9.4h7.6z" />
        </svg>
      {:else if kind === "channel"}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="4" y1="9" x2="20" y2="9" /><line x1="4" y1="15" x2="20" y2="15" /><line x1="10" y1="3" x2="8" y2="21" /><line x1="16" y1="3" x2="14" y2="21" />
        </svg>
      {:else if kind === "archived"}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="21 8 21 21 3 21 3 8" /><rect x="1" y="3" width="22" height="5" /><line x1="10" y1="12" x2="14" y2="12" />
        </svg>
      {:else if kind === "offline"}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" /><line x1="4.9" y1="4.9" x2="19.1" y2="19.1" />
        </svg>
      {:else if kind === "error"}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      {:else if kind === "pinned"}
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M16 3v2l-1 1v5l3 3v2h-5v6h-2v-6H6v-2l3-3V6L8 5V3z" />
        </svg>
      {:else}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      {/if}
    </span>
    <span class="truncate text-[12px] text-content-muted">{message.text}</span>
  </div>
  {#if message.alertType === "no_daemon_configured" && onAiSettings}
    <Button variant="outline" size="sm" onclick={onAiSettings}>Configurar AI</Button>
  {/if}
</div>
{/if}
