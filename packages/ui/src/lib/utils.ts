import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// Deterministic avatar color from a name (workspaces, etc.). Shared so the same
// name resolves to the same swatch everywhere (rail switcher ⇄ profile menu),
// instead of each component keeping its own palette + hash and drifting.
const AVATAR_PALETTE = [
  "#4F46E5",
  "#0891B2",
  "#0D9488",
  "#D97706",
  "#DC2626",
  "#7C3AED",
  "#2563EB",
  "#DB2777",
  "#0D9488",
  "#EA580C",
];

export function nameToColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

// True when running inside the Electron desktop shell. The shell exposes the
// `window.cyborg7Desktop` bridge (see state/app.svelte.ts); a plain browser
// never has it. Used to skip the web-only "download the desktop app" gate for
// users who are already in the desktop app.
export function isDesktopApp(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as unknown as { cyborg7Desktop?: unknown }).cyborg7Desktop
  );
}

// True on macOS / iOS, where the platform "command" key is ⌘ rather than Ctrl.
// Used to render the correct modifier glyph in keyboard hints (⌘K vs Ctrl+K).
// Guards `navigator` so it stays SSR-safe (returns false during prerender).
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  return (
    /mac|iphone|ipad|ipod/i.test(platform) || /mac|iphone|ipad|ipod/i.test(navigator.userAgent)
  );
}

// Render a keyboard shortcut with platform-correct modifier glyphs. Pass the
// "logical" combo with a "Mod" placeholder for the command/control key, e.g.
// formatShortcut("Mod+K") → "⌘K" on macOS, "Ctrl+K" elsewhere.
export function formatShortcut(combo: string): string {
  const mac = isMac();
  return combo
    .split("+")
    .map((part) => {
      const key = part.trim();
      switch (key.toLowerCase()) {
        case "mod":
          return mac ? "⌘" : "Ctrl";
        case "shift":
          return mac ? "⇧" : "Shift";
        case "alt":
        case "option":
          return mac ? "⌥" : "Alt";
        case "ctrl":
        case "control":
          return mac ? "⌃" : "Ctrl";
        case "enter":
          return "↵";
        case "esc":
        case "escape":
          return "Esc";
        case "up":
          return "↑";
        case "down":
          return "↓";
        default:
          return key.length === 1 ? key.toUpperCase() : key;
      }
    })
    .join(mac ? "" : "+");
}

export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, "child"> : T;
export type WithoutChildren<T> = T extends { children?: unknown } ? Omit<T, "children"> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };

// Clock time for a timestamp, e.g. "3:04 PM". The single source of truth for
// HH:MM rendering across messages — components used to inline
// `toLocaleTimeString(..., { hour: "numeric", minute: "2-digit" })` per call.
export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

// Day divider label: "Today" / "Yesterday" / weekday (this week) / short date.
// Used for the date separators in MessageList and ThreadPanel.
export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86_400_000);

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) {
    return date.toLocaleDateString(undefined, { weekday: "long" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// True when both timestamps fall on the same calendar day (local time). Shared
// so date-separator logic doesn't re-derive it via `toDateString()` comparisons.
export function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

// Smart message timestamp for search results: time today, "Yesterday HH:MM",
// else "Mon D HH:MM". Single source for the search-result timestamp that
// MessageSearch and MobileSearchOverlay both rendered identically.
export function formatMessageTimestamp(timestamp: number): string {
  const d = new Date(timestamp);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // Round, not floor: both are local-midnight dates, but a DST transition makes a
  // calendar day 23h/25h, so the raw ratio is 0.958/1.04 — floor would label
  // yesterday as today on a "spring forward" day. Round snaps to the day count.
  const days = Math.round((today.getTime() - msgDate.getTime()) / 86_400_000);
  const time = formatTime(timestamp);
  if (days === 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

// Human-readable byte size, e.g. "820 B" / "3.4 MB" / "2 GB". Whole or ≥10
// values round; otherwise one decimal. Single source for attachment/file sizes
// (ChatMessage, MessageInput, SharedFilesPanel, ChannelFilesList).
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// Media duration as "m:ss" (e.g. "0:07", "3:42"). Single source for audio/video
// players (VoicePlayer, VideoPlayer, ComposerVoiceRecorder).
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

// The ONE rule for "what kind of thing is this avatar string?". A cybo avatar
// is either an image URL or a single emoji; everything (no avatar, a plain
// name) otherwise falls back to initials. This used to be re-derived per
// surface with two divergent regexes — the chat-header/CyboSessionAvatar path
// used `/^\p{Emoji}/u` + a URL guard, while the AgentsPane roster used an
// anchored `/^\p{Emoji}$/u`. The anchored one only matches a SINGLE code unit,
// so multi-codepoint emoji (flags like 🇲🇽, ZWJ sequences like 👨‍👩‍👧) were
// rejected and rendered as a broken photo/icon in the roster while the header
// showed the emoji. We standardize on the careful, URL-guarded rule:
//
//   emoji  ⇢ starts with an Emoji code point AND does not start like a URL/path
//            (`http…`, a slug, `:emoji:`, a relative `/path`, a `data:`/`blob:`
//            URI — all begin with `[a-z0-9/:.]`, and some flag/keycap emoji are
//            themselves `\p{Emoji}` digits, so the guard is what disambiguates).
//   image  ⇢ a non-empty avatar that isn't an emoji (treated as a URL).
//   initials ⇢ no avatar at all → initials of `name`.
//
// `\p{Emoji}` (no `$` anchor) deliberately matches the WHOLE emoji including
// multi-codepoint sequences, fixing the roster drift. Pure function — safe to
// unit test and to call from both `.svelte` and `.ts`.
export type AvatarSourceKind = "image" | "emoji" | "initials";
export interface AvatarSource {
  kind: AvatarSourceKind;
  // image → the URL; emoji → the emoji string; initials → the 1–2 letter glyph.
  value: string;
}

function isEmojiAvatar(avatar: string): boolean {
  // The URL guard rejects anything that *starts* like a URL/path/slug/data-URI
  // (`[a-z/:.]`). Bare digits are trickier: a leading `0-9` usually means a
  // path/filename (`0abc.png`, `10.png`) → image, BUT digit keycap emoji
  // (`0️⃣`…`9️⃣`) are an ASCII digit + U+FE0F? + U+20E3 and ARE emoji. So we
  // only treat a leading digit as URL-ish when it is NOT a keycap sequence.
  return /^\p{Emoji}/u.test(avatar) && !/^(?:[a-z/:.]|[0-9](?!️?⃣))/i.test(avatar);
}

export function resolveAvatarSource(avatar: string | null | undefined, name: string): AvatarSource {
  if (avatar) {
    if (isEmojiAvatar(avatar)) return { kind: "emoji", value: avatar };
    return { kind: "image", value: avatar };
  }
  return { kind: "initials", value: getInitials(name || "?") };
}

export function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: unknown[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

// Leading-edge throttle (Mattermost pattern): fires immediately on the first
// call, then suppresses further calls until `ms` has elapsed since the last
// invocation. Unlike `debounce`, this keeps emitting while the caller is
// active — used for live typing indicators that must refresh before expiry.
export function throttle<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let lastCalled = 0;
  return ((...args: unknown[]) => {
    const now = Date.now();
    if (now - lastCalled >= ms) {
      lastCalled = now;
      fn(...args);
    }
  }) as T;
}
