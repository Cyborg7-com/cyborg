// Unit tests for the PURE gantt timeline math. No DOM; `now` is injected so the
// range padding + today line are deterministic regardless of the wall clock.
import { describe, expect, it } from "vitest";
import {
  addDays,
  barGeometry,
  chartWidthPx,
  DEFAULT_DAY_WIDTH,
  daysBetween,
  dayLeftPx,
  ganttDayTicks,
  ganttMonthBands,
  ganttRange,
  type GanttTaskInput,
  pxToDay,
  startOfDay,
  taskSpan,
} from "./gantt.js";

// A fixed local-midnight anchor (a date with no time component so startOfDay is
// a no-op on it). Using local Date construction keeps the tests TZ-agnostic: the
// math floors to LOCAL midnight, so building the fixtures with local Dates makes
// the assertions hold in any runtime timezone.
const JUN15 = new Date(2026, 5, 15).getTime(); // 2026-06-15 local midnight
const DW = DEFAULT_DAY_WIDTH;

function t(id: string, startDate: number | null, dueAt: number | null): GanttTaskInput {
  return { id, startDate, dueAt };
}

describe("startOfDay / addDays / daysBetween", () => {
  it("floors to local midnight", () => {
    const noon = new Date(2026, 5, 15, 12, 30, 45).getTime();
    expect(startOfDay(noon)).toBe(JUN15);
  });
  it("addDays moves whole days and re-floors", () => {
    expect(addDays(JUN15, 3)).toBe(new Date(2026, 5, 18).getTime());
    expect(addDays(JUN15, -5)).toBe(new Date(2026, 5, 10).getTime());
  });
  it("daysBetween counts whole days inclusive of time-of-day", () => {
    expect(daysBetween(JUN15, addDays(JUN15, 4))).toBe(4);
    const startNoon = new Date(2026, 5, 15, 12).getTime();
    const endMorning = new Date(2026, 5, 18, 3).getTime();
    expect(daysBetween(startNoon, endMorning)).toBe(3);
  });
});

describe("taskSpan", () => {
  it("is null when the task has neither date", () => {
    expect(taskSpan(t("a", null, null))).toBeNull();
  });
  it("uses [start, due] when both present", () => {
    const span = taskSpan(t("a", JUN15, addDays(JUN15, 3)))!;
    expect(span.startMs).toBe(JUN15);
    expect(span.endMs).toBe(addDays(JUN15, 3));
    expect(span.dueOnly).toBe(false);
  });
  it("swaps an inverted start-after-due so width is never negative", () => {
    const span = taskSpan(t("a", addDays(JUN15, 3), JUN15))!;
    expect(span.startMs).toBe(JUN15);
    expect(span.endMs).toBe(addDays(JUN15, 3));
  });
  it("is a single due-only day when only dueAt is set", () => {
    const span = taskSpan(t("a", null, JUN15))!;
    expect(span.startMs).toBe(JUN15);
    expect(span.endMs).toBe(JUN15);
    expect(span.dueOnly).toBe(true);
  });
  it("is a single day when only startDate is set", () => {
    const span = taskSpan(t("a", JUN15, null))!;
    expect(span.startMs).toBe(JUN15);
    expect(span.endMs).toBe(JUN15);
    expect(span.dueOnly).toBe(false);
  });
});

describe("ganttRange", () => {
  it("centers on today (± pad) when no task has a date", () => {
    const r = ganttRange([t("a", null, null)], JUN15);
    expect(r.startMs).toBe(addDays(JUN15, -7));
    expect(r.endMs).toBe(addDays(JUN15, 7));
    expect(r.dayCount).toBe(15);
  });
  it("pads 7 days around the min/max of dated tasks", () => {
    const r = ganttRange([t("a", JUN15, addDays(JUN15, 10))], JUN15);
    expect(r.startMs).toBe(addDays(JUN15, -7));
    expect(r.endMs).toBe(addDays(JUN15, 17));
  });
  it("always includes today even when all tasks are far in the future", () => {
    const far = addDays(JUN15, 100);
    const r = ganttRange([t("a", far, far)], JUN15);
    // today (JUN15) is below the task min, so the start pads from today.
    expect(r.startMs).toBe(addDays(JUN15, -7));
    expect(r.endMs).toBe(addDays(far, 7));
  });
});

describe("ganttDayTicks", () => {
  it("emits one tick per day with a correct index and today flag", () => {
    const r = ganttRange([t("a", JUN15, JUN15)], JUN15);
    const ticks = ganttDayTicks(r, JUN15);
    expect(ticks.length).toBe(r.dayCount);
    expect(ticks[0].index).toBe(0);
    expect(ticks[0].ms).toBe(r.startMs);
    const today = ticks.find((x) => x.isToday)!;
    expect(today.ms).toBe(JUN15);
    expect(today.day).toBe(15);
  });
  it("flags weekends", () => {
    const r = ganttRange([t("a", JUN15, JUN15)], JUN15);
    const ticks = ganttDayTicks(r, JUN15);
    for (const tick of ticks) {
      const dow = new Date(tick.ms).getDay();
      expect(tick.isWeekend).toBe(dow === 0 || dow === 6);
    }
  });
});

describe("ganttMonthBands", () => {
  it("groups consecutive days into month bands aligned to the day cells", () => {
    // A range that straddles a month boundary (late June into July).
    const r = ganttRange(
      [t("a", new Date(2026, 5, 25).getTime(), new Date(2026, 6, 5).getTime())],
      JUN15,
    );
    const bands = ganttMonthBands(r, DW);
    // Sum of band widths equals the whole chart width.
    const total = bands.reduce((s, b) => s + b.widthPx, 0);
    expect(total).toBe(chartWidthPx(r, DW));
    // Bands are contiguous: each starts where the previous ended.
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i].leftPx).toBe(bands[i - 1].leftPx + bands[i - 1].widthPx);
    }
    // At least two months present (June + July).
    expect(bands.length).toBeGreaterThanOrEqual(2);
    expect(bands.some((b) => b.label.startsWith("Jun"))).toBe(true);
    expect(bands.some((b) => b.label.startsWith("Jul"))).toBe(true);
  });
});

describe("barGeometry", () => {
  it("is null for a task with no dates", () => {
    const r = ganttRange([t("a", JUN15, JUN15)], JUN15);
    expect(barGeometry(t("b", null, null), r, DW)).toBeNull();
  });
  it("a single-day due-only task is exactly one column wide", () => {
    const r = ganttRange([t("a", null, JUN15)], JUN15);
    const g = barGeometry(t("a", null, JUN15), r, DW)!;
    expect(g.widthPx).toBe(DW);
    expect(g.dueOnly).toBe(true);
    expect(g.leftPx).toBe(dayLeftPx(JUN15, r, DW));
  });
  it("an inclusive [start..due] span covers (end-start+1) columns", () => {
    const due = addDays(JUN15, 4);
    const r = ganttRange([t("a", JUN15, due)], JUN15);
    const g = barGeometry(t("a", JUN15, due), r, DW)!;
    expect(g.widthPx).toBe(5 * DW); // 15..19 inclusive = 5 days
    expect(g.leftPx).toBe(daysBetween(r.startMs, JUN15) * DW);
  });
});

describe("pxToDay / dayLeftPx round-trip", () => {
  it("dayLeftPx then pxToDay returns the same day", () => {
    const r = ganttRange([t("a", JUN15, addDays(JUN15, 10))], JUN15);
    const target = addDays(JUN15, 3);
    const px = dayLeftPx(target, r, DW);
    expect(pxToDay(px, r, DW)).toBe(target);
    // A px in the middle of the column still resolves to that day.
    expect(pxToDay(px + DW / 2, r, DW)).toBe(target);
  });
  it("pxToDay clamps out-of-range px to the first / last day", () => {
    const r = ganttRange([t("a", JUN15, JUN15)], JUN15);
    expect(pxToDay(-9999, r, DW)).toBe(r.startMs);
    expect(pxToDay(9_999_999, r, DW)).toBe(r.endMs);
  });
});

describe("chartWidthPx", () => {
  it("is dayCount * dayWidth", () => {
    const r = ganttRange([t("a", JUN15, addDays(JUN15, 3))], JUN15);
    expect(chartWidthPx(r, DW)).toBe(r.dayCount * DW);
  });
});
