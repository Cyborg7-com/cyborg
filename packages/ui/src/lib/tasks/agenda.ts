// Pure, DOM-free day-grouping math for the mobile Tasks AGENDA (the Calendar
// layout degraded to a phone-native agenda list). The desktop calendar places
// tasks on a month grid; on a phone the readable form is a vertical agenda:
// tasks bucketed by their due day and rolled into a fixed set of relative
// sections — Overdue (everything past), Today, Tomorrow, then one section per
// later dated day in chronological order, then Unscheduled (no due date).
//
// Kept pure (takes a `getDue` accessor + an injectable `today`) so it is
// trivially unit-testable without mounting a component — exactly like
// calendar.ts / gantt.ts. It REUSES calendar.ts verbatim (bucketByDay + the day
// key / start-of-day helpers) so the agenda groups tasks by the SAME local-day
// key the calendar grid and the day drawer use; a task created from a day's
// "+ Add" (dueAt = endOfDay(day)) therefore lands in that exact section.

import { bucketByDay, dayKey, startOfDay } from "./calendar.js";

// The relative bucket a section represents. `overdue`/`unscheduled` are merged
// (many days or no day); `today`/`tomorrow`/`day` are a single calendar day.
export type AgendaKind = "overdue" | "today" | "tomorrow" | "day" | "unscheduled";

// One rendered agenda section: a header label + the tasks under it. `date` is the
// section's local-midnight day for the single-day kinds (today/tomorrow/day) and
// null for the merged kinds (overdue/unscheduled). `key` is a stable #each key.
export interface AgendaSection<T> {
  key: string;
  kind: AgendaKind;
  label: string;
  date: number | null;
  tasks: T[];
}

// Header label for a concrete day section, e.g. "Wed, Jul 2" (weekday + month +
// day). Today/Tomorrow get their relative words instead; the year is omitted to
// stay compact (an agenda reads near-term).
function dayLabel(dayMs: number): string {
  return new Date(dayMs).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

// Build the ordered agenda sections for a list of items. Sections appear in
// reading order: Overdue → Today → Tomorrow → each future day (chronological) →
// Unscheduled. A section is omitted when it has no tasks. Input order within a
// day is preserved (the page hands tasks pre-sorted), so the caller's sort
// (created-at, etc.) survives the grouping.
export function buildAgendaSections<T>(
  items: T[],
  getDue: (item: T) => number | null | undefined,
  today: number = Date.now(),
): AgendaSection<T>[] {
  const { byDay, unscheduled } = bucketByDay(items, getDue);

  const todayStart = startOfDay(today);
  // DST-safe "tomorrow" (Date API, not +86_400_000) so a 23h/25h day still
  // resolves to the next calendar midnight.
  const tomorrow = new Date(todayStart);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStart = tomorrow.getTime();

  // Materialize each day bucket with its local-midnight ms (recomputed from the
  // first task's due so the value is canonical), then sort ascending by day.
  const buckets: { dayMs: number; tasks: T[] }[] = [];
  for (const list of byDay.values()) {
    const first = getDue(list[0]) as number;
    buckets.push({ dayMs: startOfDay(first), tasks: list });
  }
  buckets.sort((a, b) => a.dayMs - b.dayMs);

  const sections: AgendaSection<T>[] = [];

  // Overdue: every bucket strictly before today, merged into one section
  // (oldest first, since buckets are ascending).
  const overdue: T[] = [];
  for (const b of buckets) {
    if (b.dayMs < todayStart) overdue.push(...b.tasks);
  }
  if (overdue.length > 0) {
    sections.push({ key: "overdue", kind: "overdue", label: "Overdue", date: null, tasks: overdue });
  }

  // Today / Tomorrow / each later day as its own section.
  for (const b of buckets) {
    if (b.dayMs < todayStart) continue;
    if (b.dayMs === todayStart) {
      sections.push({ key: "today", kind: "today", label: "Today", date: b.dayMs, tasks: b.tasks });
    } else if (b.dayMs === tomorrowStart) {
      sections.push({ key: "tomorrow", kind: "tomorrow", label: "Tomorrow", date: b.dayMs, tasks: b.tasks });
    } else {
      sections.push({
        key: dayKey(b.dayMs),
        kind: "day",
        label: dayLabel(b.dayMs),
        date: b.dayMs,
        tasks: b.tasks,
      });
    }
  }

  // Unscheduled (no due date) always last.
  if (unscheduled.length > 0) {
    sections.push({
      key: "unscheduled",
      kind: "unscheduled",
      label: "No date",
      date: null,
      tasks: unscheduled,
    });
  }

  return sections;
}
