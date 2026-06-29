// #619 — recurrence helpers for the Tasks-tab recurring schedules. The server's
// ScheduleRunner is CRON-ONLY, so the friendly "Every N hours/days/weeks" builder
// (mirroring the original TasksBoard's rate(N unit) recurrence) is translated to a
// standard 5-field cron expression here before being sent to createSchedule().

export type RateUnit = "hour" | "day" | "week";

// Translate a rate(N unit) cadence into a 5-field cron expression
// (minute hour day-of-month month day-of-week):
//   every N hours  → "0 */N * * *"   (top of the hour, every Nth hour)
//   every N days   → "0 9 */N * *"   (09:00, every Nth day)
//   every N weeks  → "0 9 * * 1"     (09:00 Monday; cron has no native "every Nth
//                                      week", so weekly anchors to Monday — N is
//                                      clamped to 1 for the expression)
// N is coerced to a positive integer (>= 1) to keep the cron field valid.
export function rateToCron(n: number, unit: RateUnit): string {
  const step = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
  switch (unit) {
    case "hour":
      return step === 1 ? "0 * * * *" : `0 */${step} * * *`;
    case "day":
      return step === 1 ? "0 9 * * *" : `0 9 */${step} * *`;
    case "week":
      // Cron lacks an "every Nth week" field; weekly schedules anchor to Monday.
      return "0 9 * * 1";
  }
}

// A SHORT, friendly cadence label for the per-task schedule CHIP (e.g.
// "Every day 9:00", "Every hour", "Weekdays 9:00", "Every week"). Parses the
// 5-field cron we emit plus a few common shapes; falls back to describeCron (and
// ultimately the raw expression) so an unrecognized cron is still shown, never
// hidden. The timezone is accepted for signature symmetry with the server's
// cronToLabel and so a future variant can localize the time; it is not rendered
// into the short chip label today (the cadence already reads unambiguously).
const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatHm(hour: number, minute: number): string {
  const h = ((hour % 24) + 24) % 24;
  const m = ((minute % 60) + 60) % 60;
  return `${h}:${m.toString().padStart(2, "0")}`;
}

export function cronToLabel(cronExpr: string, _timezone?: string | null): string {
  const expr = cronExpr.trim();
  const parts = expr.split(/\s+/);
  // Only the standard 5-field form is parsed here; anything else degrades to the
  // longer describeCron() recognizer (then the raw string).
  if (parts.length !== 5) return describeCron(expr);
  const [min, hr, dom, mon, dow] = parts;

  // Every minute / every hour (no fixed clock time).
  if (expr === "* * * * *") return "Every minute";
  if (min === "0" && hr === "*" && dom === "*" && mon === "*" && dow === "*") return "Every hour";
  const hourStep = expr.match(/^0 \*\/(\d+) \* \* \*$/);
  if (hourStep) return `Every ${hourStep[1]} hours`;

  const minute = Number(min);
  const hour = Number(hr);
  const fixedTime = Number.isInteger(minute) && Number.isInteger(hour);

  // Daily at a fixed time, every Nth day, weekday/weekend, or a single weekday.
  if (fixedTime && mon === "*") {
    const time = formatHm(hour, minute);
    if (dom === "*" && dow === "*") return `Every day ${time}`;
    const dayStep = dom.match(/^\*\/(\d+)$/);
    if (dayStep && dow === "*") return `Every ${dayStep[1]} days ${time}`;
    if (dom === "*") {
      if (dow === "1-5") return `Weekdays ${time}`;
      if (dow === "0,6" || dow === "6,0") return `Weekends ${time}`;
      const single = Number(dow);
      if (Number.isInteger(single) && single >= 0 && single <= 6) {
        return `Every ${DOW_NAMES[single]} ${time}`;
      }
      return `Weekly ${time}`;
    }
    // Monthly on a fixed day-of-month.
    const day = Number(dom);
    if (Number.isInteger(day) && dow === "*") {
      // English ordinal suffix: the teens (11-13) are always "th"; otherwise the
      // last digit picks st/nd/rd/th. The naive 1/2/3-only form mis-formatted
      // 21→21th, 22→22th, 23→23th, 31→31th.
      const suffix =
        day % 100 >= 11 && day % 100 <= 13
          ? "th"
          : (["th", "st", "nd", "rd", "th", "th", "th", "th", "th", "th"][day % 10] ?? "th");
      return `Monthly on the ${day}${suffix} ${time}`;
    }
  }

  return describeCron(expr);
}

// Best-effort human label for a cron expression in the schedule list. Recognises
// the shapes rateToCron() emits plus a few common ones; otherwise echoes the raw
// expression so nothing is hidden from the user.
export function describeCron(cron: string): string {
  const expr = cron.trim();
  const KNOWN: Record<string, string> = {
    "0 * * * *": "Every hour",
    "0 9 * * *": "Daily at 09:00",
    "0 0 * * *": "Daily at midnight",
    "0 9 * * 1": "Weekly on Monday at 09:00",
    "* * * * *": "Every minute",
  };
  if (KNOWN[expr]) return KNOWN[expr];
  const hourStep = expr.match(/^0 \*\/(\d+) \* \* \*$/);
  if (hourStep) return `Every ${hourStep[1]} hours`;
  const dayStep = expr.match(/^0 9 \*\/(\d+) \* \*$/);
  if (dayStep) return `Every ${dayStep[1]} days at 09:00`;
  return expr;
}
