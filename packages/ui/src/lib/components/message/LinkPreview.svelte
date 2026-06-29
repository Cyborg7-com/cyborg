<script lang="ts">
  // URL unfurl / link-preview card (Tier 2). Svelte 5 port of v1's
  // LinkPreviewCard. Renders platform-specific bodies (Twitter/X, YouTube/Vimeo,
  // GitHub, generic OG) with a left accent border. Compact, Slack-like. Images
  // lazy-load and hide themselves on error.
  import type { Unfurl, UnfurlMedia } from "$lib/types.js";
  import { cn } from "$lib/utils.js";

  let {
    unfurl,
    canDismiss = false,
    onDismiss,
  }: {
    unfurl: Unfurl;
    canDismiss?: boolean;
    onDismiss?: () => void;
  } = $props();

  // Platform accent color for the left border. The generic case uses the brand
  // accent token; platform brand colors have no token, so they stay literal.
  function accentColor(platform?: string): string {
    switch (platform) {
      case "x":
        return "#1da1f2";
      case "youtube":
        return "#ff0000";
      case "vimeo":
        return "#1ab7ea";
      case "github":
        return "#6e7681";
      default:
        return "var(--color-accent)";
    }
  }

  // Hide a broken image (favicon / og:image) in place, mirroring v1's onError.
  function hideBrokenImage(e: Event): void {
    (e.currentTarget as HTMLImageElement).style.display = "none";
  }

  const isDirectImage = $derived(unfurl.type === "image" && !!unfurl.image);

  // Nothing renderable → render nothing (matches v1's null guard).
  const hasRenderable = $derived(
    !!unfurl.title || !!unfurl.description || !!unfurl.image || (unfurl.media?.length ?? 0) > 0,
  );

  const isTwitter = $derived(unfurl.platform === "x");
  const isVideo = $derived(unfurl.platform === "youtube" || unfurl.platform === "vimeo");
  const isGithub = $derived(unfurl.platform === "github");

  // ── Twitter media split ──
  const twitterImages = $derived((unfurl.media ?? []).filter((m) => m.type === "image" || m.type === "gif"));
  const twitterVideos = $derived((unfurl.media ?? []).filter((m) => m.type === "video"));

  // ── Description show-more (Twitter body) ──
  let descExpanded = $state(false);
  function descShouldClamp(text: string): boolean {
    return text.split("\n").length > 6 || text.length > 400;
  }

  function gridImages(images: UnfurlMedia[]): UnfurlMedia[] {
    return images.slice(0, 4);
  }

  // ── GitHub status badge ──
  function statusBadge(state: string, kind?: string): { bg: string; fg: string; label: string } {
    if (state === "open") return { bg: "#238636", fg: "#fff", label: kind === "pr" ? "Open PR" : "Open" };
    if (state === "merged") return { bg: "#8957e5", fg: "#fff", label: "Merged" };
    if (state === "draft") return { bg: "#6e7681", fg: "#fff", label: "Draft" };
    if (state === "closed") return { bg: "#da3633", fg: "#fff", label: "Closed" };
    return { bg: "#6e7681", fg: "#fff", label: state };
  }

  function languageColor(lang: string): string {
    const map: Record<string, string> = {
      TypeScript: "#3178c6",
      JavaScript: "#f1e05a",
      Python: "#3572A5",
      Go: "#00ADD8",
      Rust: "#dea584",
      Java: "#b07219",
      C: "#555",
      "C++": "#f34b7d",
      "C#": "#178600",
      Ruby: "#701516",
      PHP: "#4F5D95",
      Swift: "#F05138",
      Kotlin: "#A97BFF",
      Shell: "#89e051",
      HTML: "#e34c26",
      CSS: "#563d7c",
    };
    return map[lang] ?? "#8b949e";
  }

  function publishedLabel(iso: string): string {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  function handleDismiss(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    onDismiss?.();
  }
</script>

{#snippet header(uf: Unfurl)}
  {#if uf.siteName || uf.favicon}
    <div class="mb-1.5 flex items-center gap-1.5">
      {#if uf.favicon}
        <img src={uf.favicon} alt="" class="h-4 w-4 rounded-sm" loading="lazy" onerror={hideBrokenImage} />
      {/if}
      {#if uf.siteName}
        <span class="text-[12px] font-medium text-content-muted">{uf.siteName}</span>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet dismissButton()}
  {#if canDismiss && onDismiss}
    <button
      type="button"
      onclick={handleDismiss}
      class="absolute -top-2 -right-2 z-10 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border border-edge bg-surface-alt text-content-muted opacity-0 transition-opacity hover:bg-edge hover:text-content group-hover/unfurl:opacity-100"
      title="Remove preview"
      aria-label="Remove preview"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  {/if}
{/snippet}

{#if isDirectImage}
  <!-- Direct image — render inline -->
  <div class="group/unfurl relative mt-1.5 max-w-sm">
    <a href={unfurl.url} target="_blank" rel="noopener noreferrer">
      <img
        src={unfurl.image}
        alt={unfurl.title ?? "Image"}
        class="max-h-80 rounded-lg border border-edge object-cover"
        loading="lazy"
        onerror={hideBrokenImage}
      />
    </a>
    {@render dismissButton()}
  </div>
{:else if hasRenderable}
  <div class="group/unfurl relative mt-1.5 max-w-[520px]">
    <div class="flex overflow-hidden rounded-lg border border-edge bg-raised">
      <!-- Left accent border -->
      <div class="w-[3px] shrink-0" style:background-color={accentColor(unfurl.platform)}></div>

      <div class="min-w-0 flex-1 p-3">
        {#if isTwitter}
          <!-- ── Twitter / X ── -->
          {@render header(unfurl)}
          {#if unfurl.author?.name}
            <a
              href={unfurl.author.url ?? unfurl.url}
              target="_blank"
              rel="noopener noreferrer"
              class="mb-2 flex items-center gap-2 no-underline hover:underline"
            >
              {#if unfurl.author.avatar}
                <img src={unfurl.author.avatar} alt="" class="h-8 w-8 shrink-0 rounded-full" loading="lazy" onerror={hideBrokenImage} />
              {/if}
              <div class="min-w-0">
                <div class="truncate text-[14px] font-semibold text-content">{unfurl.author.name}</div>
                {#if unfurl.author.handle}
                  <div class="truncate text-[12px] text-content-muted">{unfurl.author.handle}</div>
                {/if}
              </div>
            </a>
          {/if}
          {#if unfurl.description}
            <div class="text-[14px] leading-[1.5] break-words whitespace-pre-wrap text-content">
              <span class={cn(!descExpanded && descShouldClamp(unfurl.description) && "line-clamp-6")}>
                {unfurl.description}
              </span>
              {#if descShouldClamp(unfurl.description)}
                <button
                  type="button"
                  onclick={() => (descExpanded = !descExpanded)}
                  class="mt-1 block cursor-pointer text-[12px] text-accent hover:underline"
                >
                  {descExpanded ? "Show less" : "Show more"}
                </button>
              {/if}
            </div>
          {/if}
          {#if twitterImages.length === 1}
            <a href={unfurl.url} target="_blank" rel="noopener noreferrer" class="mt-2 block">
              <img
                src={twitterImages[0].url}
                alt=""
                loading="lazy"
                onerror={hideBrokenImage}
                class="max-h-[400px] max-w-full rounded-lg border border-edge bg-surface object-contain"
              />
            </a>
          {:else if twitterImages.length > 1}
            <div class="mt-2 grid grid-cols-2 gap-1 overflow-hidden rounded-lg">
              {#each gridImages(twitterImages) as img (img.url)}
                <a href={unfurl.url} target="_blank" rel="noopener noreferrer" class="block">
                  <img src={img.url} alt="" loading="lazy" onerror={hideBrokenImage} class="aspect-[4/3] h-full w-full object-cover" />
                </a>
              {/each}
            </div>
          {/if}
          {#each twitterVideos as v (v.url)}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video
              src={v.url}
              poster={v.thumbnail}
              controls
              preload="metadata"
              class="mt-2 max-h-96 max-w-full rounded-lg bg-black"
            ></video>
          {/each}
          {#if unfurl.publishedAt}
            <div class="mt-2 text-[11px] text-content-muted">{publishedLabel(unfurl.publishedAt)}</div>
          {/if}
        {:else if isVideo}
          <!-- ── YouTube / Vimeo ── -->
          {@render header(unfurl)}
          {#if unfurl.title}
            <a
              href={unfurl.url}
              target="_blank"
              rel="noopener noreferrer"
              class="mb-1 line-clamp-2 block text-[15px] font-semibold text-accent hover:underline"
            >
              {unfurl.title}
            </a>
          {/if}
          {#if unfurl.author?.name}
            <div class="mb-2 text-[12px] text-content-muted">
              {#if unfurl.author.url}
                <a href={unfurl.author.url} target="_blank" rel="noopener noreferrer" class="hover:underline">{unfurl.author.name}</a>
              {:else}
                {unfurl.author.name}
              {/if}
            </div>
          {/if}
          {#if unfurl.image}
            <a
              href={unfurl.url}
              target="_blank"
              rel="noopener noreferrer"
              class="relative block overflow-hidden rounded-lg border border-edge"
            >
              <img src={unfurl.image} alt={unfurl.title ?? ""} class="h-auto max-h-[300px] w-full object-cover" loading="lazy" onerror={hideBrokenImage} />
              <div class="absolute inset-0 flex items-center justify-center">
                <div class="flex h-16 w-16 items-center justify-center rounded-full bg-black/70 backdrop-blur-sm">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="white"><polygon points="8 5 20 12 8 19" /></svg>
                </div>
              </div>
            </a>
          {/if}
        {:else if isGithub}
          <!-- ── GitHub ── -->
          {@render header(unfurl)}
          <a
            href={unfurl.url}
            target="_blank"
            rel="noopener noreferrer"
            class="mb-1 block text-[15px] font-semibold break-words text-accent hover:underline"
          >
            {unfurl.title}
          </a>
          {#if unfurl.description}
            <div class="mb-2 line-clamp-3 text-[13px] leading-[1.5] break-words whitespace-pre-wrap text-content-dim">
              {unfurl.description}
            </div>
          {/if}
          <div class="flex flex-wrap items-center gap-3 text-[12px] text-content-muted">
            {#if unfurl.github?.state}
              {@const badge = statusBadge(unfurl.github.state, unfurl.github.kind)}
              <span
                class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                style:background-color={badge.bg}
                style:color={badge.fg}
              >
                {badge.label}
              </span>
            {/if}
            {#if typeof unfurl.github?.stars === "number"}
              <span class="flex items-center gap-1">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z" /></svg>
                {unfurl.github.stars.toLocaleString()}
              </span>
            {/if}
            {#if unfurl.github?.language}
              <span class="flex items-center gap-1.5">
                <span class="h-2.5 w-2.5 rounded-full" style:background-color={languageColor(unfurl.github.language)}></span>
                {unfurl.github.language}
              </span>
            {/if}
            {#if typeof unfurl.github?.comments === "number" && unfurl.github.comments > 0}
              <span>{unfurl.github.comments} comments</span>
            {/if}
            {#if unfurl.author?.name}
              <span class="flex items-center gap-1.5">
                {#if unfurl.author.avatar}
                  <img src={unfurl.author.avatar} alt="" class="h-4 w-4 rounded-full" loading="lazy" onerror={hideBrokenImage} />
                {/if}
                <span>{unfurl.author.name}</span>
              </span>
            {/if}
          </div>
        {:else}
          <!-- ── Generic OG fallback ── -->
          {@render header(unfurl)}
          <a href={unfurl.url} target="_blank" rel="noopener noreferrer" class="block">
            {#if unfurl.title}
              <div class="mb-1 line-clamp-2 text-[15px] font-semibold break-words text-accent hover:underline">{unfurl.title}</div>
            {/if}
            {#if unfurl.description}
              <div class="line-clamp-4 text-[13px] leading-[1.5] break-words whitespace-pre-wrap text-content-dim">{unfurl.description}</div>
            {/if}
          </a>
          {#if unfurl.image}
            <a href={unfurl.url} target="_blank" rel="noopener noreferrer" class="mt-2 block">
              <img
                src={unfurl.image}
                alt=""
                loading="lazy"
                onerror={hideBrokenImage}
                class="h-auto max-h-[320px] w-full rounded-lg border border-edge object-cover"
              />
            </a>
          {/if}
        {/if}
      </div>
    </div>
    {@render dismissButton()}
  </div>
{/if}
