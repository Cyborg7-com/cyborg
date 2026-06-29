// Pure, DOM-free month/week grid math for the Tasks CALENDAR layout (Plane's
// calendar-chart). It builds the 6-week × 7-day grid a month view renders:
// every cell carries its date, its day-of-month number, whether it belongs to
// the displayed month (vs the leading/trailing spill days), and whether it is
// today. Kept pure (no Svelte, no `Date.now()` baked in — `today` is injectable)
// so the grid is unit-testable without mounting a component, exactly like due.ts
// and view.ts.
//
// Plane's month grid always shows 6 full weeks (42 cells) so the grid height is
// stable as the user pages month to month and a long month never clips. Weeks
// start on SUNDAY (Plane's default first-day-of-week), so the weekday header is
// Sun … Sat and the leading spill fills back to the Sunday on/before the 1st.

// One cell of the month grid: a single calendar day.
export interface CalendarDay {
  // Local midnight epoch-ms for this day — the canonical key + the value a
  // dropped chip writes as its new dueAt (see dayKey / endOfDay below).
  date: number;
  // 1..31 — the number rendered in the tile's corner.
  dayOfMonth: number;
  // True when the day falls inside the month being displayed; false for the
  // leading/trailing spill days that fill the first/last partial weeks. The UI
  // dims out-of-month tiles (calDayOutMonth).
  inMonth: boolean;
  // True when this day is "today" (same local Y/M/D as the injected `today`).
  isToday: boolean;
}

// A row of the grid: seven consecutive days, Sunday → Saturday.
export type CalendarWeek = CalendarDay[];

// The full month view model.
export interface CalendarMonth {
  // The displayed month, normalized to its 1st at local midnight (the anchor the
  // header label + prev/next paging derive from).
  monthStart: number;
  // 0..11 — the displayed month's index (the month whose days have inMonth=true).
  month: number;
  // The displayed month's full year.
  year: number;
  // Six weeks of seven days = the 42-cell grid (stable height month to month).
  weeks: CalendarWeek[];
}

// Weekday header labels, Sunday-first (matches the Sunday-first week layout).
export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Local midnight (start of day) for a timestamp. The canonical per-day key: two
// timestamps on the same local calendar day collapse to the same value, so it's
// what we group tasks by and what `dayKey` compares against.
export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Local END of day (23:59:59.999). When a chip is dropped on a tile we persist
// dueAt as the END of that day so the task stays "due that day" rather than at
// 00:00 (matching how due dates read as a deadline, and the detail card's
// end-of-day convention in detail.ts).
export function endOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

// Stable per-day string key for grouping tasks into tiles / keying an #each.
export function dayKey(ts: number): string {
  const d = new Date(ts);
  // Local Y-M-D so two times on the same calendar day share a key regardless of
  // the time-of-day component.
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Are two timestamps on the same local calendar day?
export function isSameDay(a: number, b: number): boolean {
  return dayKey(a) === dayKey(b);
}

// Build the month grid that contains `anchor`. Always six weeks, Sunday-first,
// with leading/trailing spill days marked inMonth=false. `today` is injectable
// for deterministic tests (defaults to now).
export function buildMonth(anchor: number, today: number = Date.now()): CalendarMonth {
  const a = new Date(anchor);
  const year = a.getFullYear();
  const month = a.getMonth();

  const first = new Date(year, month, 1);
  first.setHours(0, 0, 0, 0);
  const monthStart = first.getTime();

  // Walk back to the Sunday on or before the 1st (getDay(): 0 = Sunday).
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - first.getDay());
  gridStart.setHours(0, 0, 0, 0);

  const todayStart = startOfDay(today);

  const weeks: CalendarWeek[] = [];
  const cursor = new Date(gridStart);
  // 6 weeks × 7 days = a fixed 42-cell grid (stable height across months).
  for (let w = 0; w < 6; w++) {
    const week: CalendarWeek = [];
    for (let d = 0; d < 7; d++) {
      cursor.setHours(0, 0, 0, 0);
      const date = cursor.getTime();
      week.push({
        date,
        dayOfMonth: cursor.getDate(),
        inMonth: cursor.getMonth() === month,
        isToday: date === todayStart,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }

  return { monthStart, month, year, weeks };
}

// The 1st of the month before `anchor`'s month (drives the calendar's "prev").
export function prevMonth(anchor: number): number {
  const d = new Date(anchor);
  return new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
}

// The 1st of the month after `anchor`'s month (drives the calendar's "next").
export function nextMonth(anchor: number): number {
  const d = new Date(anchor);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

// The 1st of the month containing `today` (drives the calendar's "Today").
export function thisMonth(today: number = Date.now()): number {
  const d = new Date(today);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

// Human-readable header label for the displayed month ("June 2026").
export function monthLabel(month: CalendarMonth): string {
  return new Date(month.monthStart).toLocaleDateString([], { month: "long", year: "numeric" });
}

// Bucket tasks by the local calendar day of their dueAt. Tasks with no dueAt are
// returned separately as the "unscheduled" set (the calendar does not place
// them on the grid). Pure: takes a `dueAt` accessor so it stays Task-shape
// agnostic and trivially unit-testable.
export function bucketByDay<T>(
  items: T[],
  getDue: (item: T) => number | null | undefined,
): { byDay: Map<string, T[]>; unscheduled: T[] } {
  const byDay = new Map<string, T[]>();
  const unscheduled: T[] = [];
  for (const item of items) {
    const due = getDue(item);
    if (due == null) {
      unscheduled.push(item);
      continue;
    }
    const key = dayKey(due);
    const list = byDay.get(key);
    if (list) list.push(item);
    else byDay.set(key, [item]);
  }
  return { byDay, unscheduled };
}
