// Single source of truth for compact relative-time labels. Six panes each used
// to reimplement this with slightly different thresholds and wording (#527):
// ActivityPane.formatTime, LogsPane.relativeTime, HomePane/AuditPane/ThreadsPane/
// MemoryPane.timeAgo. This unifies them onto one threshold table so the wording
// is consistent across the app.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// Calendar-agnostic approximations — good enough for coarse "Xmo / Xy ago"
// buckets where exact month/year boundaries don't matter.
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Compact, human relative time for a past instant.
 *
 * @param input ISO string, epoch milliseconds, or a Date. Nullable inputs are
 *              accepted (e.g. a never-seen `lastSeen`) and yield `""`.
 * @param now   Reference "now" in epoch ms — injectable so unit tests are
 *              deterministic; defaults to `Date.now()`.
 * @returns e.g. `"just now"`, `"5m ago"`, `"3h ago"`, `"2d ago"`, `"4w ago"`,
 *          `"5mo ago"`, `"2y ago"`. Future instants clamp to `"just now"`.
 *          Returns `""` for a nullish or unparseable input so callers render
 *          nothing rather than `"NaN ago"`.
 */
export function relativeTime(
  input: string | number | Date | null | undefined,
  now: number = Date.now(),
): string {
  // Guard nullish first: `new Date(null).getTime()` is 0 (a finite number), so
  // without this a null slips past the isFinite check and renders a bogus
  // "56y ago" instead of nothing.
  if (input == null) return "";
  const then = input instanceof Date ? input.getTime() : new Date(input).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Math.max(0, now - then); // clamp future timestamps to "just now"
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < WEEK) return `${Math.floor(diff / DAY)}d ago`;
  if (diff < MONTH) return `${Math.floor(diff / WEEK)}w ago`;
  if (diff < YEAR) return `${Math.floor(diff / MONTH)}mo ago`;
  return `${Math.floor(diff / YEAR)}y ago`;
}
