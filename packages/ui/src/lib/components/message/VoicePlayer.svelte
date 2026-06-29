<script lang="ts">
  // Waveform voice-note player. Ported from cyborg7-core VoicePlayer.tsx.
  // Decodes the audio to draw a real waveform + derive an accurate duration
  // (MediaRecorder WebM reports duration=Infinity until fully decoded; we work
  // around it via decodeAudioData and a seek hack).
  import { formatDuration } from "$lib/utils.js";

  const BAR_COUNT = 40;
  const BAR_WIDTH = 2.5;
  const BAR_GAP = 1.5;
  const BAR_MIN = 2;
  const BAR_MAX = 20;

  let { src, type = undefined }: { src: string; type?: string } = $props();

  let audioEl: HTMLAudioElement | undefined = $state();
  let playing = $state(false);
  let currentTime = $state(0);
  let duration = $state(0);
  let bars = $state<number[]>(generatePlaceholderBars(BAR_COUNT));
  let rafId = 0;

  function generateWaveformBars(data: Float32Array, count: number): number[] {
    const out: number[] = [];
    const step = Math.floor(data.length / count) || 1;
    for (let i = 0; i < count; i++) {
      let sum = 0;
      const start = i * step;
      const end = Math.min(start + step, data.length);
      for (let j = start; j < end; j++) sum += Math.abs(data[j]);
      const avg = sum / (end - start);
      out.push(Math.max(BAR_MIN, Math.min(BAR_MAX, avg * BAR_MAX * 3)));
    }
    return out;
  }

  function generatePlaceholderBars(count: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      const t = i / count;
      const h =
        BAR_MIN +
        (BAR_MAX - BAR_MIN) *
          (0.35 +
            0.35 * Math.sin(t * Math.PI * 5) * Math.cos(t * Math.PI * 2) +
            0.15 * Math.sin(t * Math.PI * 11));
      out.push(Math.max(BAR_MIN, Math.min(BAR_MAX, h)));
    }
    return out;
  }


  // Decode for a real waveform + accurate duration. CORS-dependent; falls back
  // to placeholder bars + the loadedmetadata seek hack on failure.
  $effect(() => {
    let cancelled = false;
    const currentSrc = src;
    (async () => {
      try {
        const resp = await fetch(currentSrc);
        if (!resp.ok) return;
        const buf = await resp.arrayBuffer();
        const ctx = new AudioContext();
        const audioBuf = await ctx.decodeAudioData(buf);
        if (cancelled) {
          void ctx.close();
          return;
        }
        bars = generateWaveformBars(audioBuf.getChannelData(0), BAR_COUNT);
        if (Number.isFinite(audioBuf.duration) && audioBuf.duration > 0) {
          duration = audioBuf.duration;
        }
        void ctx.close();
      } catch {
        // keep placeholder bars; loadedmetadata handles duration
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  $effect(() => () => cancelAnimationFrame(rafId));

  function tick(): void {
    if (!audioEl) return;
    currentTime = audioEl.currentTime;
    if (!audioEl.paused) rafId = requestAnimationFrame(tick);
  }

  function togglePlay(): void {
    if (!audioEl) return;
    if (audioEl.paused) {
      void audioEl.play();
      playing = true;
      rafId = requestAnimationFrame(tick);
    } else {
      audioEl.pause();
      playing = false;
      cancelAnimationFrame(rafId);
    }
  }

  function handleEnded(): void {
    playing = false;
    currentTime = 0;
    cancelAnimationFrame(rafId);
  }

  function handleLoadedMetadata(): void {
    if (!audioEl) return;
    if (!Number.isFinite(audioEl.duration) || audioEl.duration === 0) {
      const onDurationChange = (): void => {
        if (audioEl && Number.isFinite(audioEl.duration) && audioEl.duration > 0) {
          duration = audioEl.duration;
          audioEl.currentTime = 0;
          audioEl.removeEventListener("durationchange", onDurationChange);
        }
      };
      audioEl.addEventListener("durationchange", onDurationChange);
      audioEl.currentTime = 1e10; // force full decode → real duration
    } else {
      duration = audioEl.duration;
    }
  }

  function handleWaveformClick(e: MouseEvent): void {
    if (!audioEl || !duration) return;
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audioEl.currentTime = pct * duration;
    currentTime = audioEl.currentTime;
  }

  const progress = $derived(duration > 0 ? currentTime / duration : 0);
  const svgWidth = BAR_COUNT * (BAR_WIDTH + BAR_GAP) - BAR_GAP;
  const timeLabel = $derived.by(() => {
    if (playing || currentTime > 0) return formatDuration(currentTime);
    if (duration > 0) return formatDuration(duration);
    return "0:00";
  });
</script>

<div
  class="inline-flex max-w-[340px] items-center gap-2.5 rounded-full border border-edge py-1 pl-1 pr-3.5"
  style="background-color: var(--bg-voice, var(--raised, rgba(0,0,0,0.06)));"
>
  <!-- svelte-ignore a11y_media_has_caption -->
  <audio bind:this={audioEl} preload="metadata" onended={handleEnded} onloadedmetadata={handleLoadedMetadata}>
    <source {src} {type} />
  </audio>

  <button
    type="button"
    onclick={togglePlay}
    class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors touch-target"
    style="background-color: var(--content, #333); color: var(--surface, #fff);"
    aria-label={playing ? "Pause" : "Play"}
  >
    {#if playing}
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="1.5" y="1" width="3" height="10" rx="0.75" /><rect x="7.5" y="1" width="3" height="10" rx="0.75" /></svg>
    {:else}
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.25a.75.75 0 011.13-.65l7 4.25a.75.75 0 010 1.3l-7 4.25A.75.75 0 013 9.75V1.25z" /></svg>
    {/if}
  </button>

  <svg
    width={svgWidth}
    height={BAR_MAX}
    viewBox="0 0 {svgWidth} {BAR_MAX}"
    class="shrink-0 cursor-pointer"
    onclick={handleWaveformClick}
    role="slider"
    aria-label="Seek"
    aria-valuenow={Math.round(progress * 100)}
    aria-valuemin="0"
    aria-valuemax="100"
    tabindex="0"
  >
    {#each bars as h, i (i)}
      {@const x = i * (BAR_WIDTH + BAR_GAP)}
      {@const isPlayed = (i + 0.5) / BAR_COUNT <= progress}
      <rect
        {x}
        y={(BAR_MAX - h) / 2}
        width={BAR_WIDTH}
        height={h}
        rx={BAR_WIDTH / 2}
        ry={BAR_WIDTH / 2}
        fill={isPlayed ? "var(--content, #333)" : "var(--content-muted, #bbb)"}
      />
    {/each}
  </svg>

  <span class="min-w-[28px] shrink-0 text-right font-mono text-[11px] tabular-nums text-content-dim">
    {timeLabel}
  </span>
</div>
