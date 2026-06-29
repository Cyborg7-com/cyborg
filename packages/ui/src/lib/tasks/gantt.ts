// Pure, DOM-free timeline math for the Tasks GANTT layout (Plane's gantt-chart).
// Everything the <TasksGantt> component needs to lay out its ruler + bars is
// computed here as deterministic functions over plain dates, so the geometry is
// unit-testable without mounting a component. The component is a thin render over
// this model: it maps each day/month tick to a ruler cell and each task bar to an
// absolutely-positioned `{ leftPx, widthPx }` box.
//
// Coordinate model: the timeline is a horizontal strip of fixed-width day
// columns. Day 0 is the chart's first day (range.startMs); a day's left edge is
// `dayIndex * dayWidth`. A task bar spans from its start day's left edge to the
// day AFTER its end day (so a single-day task is exactly one column wide, and an
// inclusive [start..end] span covers end-start+1 columns). `now` is injectable
// everywhere a "today" notion is needed, so tests are deterministic.

// One day in ms. Gantt math is day-granular: timestamps are floored to local
// midnight before being placed, so a bar's left edge always lands on a day grid
// line regardless of the time-of-day component of startDate / dueAt.
const DAY_MS = 86_400_000;

// The default width of one day column, in px. Plane's gantt uses a comfortably
// wide day cell; the component may override this, and all math takes it as a
// parameter so a future zoom control needs no changes here.
export const DEFAULT_DAY_WIDTH = 28;

// Padding (in days) added before the earliest and after the latest dated task so
// bars never butt against the timeline edges and there's room to drag an edge
// outward. Also the fallback span when there are zero dated tasks (today ± pad).
const RANGE_PAD_DAYS = 7;

// The minimal per-task shape the gantt math needs. Decoupled from the full Task
// type on purpose: the math only cares about an id and the two date endpoints,
// so it stays trivially testable and never drifts with unrelated Task fields.
// Both dates are epoch-ms or null. A task with neither date has no bar.
export interface GanttTaskInput {
  id: string;
  startDate: number | null;
  dueAt: number | null;
}

// A single day tick on the bottom ruler tier.
export interface GanttDayTick {
  // Local-midnight epoch-ms of this day (stable key + the value drag math reads).
  ms: number;
  // Day-of-month number (1..31), what the ruler cell prints.
  day: number;
  // Index from the chart's first day (0-based); leftPx = index * dayWidth.
  index: number;
  // True when this day is "today" (local-midnight match against `now`).
  isToday: boolean;
  // True for Saturday/Sunday — the component may tint weekend columns.
  isWeekend: boolean;
}

// A month band on the top ruler tier, spanning the day cells that fall in it.
export interface GanttMonthBand {
  // "Mon YYYY" label (e.g. "Jun 2026").
  label: string;
  // Left edge of the band in px (index of its first day * dayWidth).
  leftPx: number;
  // Width of the band in px (number of its days * dayWidth).
  widthPx: number;
  // Stable key: "YYYY-M" of the band's month.
  key: string;
}

// The resolved chart date range, day-aligned and padded.
export interface GanttRange {
  // Local-midnight epoch-ms of the first day column.
  startMs: number;
  // Local-midnight epoch-ms of the last day column (inclusive).
  endMs: number;
  // Total number of day columns in the chart.
  dayCount: number;
}

// One task's bar geometry, or null when the task has no datable position.
export interface GanttBarGeometry {
  id: string;
  leftPx: number;
  widthPx: number;
  // The effective day-aligned start/end the bar was drawn from (epoch-ms). For a
  // due-only task both equal the due day (a one-column bar at the due date).
  startMs: number;
  endMs: number;
  // True when the task had no startDate (single-day bar anchored at dueAt). The
  // component can style these differently (Plane renders a milestone-ish dot).
  dueOnly: boolean;
}

// Floor an epoch-ms timestamp to local midnight (00:00 in the runtime's TZ). All
// placement is done on these day keys so bars snap to the day grid.
export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Whole-day distance from day `aMs` to day `bMs` (both expected day-aligned).
// Uses date arithmetic rather than dividing the ms delta so it stays correct
// across daylight-saving transitions (a DST day is 23h or 25h, not 24h).
export function daysBetween(aMs: number, bMs: number): number {
  return Math.round((startOfDay(bMs) - startOfDay(aMs)) / DAY_MS);
}

// Pick the gantt-relevant endpoints for a task: a [start, end] inclusive day
// span. Rules (matching the component's bar contract):
//   - both dates present  → [startDate, dueAt] (swapped if inverted so a
//     start-after-due never produces a negative width).
//   - only dueAt          → [dueAt, dueAt] (single-day bar at the due date).
//   - only startDate      → [startDate, startDate] (single-day bar at the start).
//   - neither             → null (no bar; the task still lists in the sidebar).
export function taskSpan(
  task: GanttTaskInput,
): { startMs: number; endMs: number; dueOnly: boolean } | null {
  const hasStart = task.startDate != null;
  const hasDue = task.dueAt != null;
  if (!hasStart && !hasDue) return null;
  if (hasStart && hasDue) {
    const a = startOfDay(task.startDate as number);
    const b = startOfDay(task.dueAt as number);
    return a <= b
      ? { startMs: a, endMs: b, dueOnly: false }
      : { startMs: b, endMs: a, dueOnly: false };
  }
  if (hasDue) {
    const d = startOfDay(task.dueAt as number);
    return { startMs: d, endMs: d, dueOnly: true };
  }
  const s = startOfDay(task.startDate as number);
  return { startMs: s, endMs: s, dueOnly: false };
}

// Compute the day-aligned, padded chart range covering every dated task. When no
// task has a date, the range is `now` ± RANGE_PAD_DAYS so the empty chart still
// renders a sensible ruler with a today line in the middle.
export function ganttRange(tasks: GanttTaskInput[], now: number = Date.now()): GanttRange {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const t of tasks) {
    const span = taskSpan(t);
    if (!span) continue;
    if (span.startMs < min) min = span.startMs;
    if (span.endMs > max) max = span.endMs;
  }
  const today = startOfDay(now);
  if (min === Number.POSITIVE_INFINITY) {
    // No dated tasks — center the range on today.
    min = today;
    max = today;
  }
  // Always include "today" in the range so the today line is visible.
  if (today < min) min = today;
  if (today > max) max = today;
  const startMs = addDays(min, -RANGE_PAD_DAYS);
  const endMs = addDays(max, RANGE_PAD_DAYS);
  return { startMs, endMs, dayCount: daysBetween(startMs, endMs) + 1 };
}

// Add `n` whole days to a day-aligned timestamp via the Date API (DST-safe).
export function addDays(ms: number, n: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Build the bottom-tier day ticks for a range.
export function ganttDayTicks(range: GanttRange, now: number = Date.now()): GanttDayTick[] {
  const today = startOfDay(now);
  const ticks: GanttDayTick[] = [];
  for (let i = 0; i < range.dayCount; i++) {
    const ms = addDays(range.startMs, i);
    const d = new Date(ms);
    const dow = d.getDay();
    ticks.push({
      ms,
      day: d.getDate(),
      index: i,
      isToday: ms === today,
      isWeekend: dow === 0 || dow === 6,
    });
  }
  return ticks;
}

// Month label, e.g. "Jun 2026". Pure (no locale-dependent month index math
// leaks out): uses toLocaleDateString with an explicit short month + year.
function monthLabel(ms: number): string {
  return new Date(ms).toLocaleDateString([], { month: "short", year: "numeric" });
}

// Build the top-tier month bands for a range by grouping consecutive day ticks
// that share a (year, month). Each band's px geometry is derived from the count
// of days in that month that fall within the chart, so the band always lines up
// with its day cells below.
export function ganttMonthBands(range: GanttRange, dayWidth: number): GanttMonthBand[] {
  const bands: GanttMonthBand[] = [];
  for (let i = 0; i < range.dayCount; i++) {
    const ms = addDays(range.startMs, i);
    const d = new Date(ms);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const last = bands[bands.length - 1];
    if (last && last.key === key) {
      last.widthPx += dayWidth;
    } else {
      bands.push({ key, label: monthLabel(ms), leftPx: i * dayWidth, widthPx: dayWidth });
    }
  }
  return bands;
}

// The px x-position of the day containing `ts` (its column's LEFT edge), relative
// to the chart's first day. Used for the today line and for translating a drag's
// pointer x back into a date.
export function dayLeftPx(ts: number, range: GanttRange, dayWidth: number): number {
  return daysBetween(range.startMs, ts) * dayWidth;
}

// Inverse of dayLeftPx: given a pixel x within the timeline, return the local-
// midnight epoch-ms of the day that column represents. Clamped to the range so a
// drag past either edge resolves to the first / last day rather than off-chart.
export function pxToDay(px: number, range: GanttRange, dayWidth: number): number {
  const idx = Math.floor(px / dayWidth);
  const clamped = Math.max(0, Math.min(range.dayCount - 1, idx));
  return addDays(range.startMs, clamped);
}

// Bar geometry for one task within a range. Returns null when the task has no
// date (the sidebar still lists it; the timeline lane stays empty). The bar
// spans from its start day's left edge to the END of its end day (end day's
// left + one column), so an inclusive [start..end] span renders
// (end-start+1) columns and a single day renders exactly one column.
export function barGeometry(
  task: GanttTaskInput,
  range: GanttRange,
  dayWidth: number,
): GanttBarGeometry | null {
  const span = taskSpan(task);
  if (!span) return null;
  const leftPx = dayLeftPx(span.startMs, range, dayWidth);
  const days = daysBetween(span.startMs, span.endMs) + 1;
  return {
    id: task.id,
    leftPx,
    widthPx: days * dayWidth,
    startMs: span.startMs,
    endMs: span.endMs,
    dueOnly: span.dueOnly,
  };
}

// Total chart width in px (every day column). The component sizes its timeline
// inner track to this so the ruler + lanes + bars share one coordinate space.
export function chartWidthPx(range: GanttRange, dayWidth: number): number {
  return range.dayCount * dayWidth;
}
