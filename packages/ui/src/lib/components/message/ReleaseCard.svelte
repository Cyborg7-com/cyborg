<script lang="ts">
  // Rich GitHub release card (Slack/Discord-quality). Rendered in a channel when
  // a GitHub `release` webhook (published/released) arrives. Clones the visual
  // idiom of LinkPreview.svelte's GitHub variant: left accent border, repo header
  // with a 🏷 glyph, a big tag + release name, a "Pre-release" pill, the markdown
  // changelog body clamped with Show more, and an author row + "View release ↗".
  import type { ReleaseCard } from "$lib/core/types.js";
  import type { MentionMeta } from "$lib/render-markdown.js";
  import GitHubIcon from "../GitHubIcon.svelte";
  import MessageRenderer from "./MessageRenderer.svelte";

  let {
    card,
    mentionLookup,
  }: {
    card: ReleaseCard;
    mentionLookup?: Map<string, MentionMeta>;
  } = $props();

  // GitHub's neutral border accent (matches LinkPreview's github case). A literal
  // brand color — there's no design token for third-party brand colors.
  const ACCENT = "#6e7681";

  // The big headline: "v2.4.0 — Spring cleaning" when the release has a distinct
  // name, otherwise just the tag.
  const heading = $derived(card.name && card.name !== card.tag ? `${card.tag}` : card.tag);
  const subheading = $derived(card.name && card.name !== card.tag ? card.name : null);

  // Changelog clamp: collapse long bodies behind a Show more toggle (mirrors the
  // LinkPreview Twitter-body pattern).
  let bodyExpanded = $state(false);
  function bodyShouldClamp(text: string): boolean {
    return text.split("\n").length > 6 || text.length > 400;
  }

  function hideBrokenImage(e: Event): void {
    (e.currentTarget as HTMLImageElement).style.display = "none";
  }

  function publishedLabel(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, { dateStyle: "medium" });
  }
</script>

<div class="group/release relative mt-1.5 max-w-[520px]">
  <div class="flex overflow-hidden rounded-lg border border-edge bg-raised">
    <!-- Left accent border -->
    <div class="w-[3px] shrink-0" style:background-color={ACCENT}></div>

    <div class="min-w-0 flex-1 p-3">
      <!-- Repo header: GitHub brand mark + release emoji tint -->
      <div class="mb-1.5 flex items-center gap-1.5">
        <GitHubIcon size={14} class="text-content" />
        <span class="text-[12px] leading-none" aria-hidden="true">🏷</span>
        <a
          href={card.repoUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="truncate text-[12px] font-medium text-content-muted hover:underline"
        >
          {card.repo}
        </a>
        <span class="text-[12px] text-content-dim">· Release</span>
      </div>

      <!-- Tag + name + pre-release pill -->
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <a
          href={card.url}
          target="_blank"
          rel="noopener noreferrer"
          class="text-[16px] font-semibold break-words text-accent hover:underline"
        >
          {heading}
        </a>
        {#if subheading}
          <span class="text-[14px] font-medium break-words text-content">{subheading}</span>
        {/if}
        {#if card.prerelease}
          <span
            class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
            style:background-color="#9a6700"
            style:color="#fff"
          >
            Pre-release
          </span>
        {/if}
        {#if card.draft}
          <span
            class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
            style:background-color={ACCENT}
            style:color="#fff"
          >
            Draft
          </span>
        {/if}
      </div>

      <!-- Changelog body (markdown), clamped with Show more -->
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

      <!-- Author row + View release link -->
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
        {#if card.publishedAt && publishedLabel(card.publishedAt)}
          <span class="text-content-dim">·</span>
          <span class="whitespace-nowrap">{publishedLabel(card.publishedAt)}</span>
        {/if}
        <a
          href={card.url}
          target="_blank"
          rel="noopener noreferrer"
          class="ml-auto whitespace-nowrap font-medium text-link hover:underline"
        >
          View release ↗
        </a>
      </div>
    </div>
  </div>
</div>
