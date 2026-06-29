<script lang="ts">
  // Slack-style avatar cropper: the picked image is pannable behind a fixed
  // square crop frame, with a zoom slider below. On save we render the framed
  // region to a 256×256 canvas and hand back a JPEG blob — the same size the
  // old auto-center-crop produced, so the upload pipeline is unchanged.

  let {
    open,
    src,
    onSave,
    onCancel,
  }: {
    open: boolean;
    // Data URL of the freshly picked file.
    src: string | null;
    onSave: (blob: Blob, preview: string) => void;
    onCancel: () => void;
  } = $props();

  // Viewport (crop frame) size in CSS px — the visible square the user frames.
  const VIEW = 300;
  // Output resolution written to the upload (matches the previous behavior).
  const OUT = 256;

  let img = $state<HTMLImageElement | null>(null);
  let baseScale = $state(1); // scale that makes the image just cover the frame
  let zoom = $state(1); // user zoom multiplier (>= 1)
  let tx = $state(0); // image top-left x relative to the frame
  let ty = $state(0);

  let dragging = $state(false);
  let dragStartX = 0;
  let dragStartY = 0;
  let dragOriginX = 0;
  let dragOriginY = 0;

  const effectiveScale = $derived(baseScale * zoom);

  function clampOffset(x: number, y: number, scale: number): { x: number; y: number } {
    const w = (img?.naturalWidth ?? 0) * scale;
    const h = (img?.naturalHeight ?? 0) * scale;
    // Keep the frame fully covered: top-left can't go positive, and can't pull
    // the far edge inside the frame.
    const minX = Math.min(0, VIEW - w);
    const minY = Math.min(0, VIEW - h);
    return {
      x: Math.max(minX, Math.min(0, x)),
      y: Math.max(minY, Math.min(0, y)),
    };
  }

  // (Re)load the image whenever a new source comes in while open.
  $effect(() => {
    if (!open || !src) return;
    const image = new Image();
    image.onload = () => {
      const cover = Math.max(VIEW / image.naturalWidth, VIEW / image.naturalHeight);
      img = image;
      baseScale = cover;
      zoom = 1;
      // Center the image in the frame.
      const w = image.naturalWidth * cover;
      const h = image.naturalHeight * cover;
      tx = (VIEW - w) / 2;
      ty = (VIEW - h) / 2;
    };
    image.src = src;
  });

  function onPointerDown(e: PointerEvent) {
    if (!img) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragOriginX = tx;
    dragOriginY = ty;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const next = clampOffset(
      dragOriginX + (e.clientX - dragStartX),
      dragOriginY + (e.clientY - dragStartY),
      effectiveScale,
    );
    tx = next.x;
    ty = next.y;
  }

  function onPointerUp(e: PointerEvent) {
    dragging = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  }

  function onZoomInput(e: Event) {
    if (!img) return;
    const newZoom = Number((e.currentTarget as HTMLInputElement).value);
    const oldScale = effectiveScale;
    const newScale = baseScale * newZoom;
    // Anchor the zoom on the frame center so the focal point stays put.
    const centerImgX = (VIEW / 2 - tx) / oldScale;
    const centerImgY = (VIEW / 2 - ty) / oldScale;
    const next = clampOffset(
      VIEW / 2 - centerImgX * newScale,
      VIEW / 2 - centerImgY * newScale,
      newScale,
    );
    zoom = newZoom;
    tx = next.x;
    ty = next.y;
  }

  function handleSave() {
    if (!img) return;
    const canvas = document.createElement("canvas");
    canvas.width = OUT;
    canvas.height = OUT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Map the frame back into natural-image coordinates.
    const sx = -tx / effectiveScale;
    const sy = -ty / effectiveScale;
    const sSize = VIEW / effectiveScale;
    ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, OUT, OUT);

    const preview = canvas.toDataURL("image/jpeg", 0.82);
    canvas.toBlob(
      (blob) => {
        if (blob) onSave(blob, preview);
      },
      "image/jpeg",
      0.82,
    );
  }
</script>

{#if open && src}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label="Crop your photo"
    onkeydown={(e) => { if (e.key === "Escape") onCancel(); }}
  >
    <button
      type="button"
      class="absolute inset-0 cursor-default"
      style="background-color: var(--modal-overlay);"
      aria-label="Close cropper"
      onclick={onCancel}
    ></button>

    <div
      class="relative flex w-[var(--panel-wider)] flex-col rounded-xl shadow-2xl"
      style="background-color: var(--dropdown-bg); border: 1px solid var(--dropdown-border);"
    >
      <!-- Header -->
      <div
        class="flex shrink-0 items-center justify-between px-5 py-3.5"
        style="border-bottom: 1px solid var(--dropdown-border);"
      >
        <h2 class="text-[15px] font-bold" style="color: var(--dropdown-name);">Crop your photo</h2>
        <button
          type="button"
          onclick={onCancel}
          class="cursor-pointer text-[18px] hover:opacity-70"
          style="color: var(--dropdown-secondary);"
          aria-label="Close"
        >
          &times;
        </button>
      </div>

      <!-- Crop stage -->
      <div class="flex flex-col items-center gap-4 px-5 py-5">
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="relative overflow-hidden rounded-lg select-none"
          style="width: {VIEW}px; height: {VIEW}px; background-color: var(--bg-base); cursor: {dragging ? 'grabbing' : 'grab'}; touch-action: none;"
          onpointerdown={onPointerDown}
          onpointermove={onPointerMove}
          onpointerup={onPointerUp}
          onpointercancel={onPointerUp}
        >
          {#if img}
            <img
              src={img.src}
              alt=""
              draggable="false"
              class="pointer-events-none absolute left-0 top-0 max-w-none origin-top-left"
              style="width: {img.naturalWidth}px; height: {img.naturalHeight}px; transform: translate({tx}px, {ty}px) scale({effectiveScale});"
            />
          {/if}
          <!-- Dimmed surround + circular guide, Slack-style. -->
          <div
            class="pointer-events-none absolute inset-0 rounded-lg"
            style="box-shadow: 0 0 0 9999px rgba(0,0,0,0.45); border-radius: 9999px;"
          ></div>
          <div
            class="pointer-events-none absolute inset-0 rounded-full"
            style="border: 2px solid rgba(255,255,255,0.85);"
          ></div>
        </div>

        <!-- Zoom slider -->
        <div class="flex w-full items-center gap-3">
          <svg class="h-4 w-4 shrink-0" style="color: var(--dropdown-secondary);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" />
          </svg>
          <input
            type="range"
            min="1"
            max="3"
            step="0.01"
            value={zoom}
            oninput={onZoomInput}
            class="c7-zoom-slider h-1 flex-1 cursor-pointer appearance-none rounded-full"
            aria-label="Zoom"
          />
        </div>
      </div>

      <!-- Footer -->
      <div
        class="flex shrink-0 items-center justify-end gap-2 px-5 py-3"
        style="border-top: 1px solid var(--dropdown-border);"
      >
        <button
          type="button"
          onclick={onCancel}
          class="cursor-pointer rounded-lg px-4 py-2 text-[13px] transition-colors hover:opacity-80"
          style="color: var(--dropdown-name);"
        >
          Cancel
        </button>
        <button
          type="button"
          onclick={handleSave}
          disabled={!img}
          class="cursor-pointer rounded-lg px-4 py-2 text-[13px] font-semibold transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          style="background-color: var(--btn-primary-bg); color: var(--btn-primary-text);"
        >
          Save photo
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .c7-zoom-slider {
    background: var(--dropdown-border);
  }
  .c7-zoom-slider::-webkit-slider-thumb {
    appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 9999px;
    background: var(--btn-primary-bg);
    cursor: pointer;
    border: 2px solid var(--dropdown-bg);
  }
  .c7-zoom-slider::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border-radius: 9999px;
    background: var(--btn-primary-bg);
    cursor: pointer;
    border: 2px solid var(--dropdown-bg);
  }
</style>
