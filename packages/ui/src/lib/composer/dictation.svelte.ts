// Web Speech API dictation helper (#582). Drives a mic button that transcribes
// speech into a composer prompt. Degrades gracefully: `supported` is false when
// the browser lacks SpeechRecognition (Firefox, most in-app/Tauri webviews, SSR)
// so callers simply hide the button — no hard dependency, no crash.

interface SpeechAlternativeLike {
  transcript: string;
}
interface SpeechResultLike {
  isFinal: boolean;
  0: SpeechAlternativeLike;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

type ResultHandler = (e: { results: ArrayLike<SpeechResultLike> }) => void;
type ErrorHandler = (e: { error: string }) => void;
type EndHandler = () => void;

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  addEventListener(type: "result", listener: ResultHandler): void;
  addEventListener(type: "error", listener: ErrorHandler): void;
  addEventListener(type: "end", listener: EndHandler): void;
  removeEventListener(type: "result", listener: ResultHandler): void;
  removeEventListener(type: "error", listener: ErrorHandler): void;
  removeEventListener(type: "end", listener: EndHandler): void;
}

/** The vendor-prefixed or standard SpeechRecognition constructor, or null. */
export function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** True when this browser can do speech-to-text. Callers hide the mic when false. */
export function isDictationSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

/**
 * Fold a SpeechRecognition results list into final + interim text. `results` is
 * cumulative across events, so we always read it from the start. Pure — exported
 * for unit tests.
 */
export function foldTranscript(results: ArrayLike<SpeechResultLike>): {
  final: string;
  interim: string;
} {
  let final = "";
  let interim = "";
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const text = r?.[0]?.transcript ?? "";
    if (r?.isFinal) final += text;
    else interim += text;
  }
  return { final, interim };
}

export interface DictationController {
  /** Whether the browser supports dictation at all (static). */
  readonly supported: boolean;
  /** Whether a recognition session is currently active (reactive). */
  readonly listening: boolean;
  start(): void;
  stop(): void;
  toggle(): void;
  /** Stop + detach handlers; call from onDestroy. */
  dispose(): void;
}

export interface DictationOptions {
  /** Called with the live transcript (final + interim) on each result. */
  onTranscript: (transcript: string) => void;
  /** Called once recognition ends (manual stop, silence timeout, or error). */
  onEnd?: () => void;
  /** Called on a hard error (e.g. "not-allowed" when mic permission denied). */
  onError?: (error: string) => void;
  /** BCP-47 language; defaults to the browser's `navigator.language`. */
  lang?: string;
}

/**
 * Create a dictation controller backed by the Web Speech API. Uses Svelte 5
 * runes for reactive `listening`, so call it during component init.
 */
export function createDictation(options: DictationOptions): DictationController {
  const Ctor = getSpeechRecognitionCtor();
  const supported = Ctor !== null;
  let listening = $state(false);
  let recognition: SpeechRecognitionLike | null = null;
  let onResult: ResultHandler | null = null;
  let onErr: ErrorHandler | null = null;
  let onEnd: EndHandler | null = null;

  function detach(): void {
    if (recognition) {
      if (onResult) recognition.removeEventListener("result", onResult);
      if (onErr) recognition.removeEventListener("error", onErr);
      if (onEnd) recognition.removeEventListener("end", onEnd);
    }
    onResult = null;
    onErr = null;
    onEnd = null;
  }

  function start(): void {
    if (!Ctor || listening) return;
    const rec = new Ctor();
    rec.lang = options.lang ?? (typeof navigator !== "undefined" ? navigator.language : "en-US");
    rec.continuous = true;
    rec.interimResults = true;
    onResult = (e) => {
      const { final, interim } = foldTranscript(e.results);
      options.onTranscript(final + interim);
    };
    onErr = (e) => {
      options.onError?.(e.error);
    };
    onEnd = () => {
      detach();
      listening = false;
      recognition = null;
      options.onEnd?.();
    };
    rec.addEventListener("result", onResult);
    rec.addEventListener("error", onErr);
    rec.addEventListener("end", onEnd);
    recognition = rec;
    try {
      rec.start();
      listening = true;
    } catch {
      // start() throws if called while already started — treat as no-op.
      detach();
      listening = false;
      recognition = null;
    }
  }

  function stop(): void {
    recognition?.stop();
  }

  function toggle(): void {
    if (listening) stop();
    else start();
  }

  function dispose(): void {
    if (recognition) {
      detach();
      recognition.abort();
      recognition = null;
    }
    listening = false;
  }

  return {
    get supported() {
      return supported;
    },
    get listening() {
      return listening;
    },
    start,
    stop,
    toggle,
    dispose,
  };
}
