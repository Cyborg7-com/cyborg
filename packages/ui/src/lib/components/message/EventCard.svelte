<script lang="ts">
  // Generic GitHub event card (pull_request, issues, push, CI, deploy, …) — the
  // sibling of ReleaseCard.svelte. Same Slack/Discord idiom: a left accent border
  // (colored by STATE, matching GitHub's Primer palette), a repo header with an
  // event glyph, a linked title + state pill, an optional markdown body clamped
  // with Show more, a compact metadata-fields row, and an author/timestamp footer.
  import type { CardAccent, EventCard } from "$lib/core/types.js";
  import type { MentionMeta } from "$lib/render-markdown.js";
  import GitHubIcon from "../GitHubIcon.svelte";
  import MessageRenderer from "./MessageRenderer.svelte";

  let {
    card,
    mentionLookup,
  }: {
    card: EventCard;
    mentionLookup?: Map<string, MentionMeta>;
  } = $props();

  // State → color. GitHub's own state colors (Primer) so the card reads "correctly"
  // to anyone who's used GitHub: open/success green, merged purple, closed/failure
  // red, pending yellow, neutral gray. Literal brand colors (no design token for
  // third-party state colors). Unknown keys fall back to neutral gray.
  const ACCENT_COLORS: Record<CardAccent, string> = {
    open: "#1a7f37",
    success: "#1a7f37",
    merged: "#8250df",
    closed: "#cf222e",
    failure: "#cf222e",
    pending: "#9a6700",
    neutral: "#6e7681",
  };
  const accent = $derived(ACCENT_COLORS[card.accent] ?? ACCENT_COLORS.neutral);

  // Slack-style attribution: "{actorAction} by @login" (e.g. "merged by @seb").
  // Only when both the verb and an actor are known — deploy cards (author null)
  // and cards without a verb simply omit it.
  const attribution = $derived(
    card.actorAction && card.author ? `${card.actorAction} by @${card.author.login}` : null,
  );

  let bodyExpanded = $state(false);
  function bodyShouldClamp(text: string): boolean {
    return text.split("\n").length > 6 || text.length > 400;
  }

  function hideBrokenImage(e: Event): void {
    (e.currentTarget as HTMLImageElement).style.display = "none";
  }

  function dateLabel(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, { dateStyle: "medium" });
  }
</script>

<div class="relative mt-1.5 max-w-[520px]">
  <div class="flex overflow-hidden rounded-lg border border-edge bg-raised">
    <!-- Left accent border (state color) -->
    <div class="w-[3px] shrink-0" style:background-color={accent}></div>

    <div class="min-w-0 flex-1 p-3">
      <!-- Repo header: GitHub brand mark + per-event emoji tint -->
      <div class="mb-1.5 flex items-center gap-1.5">
        <GitHubIcon size={14} class="text-content" />
        {#if card.icon}
          <span class="text-[12px] leading-none" aria-hidden="true">{card.icon}</span>
        {/if}
        <a
          href={card.repoUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="truncate text-[12px] font-medium text-content-muted hover:underline"
        >
          {card.repo}
        </a>
        <span class="truncate text-[12px] text-content-dim">· {card.eventLabel}</span>
      </div>

      <!-- Title + state pill -->
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <a
          href={card.url}
          target="_blank"
          rel="noopener noreferrer"
          class="text-[15px] font-semibold break-words text-accent hover:underline"
        >
          {card.title}
        </a>
        {#if card.badge}
          <span
            class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
            style:background-color={accent}
            style:color="#fff"
          >
            {card.badge}
          </span>
        {/if}
      </div>

      <!-- Actor attribution (Slack phrasing): "{verb} by @login" -->
      {#if attribution}
        <div class="mt-0.5 text-[12px] text-content-muted">{attribution}</div>
      {/if}

      <!-- Body (markdown), clamped with Show more -->
      {#if card.body}
        <div class="mt-2 border-t border-edge pt-2 text-[14px] leading-[1.5] text-content">
          <div class={!bodyExpanded && bodyShouldClamp(card.body) ? "line-clamp-6 overflow-hidden" : ""}>
            <MessageRenderer text={card.body} {mentionLookup} />
          </div>
          {#if bodyShouldClamp(card.body)}
            <button
              type="button"
              onclick={() => (bodyExpanded = !bodyExpanded)}
              class="mt-1 block cursor-pointer text-[12px] text-accent hover:underline"
            >
              {bodyExpanded ? "Show less" : "Show more"}
            </button>
          {/if}
        </div>
      {/if}

      <!-- Metadata fields -->
      {#if card.fields.length > 0}
        <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
          {#each card.fields as f (f.label)}
            <span class="min-w-0">
              <span class="text-content-dim">{f.label}:</span>
              {#if f.href}
                <a
                  href={f.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="break-words text-link hover:underline">{f.value}</a>
              {:else}
                <span class="break-words text-content-muted">{f.value}</span>
              {/if}
            </span>
          {/each}
        </div>
      {/if}

      <!-- Author row + View link -->
      <div class="mt-2.5 flex items-center gap-2 border-t border-edge pt-2 text-[12px] text-content-muted">
        {#if card.author}
          <span class="flex min-w-0 items-center gap-1.5">
            {#if card.author.avatarUrl}
              <img
                src={card.author.avatarUrl}
                alt=""
                class="h-4 w-4 shrink-0 rounded-full"
                loading="lazy"
                onerror={hideBrokenImage}
              />
            {/if}
            <span class="truncate">@{card.author.login}</span>
          </span>
        {/if}
        {#if card.timestamp && dateLabel(card.timestamp)}
          <span class="text-content-dim">·</span>
          <span class="whitespace-nowrap">{dateLabel(card.timestamp)}</span>
        {/if}
        <a
          href={card.url}
          target="_blank"
          rel="noopener noreferrer"
          class="ml-auto whitespace-nowrap font-medium text-link hover:underline"
        >
          View ↗
        </a>
      </div>
    </div>
  </div>
</div>
