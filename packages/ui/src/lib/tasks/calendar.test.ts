// Unit tests for the PURE month/week grid math. No DOM; `today` is injected so
// "isToday" is deterministic. Dates are constructed via the local Date ctor so
// the assertions match the local-time grid the lib builds.
import { describe, expect, it } from "vitest";
import {
  bucketByDay,
  buildMonth,
  dayKey,
  endOfDay,
  isSameDay,
  monthLabel,
  nextMonth,
  prevMonth,
  startOfDay,
  thisMonth,
  WEEKDAY_LABELS,
} from "./calendar.js";

// June 2026: the 1st is a Monday, so the grid's leading spill is Sun May 31.
const JUNE_2026 = new Date(2026, 5, 15, 13, 30).getTime();

describe("buildMonth", () => {
  it("returns exactly 6 weeks of 7 days (42 stable cells)", () => {
    const m = buildMonth(JUNE_2026, JUNE_2026);
    expect(m.weeks).toHaveLength(6);
    for (const w of m.weeks) expect(w).toHaveLength(7);
  });

  it("starts every week on Sunday", () => {
    const m = buildMonth(JUNE_2026, JUNE_2026);
    for (const w of m.weeks) {
      expect(new Date(w[0].date).getDay()).toBe(0);
      expect(new Date(w[6].date).getDay()).toBe(6);
    }
  });

  it("normalizes monthStart to the 1st at local midnight and reports month/year", () => {
    const m = buildMonth(JUNE_2026, JUNE_2026);
    const ms = new Date(m.monthStart);
    expect(ms.getFullYear()).toBe(2026);
    expect(ms.getMonth()).toBe(5);
    expect(ms.getDate()).toBe(1);
    expect(ms.getHours()).toBe(0);
    expect(m.month).toBe(5);
    expect(m.year).toBe(2026);
  });

  it("marks leading spill days out-of-month (Sun May 31 before Mon Jun 1)", () => {
    const m = buildMonth(JUNE_2026, JUNE_2026);
    const firstCell = m.weeks[0][0];
    expect(firstCell.inMonth).toBe(false);
    expect(new Date(firstCell.date).getMonth()).toBe(4); // May
    expect(firstCell.dayOfMonth).toBe(31);
  });

  it("marks the 1st of the displayed month in-month", () => {
    const m = buildMonth(JUNE_2026, JUNE_2026);
    const found = m.weeks.flat().find((d) => d.inMonth && d.dayOfMonth === 1);
    expect(found).toBeTruthy();
    expect(new Date(found!.date).getMonth()).toBe(5);
  });

  it("flags only the injected today as isToday", () => {
    const today = new Date(2026, 5, 15, 9, 0).getTime();
    const m = buildMonth(JUNE_2026, today);
    const flagged = m.weeks.flat().filter((d) => d.isToday);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].dayOfMonth).toBe(15);
    expect(flagged[0].inMonth).toBe(true);
  });

  it("has no today when today is outside the grid", () => {
    const today = new Date(2030, 0, 1).getTime();
    const m = buildMonth(JUNE_2026, today);
    expect(m.weeks.flat().some((d) => d.isToday)).toBe(false);
  });
});

describe("startOfDay / endOfDay", () => {
  it("startOfDay zeroes the time", () => {
    const d = new Date(startOfDay(JUNE_2026));
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getDate()).toBe(15);
  });
  it("endOfDay is the last ms of the day", () => {
    const d = new Date(endOfDay(JUNE_2026));
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
    expect(d.getSeconds()).toBe(59);
    expect(d.getMilliseconds()).toBe(999);
    expect(d.getDate()).toBe(15);
  });
});

describe("dayKey / isSameDay", () => {
  it("collapses two times on the same day to one key", () => {
    const morning = new Date(2026, 5, 15, 1).getTime();
    const evening = new Date(2026, 5, 15, 23).getTime();
    expect(dayKey(morning)).toBe(dayKey(evening));
    expect(isSameDay(morning, evening)).toBe(true);
  });
  it("distinguishes different days", () => {
    const a = new Date(2026, 5, 15).getTime();
    const b = new Date(2026, 5, 16).getTime();
    expect(isSameDay(a, b)).toBe(false);
  });
});

describe("month paging", () => {
  it("prevMonth returns the 1st of the prior month", () => {
    const d = new Date(prevMonth(JUNE_2026));
    expect(d.getMonth()).toBe(4); // May
    expect(d.getDate()).toBe(1);
  });
  it("nextMonth returns the 1st of the next month", () => {
    const d = new Date(nextMonth(JUNE_2026));
    expect(d.getMonth()).toBe(6); // July
    expect(d.getDate()).toBe(1);
  });
  it("wraps the year at boundaries", () => {
    const dec = new Date(2026, 11, 10).getTime();
    expect(new Date(nextMonth(dec)).getFullYear()).toBe(2027);
    const jan = new Date(2026, 0, 10).getTime();
    expect(new Date(prevMonth(jan)).getFullYear()).toBe(2025);
  });
  it("thisMonth is the 1st of today's month", () => {
    const d = new Date(thisMonth(JUNE_2026));
    expect(d.getMonth()).toBe(5);
    expect(d.getDate()).toBe(1);
  });
});

describe("monthLabel + WEEKDAY_LABELS", () => {
  it("labels the displayed month with its year", () => {
    const label = monthLabel(buildMonth(JUNE_2026, JUNE_2026));
    expect(label).toContain("2026");
  });
  it("has seven Sunday-first weekday labels", () => {
    expect(WEEKDAY_LABELS).toHaveLength(7);
    expect(WEEKDAY_LABELS[0]).toBe("Sun");
    expect(WEEKDAY_LABELS[6]).toBe("Sat");
  });
});

describe("bucketByDay", () => {
  interface Row {
    id: string;
    due: number | null;
  }
  it("buckets dated items by local day and collects undated as unscheduled", () => {
    const d15 = new Date(2026, 5, 15, 10).getTime();
    const d15b = new Date(2026, 5, 15, 18).getTime();
    const d16 = new Date(2026, 5, 16, 9).getTime();
    const rows: Row[] = [
      { id: "a", due: d15 },
      { id: "b", due: d15b },
      { id: "c", due: d16 },
      { id: "d", due: null },
    ];
    const { byDay, unscheduled } = bucketByDay(rows, (r) => r.due);
    expect(byDay.get(dayKey(d15))?.map((r) => r.id)).toEqual(["a", "b"]);
    expect(byDay.get(dayKey(d16))?.map((r) => r.id)).toEqual(["c"]);
    expect(unscheduled.map((r) => r.id)).toEqual(["d"]);
  });
  it("treats undefined due as unscheduled", () => {
    const { byDay, unscheduled } = bucketByDay(
      [{ id: "x", due: undefined } as { id: string; due?: number }],
      (r) => r.due,
    );
    expect(byDay.size).toBe(0);
    expect(unscheduled).toHaveLength(1);
  });
});
