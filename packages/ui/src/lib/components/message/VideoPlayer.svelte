<script lang="ts">
  // Custom video player for chat attachments. Models its play/pause + time
  // machinery on VoicePlayer.svelte. Before playback it shows the poster frame
  // (att.poster — a client-generated thumbnail captured at upload) with a large
  // play button; on play it mounts a <video> and drives custom controls
  // (play/pause, a current/duration time label seeded from att.duration so it
  // reads before the media loads, and a scrubber). Range streaming over
  // CloudFront means seeking only fetches the needed byte ranges.
  import type { Attachment } from "$lib/types.js";
  import { formatDuration } from "$lib/utils.js";

  let { att }: { att: Attachment } = $props();

  let videoEl: HTMLVideoElement | undefined = $state();
  // Once true, the <video> is mounted and we drive it with custom controls.
  let started = $state(false);
  let playing = $state(false);
  let currentTime = $state(0);
  // Seed the duration label from the stored metadata so it shows BEFORE the
  // media element loads; reconcile against the real value on loadedmetadata.
  // Intentional one-time capture of att.duration — each attachment gets its own
  // keyed VideoPlayer instance, so the prop never changes under us.
  // svelte-ignore state_referenced_locally
  let duration = $state(att.duration && Number.isFinite(att.duration) ? att.duration : 0);
  let scrubbing = $state(false);
  let rafId = 0;


  $effect(() => () => cancelAnimationFrame(rafId));

  function tick(): void {
    if (!videoEl) return;
    // While the user drags the scrubber we own currentTime; don't fight them.
    if (!scrubbing) currentTime = videoEl.currentTime;
    if (!videoEl.paused) rafId = requestAnimationFrame(tick);
  }

  // First click on the poster: mount the <video> and start playback. The
  // bind:this isn't available until the element renders, so play on the next
  // microtask after `started` flips.
  async function start(): Promise<void> {
    started = true;
    await Promise.resolve();
    if (!videoEl) return;
    void videoEl.play().catch(() => {
      // Autoplay/codec rejection — leave the element paused with native poster.
      playing = false;
    });
  }

  // Just drive the element — the <video>'s own onplay/onpause handlers
  // (handlePlay/handlePause) own `playing` + the rAF tick loop, so setting them
  // here too would start a second concurrent rAF loop and thrash state.
  function togglePlay(): void {
    if (!videoEl) return;
    if (videoEl.paused) {
      void videoEl.play();
    } else {
      videoEl.pause();
    }
  }

  function handlePlay(): void {
    playing = true;
    rafId = requestAnimationFrame(tick);
  }

  function handlePause(): void {
    playing = false;
    cancelAnimationFrame(rafId);
  }

  function handleEnded(): void {
    playing = false;
    cancelAnimationFrame(rafId);
  }

  function handleLoadedMetadata(): void {
    if (!videoEl) return;
    // Reconcile the seeded label with the real duration once known.
    if (Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
      duration = videoEl.duration;
    }
  }

  // Scrubber: drive currentTime from the range input. `scrubbing` guards `tick`
  // from clobbering the value mid-drag.
  function onScrubInput(e: Event): void {
    const value = Number((e.currentTarget as HTMLInputElement).value);
    currentTime = value;
    if (videoEl) videoEl.currentTime = value;
  }

  const progress = $derived(duration > 0 ? Math.min(1, currentTime / duration) : 0);
  // Mirror VoicePlayer: show elapsed while playing/scrubbed, else total length.
  const timeLabel = $derived.by(() => {
    if (playing || currentTime > 0) return `${formatDuration(currentTime)} / ${formatDuration(duration)}`;
    if (duration > 0) return formatDuration(duration);
    return "0:00";
  });

  const aspect = $derived(
    att.width && att.height ? `${att.width} / ${att.height}` : undefined,
  );
</script>

<div
  class="relative w-fit max-w-sm overflow-hidden rounded-[12px] border border-edge bg-black"
  style={aspect ? `aspect-ratio: ${aspect}; max-height: 16rem;` : "max-height: 16rem;"}
>
  {#if started}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={videoEl}
      src={att.url}
      poster={att.poster}
      preload="metadata"
      playsinline
      class="block h-full max-h-64 w-full max-w-sm object-contain"
      onplay={handlePlay}
      onpause={handlePause}
      onended={handleEnded}
      onloadedmetadata={handleLoadedMetadata}
      ontimeupdate={() => {
        if (videoEl && !scrubbing) currentTime = videoEl.currentTime;
      }}
    ></video>

    <!-- Custom control bar -->
    <div
      class="absolute inset-x-0 bottom-0 flex items-center gap-2.5 bg-gradient-to-t from-black/70 to-transparent px-3 pb-2 pt-6"
    >
      <!--
        Tap target vs. visual: the BUTTON is the hit area (.touch-target lifts it
        to ≥44px on coarse pointers / ≤640px per the iOS HIG) and the inner SPAN
        paints the compact 32px white circle — so desktop density is unchanged
        while a finger gets the full 44pt. Press feedback comes from .pressable
        (scale + tint on :active, coarse-pointer only); desktop keeps hover:bg-white.
      -->
      <button
        type="button"
        onclick={togglePlay}
        class="touch-target pressable flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-black focus-ring"
        aria-label={playing ? "Pause" : "Play"}
      >
        <span
          class="flex h-8 w-8 items-center justify-center rounded-full bg-white/90 transition-colors hover:bg-white"
        >
          {#if playing}
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="1.5" y="1" width="3" height="10" rx="0.75" /><rect x="7.5" y="1" width="3" height="10" rx="0.75" /></svg>
          {:else}
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M3 1.25a.75.75 0 011.13-.65l7 4.25a.75.75 0 010 1.3l-7 4.25A.75.75 0 013 9.75V1.25z" /></svg>
          {/if}
        </span>
      </button>

      <input
        type="range"
        class="vp-scrubber h-1 grow cursor-pointer accent-white"
        min="0"
        max={duration || 0}
        step="0.1"
        value={currentTime}
        oninput={onScrubInput}
        onpointerdown={() => (scrubbing = true)}
        onpointerup={() => (scrubbing = false)}
        aria-label="Seek"
        aria-valuetext={`${formatDuration(currentTime)} of ${formatDuration(duration)}`}
      />

      <span class="shrink-0 font-mono text-[11px] tabular-nums text-white">
        {formatDuration(currentTime)} / {formatDuration(duration)}
      </span>
    </div>
  {:else}
    <!-- Pre-playback: poster (or a neutral placeholder) + a large play button. -->
    <button
      type="button"
      onclick={start}
      class="group relative block h-full w-full cursor-pointer border-0 bg-transparent p-0"
      aria-label={`Play video ${att.name}`}
    >
      {#if att.poster}
        <img
          src={att.poster}
          alt={att.name}
          class="block h-full max-h-64 w-full max-w-sm object-contain"
        />
      {:else}
        <!-- No poster: neutral first-frame surface so the play button has a backdrop. -->
        <div class="flex h-full min-h-[8rem] w-full min-w-[12rem] items-center justify-center bg-raised"></div>
      {/if}

      <!-- Centered play affordance -->
      <span
        class="absolute inset-0 flex items-center justify-center"
        aria-hidden="true"
      >
        <span
          class="flex h-14 w-14 items-center justify-center rounded-full bg-black/55 text-white transition-colors group-hover:bg-black/70"
        >
          <svg width="22" height="22" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.25a.75.75 0 011.13-.65l7 4.25a.75.75 0 010 1.3l-7 4.25A.75.75 0 013 9.75V1.25z" /></svg>
        </span>
      </span>

      <!-- Duration badge (seeded from att.duration) -->
      {#if duration > 0}
        <span
          class="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-white"
        >
          {timeLabel}
        </span>
      {/if}
    </button>
  {/if}
</div>

<style>
  /*
   * Scrubber touch ergonomics (iOS redesign): on a coarse pointer the 4px
   * range input is far too thin to grab with a finger, so we grow the THUMB
   * (~18px) and pad out a taller invisible hit zone — without changing the
   * painted track height or touching the seek logic / time display. Desktop
   * (fine pointer) is left entirely alone: it keeps the native `accent-white`
   * slider, so this never regresses the mouse experience. We only override the
   * native appearance under @media (pointer: coarse), matching how app.css
   * gates .touch-target / .pressable.
   */
  @media (pointer: coarse) {
    .vp-scrubber {
      -webkit-appearance: none;
      appearance: none;
      /* Tailwind preflight sets `box-sizing: border-box` globally (app.css),
         which would fold our 4px height INTO the 28px padding — collapsing the
         content box to 0 and breaking the track/thumb. Force content-box so the
         4px is the painted track height and the padding adds ON TOP, giving the
         intended ~32px hit zone. Scoped to coarse pointer only, so desktop is
         untouched. */
      box-sizing: content-box;
      /* Taller invisible hit zone: a ~32px-high transparent box around the
         4px painted track, so the finger has real area to land on and drag. */
      height: 4px;
      padding-block: 14px;
      background: transparent;
      cursor: pointer;
      touch-action: none;
    }
    .vp-scrubber::-webkit-slider-runnable-track {
      height: 4px;
      border-radius: 9999px;
      background: rgb(255 255 255 / 0.35);
    }
    .vp-scrubber::-moz-range-track {
      height: 4px;
      border-radius: 9999px;
      background: rgb(255 255 255 / 0.35);
    }
    .vp-scrubber::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 18px;
      height: 18px;
      margin-top: -7px; /* center the 18px thumb on the 4px track */
      border-radius: 9999px;
      background: #fff;
      box-shadow: 0 1px 2px rgb(0 0 0 / 0.4);
    }
    .vp-scrubber::-moz-range-thumb {
      width: 18px;
      height: 18px;
      border: none;
      border-radius: 9999px;
      background: #fff;
      box-shadow: 0 1px 2px rgb(0 0 0 / 0.4);
    }
  }
</style>
