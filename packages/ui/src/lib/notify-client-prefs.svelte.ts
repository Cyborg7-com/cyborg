// Client-only notification preferences (DND, custom highlight keywords,
// per-channel "ignore @channel/@here/@all", per-channel sound). These never
// leave the device — they gate the CLIENT notify policy + sound only, so they
// live in localStorage rather than the server-backed notifPrefsState (which
// drives muting / mentions_only across devices).
//
// Persistence mirrors UserStatusState: a per-user localStorage key bound on
// login (bindUser) so a shared device doesn't bleed one user's prefs into
// another's. All getters are Svelte 5 runes so settings UI + the policy context
// builder react to changes.

const BASE = "cyborg7_notify_client_prefs";

export type SoundChoice = "default" | "bell" | "chime" | "ding" | "none";

// The selectable per-channel sounds. "default" reuses the global notification
// sound; "none" plays nothing; the rest are Web Audio-synthesized tones so no
// asset hosting is required (see notify-sound.ts playNamedSound).
export const SOUND_CHOICES: readonly { value: SoundChoice; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "bell", label: "Bell" },
  { value: "chime", label: "Chime" },
  { value: "ding", label: "Ding" },
  { value: "none", label: "None" },
];

// Valid sound keys, derived from SOUND_CHOICES so the runtime guard never drifts
// from the selectable list.
const SOUND_CHOICE_VALUES = new Set<string>(SOUND_CHOICES.map((s) => s.value));

function isSoundChoice(value: unknown): value is SoundChoice {
  return typeof value === "string" && SOUND_CHOICE_VALUES.has(value);
}

interface PersistShape {
  dnd?: boolean;
  keywords?: string[];
  ignoreBroadcast?: Record<string, boolean>;
  channelSound?: Record<string, SoundChoice>;
}

export class NotifyClientPrefsState {
  // Do Not Disturb: suppress every client banner/sound except personal mentions.
  dnd = $state(false);
  // Custom highlight keywords (whole-word, case-insensitive) that count as a
  // notify-worthy mention beyond @username.
  keywords: string[] = $state([]);
  // channelId -> true when that channel ignores @channel/@here/@all.
  ignoreBroadcast: Record<string, boolean> = $state({});
  // channelId -> per-channel notification sound choice.
  channelSound: Record<string, SoundChoice> = $state({});

  private _boundUserId: string | null = null;

  private get storageKey(): string {
    return this._boundUserId ? `${BASE}_${this._boundUserId}` : BASE;
  }

  bindUser(userId: string): void {
    this._boundUserId = userId;
    this.dnd = false;
    this.keywords = [];
    this.ignoreBroadcast = {};
    this.channelSound = {};
    this.load();
  }

  clearLocal(): void {
    this._boundUserId = null;
    this.dnd = false;
    this.keywords = [];
    this.ignoreBroadcast = {};
    this.channelSound = {};
  }

  // ─── Do Not Disturb ───────────────────────────────────────────────
  setDnd(active: boolean): void {
    this.dnd = active;
    this.persist();
  }

  toggleDnd(): void {
    this.setDnd(!this.dnd);
  }

  // ─── Custom highlight keywords ────────────────────────────────────
  addKeyword(raw: string): void {
    const kw = raw.trim();
    if (!kw) return;
    // Case-insensitive de-dupe so "Urgent" and "urgent" don't both land.
    const exists = this.keywords.some((k) => k.toLowerCase() === kw.toLowerCase());
    if (exists) return;
    this.keywords = [...this.keywords, kw];
    this.persist();
  }

  removeKeyword(kw: string): void {
    this.keywords = this.keywords.filter((k) => k !== kw);
    this.persist();
  }

  // ─── Per-channel ignore @channel/@here/@all ───────────────────────
  ignoreBroadcastFor(channelId: string): boolean {
    return this.ignoreBroadcast[channelId] ?? false;
  }

  setIgnoreBroadcast(channelId: string, ignore: boolean): void {
    const next = { ...this.ignoreBroadcast };
    if (ignore) next[channelId] = true;
    else delete next[channelId];
    this.ignoreBroadcast = next;
    this.persist();
  }

  toggleIgnoreBroadcast(channelId: string): void {
    this.setIgnoreBroadcast(channelId, !this.ignoreBroadcastFor(channelId));
  }

  // ─── Per-channel sound ────────────────────────────────────────────
  soundFor(channelId: string): SoundChoice {
    return this.channelSound[channelId] ?? "default";
  }

  setChannelSound(channelId: string, choice: SoundChoice): void {
    const next = { ...this.channelSound };
    if (choice === "default") delete next[channelId];
    else next[channelId] = choice;
    this.channelSound = next;
    this.persist();
  }

  private persist(): void {
    try {
      const payload: PersistShape = {
        dnd: this.dnd,
        keywords: this.keywords,
        ignoreBroadcast: this.ignoreBroadcast,
        channelSound: this.channelSound,
      };
      localStorage.setItem(this.storageKey, JSON.stringify(payload));
    } catch {
      // Private mode / quota — prefs stay in-memory for the session.
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      // Persisted JSON is untrusted (older versions, hand-edited localStorage):
      // validate each field at runtime and drop anything malformed rather than
      // blind-casting `as PersistShape`.
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      const data = parsed as Record<string, unknown>;

      this.dnd = data.dnd === true;

      this.keywords = Array.isArray(data.keywords)
        ? data.keywords.filter((k): k is string => typeof k === "string")
        : [];

      const ignoreBroadcast: Record<string, boolean> = {};
      if (data.ignoreBroadcast && typeof data.ignoreBroadcast === "object") {
        for (const [channelId, value] of Object.entries(
          data.ignoreBroadcast as Record<string, unknown>,
        )) {
          if (typeof value === "boolean") ignoreBroadcast[channelId] = value;
        }
      }
      this.ignoreBroadcast = ignoreBroadcast;

      const channelSound: Record<string, SoundChoice> = {};
      if (data.channelSound && typeof data.channelSound === "object") {
        for (const [channelId, value] of Object.entries(
          data.channelSound as Record<string, unknown>,
        )) {
          if (isSoundChoice(value)) channelSound[channelId] = value;
        }
      }
      this.channelSound = channelSound;
    } catch {
      // Corrupt payload — start clean.
    }
  }
}

export const notifyClientPrefsState = new NotifyClientPrefsState();
