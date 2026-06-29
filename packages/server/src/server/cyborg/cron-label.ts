// cronToLabel — a friendly cadence string for a 5-field cron expression, for the
// per-task "schedule chip" (e.g. "Every day 9:00", "Weekdays 9am", "Every hour").
//
// The runner reuses Paseo's cron engine (schedule/cron.ts) for EXECUTION; this is
// purely a DISPLAY helper for the common cadences the schedule UI emits. There is
// no `rateToCron` table in this fork to invert (the v1 `rate(N unit)` form lives in
// task-dispatch.ts and is a SEPARATE, unrelated recurrence concept), so this is a
// small standalone formatter. Anything it can't pretty-print falls back to the raw
// cron string, so the chip is never empty and never wrong.
//
// Format only — it does NOT validate; validateScheduleCadence (cron.ts) is the gate.

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Render an hour:minute as a friendly clock string. Whole hours read as "9am" /
// "5pm"; anything with minutes reads as 24h "HH:MM" (unambiguous, locale-free).
function formatTime(hour: number, minute: number): string {
  if (minute === 0) {
    if (hour === 0) return "midnight";
    if (hour === 12) return "noon";
    const h12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${h12}${hour < 12 ? "am" : "pm"}`;
  }
  return `${hour}:${String(minute).padStart(2, "0")}`;
}

// Parse a single numeric cron field (no lists/ranges/steps). Returns null when the
// field isn't a plain integer, so the caller falls back to the raw expression.
function parseInt0(field: string): number | null {
  if (!/^\d+$/.test(field)) return null;
  const n = Number.parseInt(field, 10);
  return Number.isInteger(n) ? n : null;
}

/**
 * A friendly cadence label for a cron expression. Falls back to the raw `cronExpr`
 * for anything outside the handled common shapes (lists, ranges, multi-step, etc.).
 *
 * `timezone` (IANA, e.g. "America/New_York") is appended in parentheses when set,
 * since the wall-clock time only makes sense paired with its zone.
 */
export function cronToLabel(cronExpr: string, timezone?: string | null): string {
  const raw = cronExpr.trim();
  const parts = raw.split(/\s+/);
  const tzSuffix = timezone ? ` (${timezone})` : "";
  if (parts.length !== 5) return raw;

  const [minF, hourF, domF, monF, dowF] = parts;

  // Every minute / every N minutes.
  if (minF === "*" && hourF === "*" && domF === "*" && monF === "*" && dowF === "*") {
    return "Every minute";
  }
  const minStep = minF.match(/^\*\/(\d+)$/);
  if (minStep && hourF === "*" && domF === "*" && monF === "*" && dowF === "*") {
    return `Every ${minStep[1]} minutes`;
  }

  // Hourly cadences (fixed minute, any hour).
  const minute = parseInt0(minF);
  if (minute !== null && hourF === "*" && domF === "*" && monF === "*" && dowF === "*") {
    return minute === 0 ? "Every hour" : `Hourly at :${String(minute).padStart(2, "0")}`;
  }

  // Anything below needs a concrete minute + hour.
  const hour = parseInt0(hourF);
  if (minute === null || hour === null) return raw + tzSuffix;
  const time = formatTime(hour, minute);

  // Daily — every day at a fixed time.
  if (domF === "*" && monF === "*" && dowF === "*") {
    return `Every day ${time}${tzSuffix}`;
  }

  // Weekday-set cadences (any day-of-month, any month, a day-of-week constraint).
  if (domF === "*" && monF === "*") {
    if (dowF === "1-5") return `Weekdays ${time}${tzSuffix}`;
    if (dowF === "0,6" || dowF === "6,0") return `Weekends ${time}${tzSuffix}`;
    const dow = parseInt0(dowF);
    if (dow !== null && dow >= 0 && dow <= 6) {
      return `Every ${DOW_NAMES[dow]} ${time}${tzSuffix}`;
    }
  }

  // Monthly — a fixed day-of-month at a fixed time.
  const dom = parseInt0(domF);
  if (dom !== null && monF === "*" && dowF === "*") {
    return `Monthly on the ${dom}${ordinalSuffix(dom)} ${time}${tzSuffix}`;
  }

  return raw + tzSuffix;
}

function ordinalSuffix(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}
