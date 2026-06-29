<script lang="ts">
  // Full-screen image preview overlay — ported from cyborg7-core's
  // ImagePreviewModal.tsx. Closes on backdrop click, the × button, or Esc.
  // Download blobs the cross-origin `url` via downloadFile so it saves to disk
  // instead of navigating (the HTML `download` attribute is ignored on
  // cross-origin links).
  import OverlayRoot from "$lib/components/ui/overlay/OverlayRoot.svelte";
  import { createImageActions } from "$lib/media/image-actions.svelte.js";

  let {
    image,
    onClose,
  }: {
    image: { url: string; name?: string; downloadUrl?: string } | null;
    onClose: () => void;
  } = $props();

  // Shared image-action layer (#537): save (with the iOS+Android native gate),
  // copy-image, copy-link, the save-result state machine + label, and the iOS
  // native-pill hide/restore — all owned in ONE place so this preview and the
  // gesture viewer can't drift. This component keeps only its layout below.
  const actions = createImageActions(() => image);
</script>

{#if image}
  <!-- OverlayRoot owns the shared chrome: `use:portal` to <body> (so this
       `position:fixed` overlay escapes PullToRefresh's resting transform — the
       "tapping an image does nothing" bug — and is viewport-relative) + the
       scrim + window-level Escape-to-close. The scrim is kept at the original
       literal `rgba(0,0,0,0.85)` (the dark image backdrop, which has no matching
       theme token; #509 deliberately left these image-backdrop scrims as-is) so
       the look is byte-identical. The save/copy/× buttons + the image stay as
       children, each with its own `stopPropagation`. -->
  <OverlayRoot
    onClose={onClose}
    ariaLabel="Image preview"
    scrim="rgba(0,0,0,0.85)"
    closeOnEscape
    class="z-[var(--z-modal)] flex cursor-zoom-out items-center justify-center p-8"
  >
    <!-- Offset by the top safe-area inset (--sat) so the Save/× buttons clear the
         status bar (WiFi/battery) / Dynamic Island instead of sitting under them. -->
    <div
      class="absolute right-4 flex items-center gap-2"
      style="top: calc(var(--sat, 0px) + 0.75rem);"
    >
      {#if actions.saveResult}
        <span
          class="rounded-full px-3 py-1.5 text-[12px] font-medium text-white"
          style="background-color: {actions.saveResult === 'saved' ? 'rgba(var(--color-success-rgb),0.9)' : 'rgba(var(--color-error-strong-rgb),0.9)'};"
        >{actions.saveResultLabel}</span>
      {/if}
      <!-- Copy image (binary → clipboard as PNG). Net-new vs. the original. -->
      <button
        type="button"
        onclick={(e) => {
          e.stopPropagation();
          void actions.copyImage();
        }}
        title="Copy image"
        aria-label="Copy image"
        class="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-white transition-colors"
        style="background-color: var(--scrim-control); box-shadow: var(--scrim-control-shadow);"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
        <span class="sr-only">Copy image</span>
      </button>
      <!-- Copy link. Note: signed CloudFront URLs may expire — fine for a quick paste. -->
      <button
        type="button"
        onclick={(e) => {
          e.stopPropagation();
          void actions.copyLink();
        }}
        title="Copy link"
        aria-label="Copy link"
        class="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-white transition-colors"
        style="background-color: var(--scrim-control); box-shadow: var(--scrim-control-shadow);"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
        <span class="sr-only">Copy link</span>
      </button>
      {#if image.name}
        <button
          type="button"
          disabled={actions.saving}
          onclick={(e) => {
            e.stopPropagation();
            void actions.save();
          }}
          title={actions.onNativeSave ? `Save ${image.name} to ${actions.saveNoun}` : `Download ${image.name}`}
          aria-label={actions.onNativeSave ? `Save ${image.name} to ${actions.saveNoun}` : `Download ${image.name}`}
          class="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-white transition-colors disabled:opacity-60"
          style="background-color: var(--scrim-control); box-shadow: var(--scrim-control-shadow);"
        >
          {#if actions.saving}
            <span class="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white"></span>
          {:else}
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 2v9M4 7l4 4 4-4M3 14h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          {/if}
          <span class="sr-only">{actions.onNativeSave ? `Save to ${actions.saveNoun}` : "Download"}</span>
        </button>
      {/if}
      <button
        type="button"
        onclick={(e) => { e.stopPropagation(); onClose(); }}
        title="Close (Esc)"
        aria-label="Close preview"
        class="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-white transition-colors"
        style="background-color: var(--scrim-control); box-shadow: var(--scrim-control-shadow);"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <img
      src={image.url}
      alt={image.name ?? "Preview"}
      onclick={(e) => e.stopPropagation()}
      class="max-h-[88vh] max-w-[92vw] cursor-default rounded-md object-contain shadow-2xl"
    />
  </OverlayRoot>
{/if}
