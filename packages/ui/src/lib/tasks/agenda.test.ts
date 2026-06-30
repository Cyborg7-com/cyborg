// Unit tests for the PURE agenda day-grouping math. No DOM; `today` is injected
// so the relative sections (Overdue / Today / Tomorrow) are deterministic. Dates
// are built with the local Date ctor so they match the local-day buckets the lib
// derives via calendar.ts.
import { describe, expect, it } from "vitest";
import { buildAgendaSections, type AgendaSection } from "./agenda.js";

// A minimal task-shape the grouping cares about: an id + a dueAt accessor target.
interface Item {
  id: string;
  dueAt: number | null;
}
const due = (i: Item) => i.dueAt;

// Anchor "now" at Wed Jul 1 2026, 12:00 local.
const NOW = new Date(2026, 6, 1, 12, 0).getTime();
const at = (y: number, m: number, d: number, h = 9) => new Date(y, m, d, h).getTime();

function kinds(sections: AgendaSection<Item>[]): string[] {
  return sections.map((s) => s.kind);
}

describe("buildAgendaSections", () => {
  it("orders sections Overdue → Today → Tomorrow → later days → Unscheduled", () => {
    const items: Item[] = [
      { id: "future2", dueAt: at(2026, 6, 5) }, // Jul 5
      { id: "today", dueAt: at(2026, 6, 1, 23) }, // Jul 1 (today, different hour)
      { id: "overdueA", dueAt: at(2026, 5, 28) }, // Jun 28
      { id: "tomorrow", dueAt: at(2026, 6, 2) }, // Jul 2
      { id: "overdueB", dueAt: at(2026, 5, 30) }, // Jun 30
      { id: "none", dueAt: null },
      { id: "future1", dueAt: at(2026, 6, 4) }, // Jul 4
    ];
    const sections = buildAgendaSections(items, due, NOW);
    expect(kinds(sections)).toEqual([
      "overdue",
      "today",
      "tomorrow",
      "day",
      "day",
      "unscheduled",
    ]);
    // Later days are chronological.
    const days = sections.filter((s) => s.kind === "day");
    expect(days[0].tasks.map((t) => t.id)).toEqual(["future1"]); // Jul 4
    expect(days[1].tasks.map((t) => t.id)).toEqual(["future2"]); // Jul 5
  });

  it("merges every past day into a single Overdue section, oldest first", () => {
    const items: Item[] = [
      { id: "b", dueAt: at(2026, 5, 30) }, // Jun 30
      { id: "a", dueAt: at(2026, 5, 28) }, // Jun 28
      { id: "c", dueAt: at(2026, 5, 30, 18) }, // Jun 30 (same day, later)
    ];
    const sections = buildAgendaSections(items, due, NOW);
    expect(sections).toHaveLength(1);
    expect(sections[0].kind).toBe("overdue");
    expect(sections[0].date).toBeNull();
    expect(sections[0].tasks.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("groups same-day tasks together and preserves input order within a day", () => {
    const items: Item[] = [
      { id: "t1", dueAt: at(2026, 6, 1, 8) },
      { id: "t2", dueAt: at(2026, 6, 1, 20) },
    ];
    const [today] = buildAgendaSections(items, due, NOW);
    expect(today.kind).toBe("today");
    expect(today.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
    // The single-day kinds expose the day's midnight.
    expect(today.date).toBe(new Date(2026, 6, 1).getTime());
  });

  it("omits empty sections and returns [] for no items", () => {
    expect(buildAgendaSections([], due, NOW)).toEqual([]);
    const onlyUnscheduled = buildAgendaSections([{ id: "x", dueAt: null }], due, NOW);
    expect(kinds(onlyUnscheduled)).toEqual(["unscheduled"]);
  });
});
