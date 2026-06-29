<script lang="ts">
  import { decode } from "blurhash";

  interface Thumbnails {
    w360?: string;
    w720?: string;
    w1080?: string;
  }

  let {
    src,
    alt,
    width = 0,
    height = 0,
    blurhash = null,
    thumbnails = undefined,
    maxWidth = 320, // matches the old max-w-xs
    maxHeight = 256, // matches the old max-h-64
  }: {
    src: string;
    alt: string;
    width?: number;
    height?: number;
    blurhash?: string | null;
    thumbnails?: Thumbnails;
    maxWidth?: number;
    maxHeight?: number;
  } = $props();

  let loaded = $state(false);
  // <picture> has no built-in fallback: if the media-matched <source> 404s
  // (thumbnail variant still generating / skipped), the browser errors the
  // inner <img> instead of trying the next source. We catch that once and
  // collapse to the plain <img src> (full-res original).
  let thumbsFailed = $state(false);
  // The full-res GET itself can fail on device (S3/CDN 403, CORS-blocked, or the
  // object was never uploaded). Without an onerror handler the <img> sits at
  // opacity:0 forever and the user stares at the empty aspect-ratio box (the
  // "teal rectangle"). Track the failure so we can paint a visible broken state
  // with a tap-to-retry.
  let failed = $state(false);
  let retryNonce = $state(0);
  // Cache-bust on retry so the browser re-issues the GET instead of serving the
  // failed entry from its memory cache.
  const effectiveSrc = $derived(
    retryNonce === 0 ? src : `${src}${src.includes("?") ? "&" : "?"}_r=${retryNonce}`,
  );

  function retry(): void {
    failed = false;
    loaded = false;
    retryNonce += 1;
  }
  let canvas: HTMLCanvasElement | undefined = $state();

  // Paint the BlurHash placeholder once the canvas mounts. Tiny (32x32) so ~1ms.
  $effect(() => {
    if (!blurhash || !canvas || loaded) return;
    try {
      const pixels = decode(blurhash, 32, 32);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const imgData = ctx.createImageData(32, 32);
      imgData.data.set(pixels);
      ctx.putImageData(imgData, 0, 0);
    } catch {
      // Malformed hash — skip the placeholder; the real image still loads.
    }
  });

  // Reserve an aspect-ratio box from width/height so the message list never
  // reflows as images decode. Degenerate dims fall back to a square.
  const aspect = $derived(height > 0 ? width / height : 1);
  const display = $derived.by(() => {
    if (!width || !height) return { w: maxWidth, h: maxWidth / aspect };
    let w = Math.min(width, maxWidth);
    let h = w / aspect;
    if (h > maxHeight) {
      h = maxHeight;
      w = h * aspect;
    }
    return { w, h };
  });

  const hasThumbs = $derived(
    !thumbsFailed && !!thumbnails && !!(thumbnails.w360 || thumbnails.w720 || thumbnails.w1080),
  );
</script>

<div
  class="relative overflow-hidden rounded-lg"
  style="width: {display.w}px; height: {display.h}px; background-color: var(--bg-surface-alt, #1a1a1a);"
>
  {#if blurhash && !loaded}
    <canvas
      bind:this={canvas}
      width="32"
      height="32"
      class="absolute inset-0 h-full w-full"
      style="filter: blur(4px); transform: scale(1.05);"
    ></canvas>
  {/if}

  {#if hasThumbs}
    <picture class="absolute inset-0 block h-full w-full">
      {#if thumbnails?.w1080}
        <source type="image/webp" srcset="{thumbnails.w1080} 1080w" media="(min-width: 721px)" />
      {/if}
      {#if thumbnails?.w720}
        <source type="image/webp" srcset="{thumbnails.w720} 720w" media="(min-width: 361px)" />
      {/if}
      {#if thumbnails?.w360}
        <source type="image/webp" srcset="{thumbnails.w360} 360w" />
      {/if}
      <img
        src={effectiveSrc}
        {alt}
        loading="lazy"
        class="h-full w-full object-cover transition-opacity duration-200"
        style="opacity: {loaded ? 1 : 0};"
        onload={() => (loaded = true)}
        onerror={() => (thumbsFailed = true)}
      />
    </picture>
  {:else}
    <img
      src={effectiveSrc}
      {alt}
      loading="lazy"
      class="absolute inset-0 h-full w-full object-cover transition-opacity duration-200"
      style="opacity: {loaded ? 1 : 0};"
      onload={() => {
        loaded = true;
        failed = false;
      }}
      onerror={() => (failed = true)}
    />
  {/if}

  {#if failed && !loaded}
    <!-- Visible broken state instead of a permanent blank box: tells the user the
         image couldn't load and offers a retry (re-issues the GET, cache-busted). -->
    <button
      type="button"
      onclick={(e) => {
        e.stopPropagation();
        retry();
      }}
      class="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center"
      style="background-color: var(--bg-surface-alt, #1a1a1a); color: var(--text-muted, #9ca3af);"
      aria-label="Image failed to load. Tap to retry."
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="3" y1="3" x2="21" y2="21" />
        <circle cx="8.5" cy="8.5" r="1.5" />
      </svg>
      <span style="font-size: 11px; line-height: 1.2;">Couldn't load</span>
      <span style="font-size: 10px; opacity: 0.8;">Tap to retry</span>
    </button>
  {/if}
</div>
