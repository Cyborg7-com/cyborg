// Notification sound — played alongside every OS banner the notify policy
// decides to fire (channel message, DM). Ported from the original web app's
// notify module: a single <audio> element, volume 0.5, with an "unlock" step
// because browsers (and Chromium under Electron) block audio.play() until the
// page has seen a user interaction.
//
// iOS native shell: this web <audio> path is SKIPPED entirely (isTauriIOS guards
// below). On the Tauri iOS shell the FCM/APNs notification is the SINGLE sound
// source — foreground via the push plugin's willPresent ([.banner,.sound,.badge]),
// background via APNs. A parallel web <audio> there both double-dings AND, worse,
// registers the WKWebView with iOS's now-playing system (the "music" pill at the
// top of the screen). This mirrors v1's mobile adapter exactly (cyborg7-core
// mobile .../notify/platforms/local.ts: "Skip the local path on mobile; let FCM be
// the single source").

import { isTauriIOS } from "./mobile/push.js";

let audioEl: HTMLAudioElement | null = null;
let unlocked = false;

function element(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (!audioEl) {
    audioEl = new Audio("/sounds/notification.mp3");
    audioEl.volume = 0.5;
  }
  return audioEl;
}

// Play the element silently once on the first user gesture so every later
// playNotificationSound() succeeds without the autoplay prompt. Idempotent.
export function unlockNotificationAudio(): void {
  // iOS: never touch the <audio> element — even the silent unlock play()
  // registers the WKWebView with the now-playing system. FCM owns mobile sound.
  if (isTauriIOS()) return;
  if (unlocked) return;
  const a = element();
  if (!a) return;
  unlocked = true;
  const vol = a.volume;
  a.volume = 0;
  a.play()
    .then(() => {
      a.pause();
      a.currentTime = 0;
      a.volume = vol;
      return undefined;
    })
    .catch(() => {
      // No interaction yet — the next gesture will retry.
    });
}

export function playNotificationSound(): void {
  // iOS: FCM/native is the single notification sound source (see header) — the
  // web <audio> here would double-ding and trigger the now-playing pill.
  if (isTauriIOS()) return;
  const a = element();
  if (!a) return;
  a.currentTime = 0;
  a.play().catch(() => {
    // Expected before the first unlock; harmless.
  });
}

// ─── Named per-channel sounds (client-side, Web Audio) ───────────────
// Per-channel sound choices avoid asset hosting by synthesizing short tones via
// the Web Audio API. "default" reuses the bundled mp3 above; "none" is silent.
// Like <audio>.play(), AudioContext also needs a prior user gesture — the same
// unlock click that primes the mp3 also resumes a suspended context here.

export type NamedSound = "default" | "bell" | "chime" | "ding" | "none";

let audioCtx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) {
    try {
      audioCtx = new Ctor();
    } catch {
      return null;
    }
  }
  return audioCtx;
}

// One decaying sine "blip" at a given frequency, scheduled relative to `at`.
function blip(ctx: AudioContext, freq: number, at: number, duration: number, gain = 0.18): void {
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, at);
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(gain, at + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  osc.connect(env);
  env.connect(ctx.destination);
  osc.start(at);
  osc.stop(at + duration + 0.02);
}

// Tone recipes — distinct enough to tell channels apart by ear.
const TONES: Record<Exclude<NamedSound, "default" | "none">, [number, number][]> = {
  // Bell: two-note descending chime.
  bell: [
    [880, 0],
    [659.25, 0.14],
  ],
  // Chime: gentle ascending major third.
  chime: [
    [587.33, 0],
    [739.99, 0.12],
  ],
  // Ding: single bright note.
  ding: [[1046.5, 0]],
};

// Play the chosen per-channel sound. "default" delegates to the bundled mp3 so
// existing behavior is unchanged; "none" stays silent.
export function playNamedSound(choice: NamedSound): void {
  if (choice === "none") return;
  if (choice === "default") {
    playNotificationSound();
    return;
  }
  const ctx = context();
  if (!ctx) {
    // No Web Audio — fall back to the default sound rather than going silent.
    playNotificationSound();
    return;
  }
  if (ctx.state === "suspended") {
    // Resume the context BEFORE scheduling — firing resume() fire-and-forget and
    // scheduling immediately drops the first tone while the context is still
    // suspended. If resume rejects, fall back to the default mp3 instead.
    ctx
      .resume()
      .then(() => {
        scheduleTones(ctx, choice);
        return undefined;
      })
      .catch(() => {
        playNotificationSound();
      });
    return;
  }
  scheduleTones(ctx, choice);
}

// Schedule the chosen tone recipe relative to the context's current time.
function scheduleTones(ctx: AudioContext, choice: Exclude<NamedSound, "default" | "none">): void {
  const now = ctx.currentTime;
  for (const [freq, offset] of TONES[choice]) {
    blip(ctx, freq, now + offset, 0.22);
  }
}
