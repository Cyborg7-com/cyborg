<script lang="ts">
  import { portal } from "$lib/actions/portal.js";
  import { formatDuration } from "$lib/utils.js";

  let {
    onRecordingComplete,
    // iOS: the web composer chrome is opacity:0 and the native UIKit pill sits
    // ON TOP of the WebView, so the inline recording bar would be invisible /
    // behind the pill. In `floating` mode we render the bar as a portaled fixed
    // overlay (visible above the WebView), and the parent hides the native pill +
    // dismisses the keyboard via onRecordingStart / restores it via onRecordingStop.
    floating = false,
    onRecordingStart,
    onRecordingStop,
  }: {
    onRecordingComplete: (file: File, preview: string) => void;
    floating?: boolean;
    onRecordingStart?: () => void;
    onRecordingStop?: () => void;
  } = $props();

  let isRecording = $state(false);
  let duration = $state(0);
  let liveWaveform = $state<number[]>(Array.from({ length: 28 }, () => 3));

  let mediaRecorder: MediaRecorder | null = null;
  let audioChunks: Blob[] = [];
  let recordingTimer: ReturnType<typeof setInterval> | null = null;
  let analyser: AnalyserNode | null = null;
  let audioCtx: AudioContext | null = null;
  let animFrame = 0;

  export function getIsRecording(): boolean {
    return isRecording;
  }

  export async function startRecording(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // iOS WKWebView's MediaRecorder does NOT support webm/opus — constructing
      // with it throws / yields an undecodable blob. Pick the first container the
      // platform actually supports: desktop → webm/opus, iOS → audio/mp4 (AAC).
      const preferredMimes = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"];
      const pickedMime =
        preferredMimes.find((m) => {
          try {
            return MediaRecorder.isTypeSupported(m);
          } catch {
            return false;
          }
        }) ?? "";
      const recorder = pickedMime ? new MediaRecorder(stream, { mimeType: pickedMime }) : new MediaRecorder(stream);
      // The container the recorder actually settled on (iOS → audio/mp4), without
      // codec params — for a clean upload Content-Type + correct file extension.
      const outMime = (recorder.mimeType || pickedMime || "audio/mp4").split(";")[0];
      const fileExt =
        outMime.includes("mp4") || outMime.includes("m4a")
          ? "m4a"
          : outMime.includes("aac")
            ? "aac"
            : outMime.includes("ogg")
              ? "ogg"
              : "webm";
      audioChunks = [];

      audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);

      const freqData = new Uint8Array(analyser.frequencyBinCount);
      const barCount = 28;
      const tickWaveform = () => {
        if (!analyser) return;
        analyser.getByteFrequencyData(freqData);
        const bars: number[] = [];
        const step = Math.floor(freqData.length / barCount) || 1;
        for (let i = 0; i < barCount; i++) {
          let max = 0;
          for (let j = i * step; j < Math.min((i + 1) * step, freqData.length); j++) {
            if (freqData[j] > max) max = freqData[j];
          }
          bars.push(Math.max(3, Math.min(24, (max / 255) * 28)));
        }
        liveWaveform = bars;
        animFrame = requestAnimationFrame(tickWaveform);
      };
      animFrame = requestAnimationFrame(tickWaveform);

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      recorder.onstop = () => {
        cancelAnimationFrame(animFrame);
        analyser = null;
        audioCtx?.close();
        audioCtx = null;
        stream.getTracks().forEach((t) => t.stop());
        if (recordingTimer) clearInterval(recordingTimer);
        duration = 0;
        liveWaveform = Array.from({ length: 28 }, () => 3);

        const blob = new Blob(audioChunks, { type: outMime });
        if (blob.size < 1000) return;

        const file = new File([blob], `voice-${Date.now()}.${fileExt}`, { type: outMime });
        const preview = URL.createObjectURL(blob);
        onRecordingComplete(file, preview);
      };

      // No timeslice: emit ONE complete blob at stop. A timeslice fragments the
      // output, and on iOS an mp4/AAC recording without a final moov atom is
      // undecodable (no duration, won't play). The live waveform uses the
      // AnalyserNode, not MediaRecorder chunks, so it's unaffected.
      recorder.start();
      mediaRecorder = recorder;
      isRecording = true;
      duration = 0;
      recordingTimer = setInterval(() => { duration += 1; }, 1000);
      // Recording actually started — let the parent hide the native pill +
      // dismiss the keyboard so the floating bar is visible (iOS).
      onRecordingStart?.();
    } catch {
      alert("Could not access microphone. Please allow microphone access in your browser/system settings.");
    }
  }

  export function stopRecording(): void {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    mediaRecorder = null;
    isRecording = false;
    onRecordingStop?.();
  }

  function cancelRecording(): void {
    cancelAnimationFrame(animFrame);
    analyser = null;
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stream.getTracks().forEach((t) => t.stop());
      mediaRecorder.stop();
    }
    audioChunks = [];
    mediaRecorder = null;
    isRecording = false;
    duration = 0;
    liveWaveform = Array.from({ length: 28 }, () => 3);
    if (recordingTimer) clearInterval(recordingTimer);
    audioCtx?.close();
    audioCtx = null;
    onRecordingStop?.();
  }
</script>

{#snippet recordingBar()}
  <div class="inline-flex items-center gap-2 rounded-full border border-edge pl-3 pr-1.5 py-1.5 shadow-lg" style="background-color: var(--bg-voice, var(--raised, rgba(0,0,0,0.06)));">
    <span class="w-2 h-2 rounded-full bg-red-500 animate-pulse shrink-0"></span>
    <svg width={140} height={26} viewBox="0 0 140 26" class="shrink-0">
      {#each liveWaveform as h, i}
        <rect
          x={i * 5}
          y={(26 - h) / 2}
          width={3}
          height={h}
          rx={1.5}
          ry={1.5}
          fill="var(--content-muted, #999)"
          style="transition: height 0.08s ease-out, y 0.08s ease-out;"
        />
      {/each}
    </svg>
    <span class="text-[12px] text-content font-mono tabular-nums shrink-0">
      {formatDuration(duration)}
    </span>
    <button type="button" onclick={cancelRecording} class="shrink-0 w-7 h-7 rounded-full flex items-center justify-center hover:bg-edge cursor-pointer touch-target" title="Cancel">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--error, #ef4444)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
    </button>
    <button type="button" onclick={stopRecording} class="shrink-0 w-8 h-8 rounded-full flex items-center justify-center cursor-pointer transition-colors touch-target" style="background-color: var(--content, #333); color: var(--surface, #fff);" title="Stop and attach">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
    </button>
  </div>
{/snippet}

{#if isRecording}
  {#if floating}
    <!-- iOS: portaled to <body> so it sits above the WebView (the native pill is
         hidden while recording) and escapes any transformed ancestor. Centered
         just above the bottom nav / home indicator. -->
    <div
      use:portal
      class="fixed left-1/2 z-[var(--z-menu)] -translate-x-1/2"
      style="bottom: calc(env(safe-area-inset-bottom, 0px) + 68px); pointer-events: auto;"
    >
      {@render recordingBar()}
    </div>
  {:else}
    <div class="px-3 pt-2 pb-1">
      {@render recordingBar()}
    </div>
  {/if}
{/if}
