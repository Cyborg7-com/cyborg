<script lang="ts">
  // Fixed-size square thumbnail tile with a BlurHash low-quality placeholder
  // (LQIP) behind the <img>. Removes the grey-box flash before the thumbnail
  // loads — the blurred hash paints instantly, then the real image fades in.
  //
  // Sibling to BlurHashImage.svelte, which targets variable-size message images
  // (aspect-ratio reservation + <picture> srcset). This one is for the small
  // fixed squares in SharedFilesPanel where we only need the LQIP + fade-in.
  import { decode } from "blurhash";

  let {
    src,
    alt,
    blurhash = null,
  }: {
    src: string;
    alt: string;
    blurhash?: string | null;
  } = $props();

  let loaded = $state(false);
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
</script>

<div class="relative h-full w-full overflow-hidden">
  {#if blurhash && !loaded}
    <canvas
      bind:this={canvas}
      width="32"
      height="32"
      class="absolute inset-0 h-full w-full"
      style="filter: blur(2px); transform: scale(1.05);"
    ></canvas>
  {/if}
  <img
    {src}
    {alt}
    loading="lazy"
    decoding="async"
    class="absolute inset-0 h-full w-full object-cover transition-opacity duration-200"
    style="opacity: {loaded ? 1 : 0};"
    onload={() => (loaded = true)}
  />
</div>
