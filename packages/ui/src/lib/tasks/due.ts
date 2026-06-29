// Pure, DOM-free due-date presentation for Tasks cards / list rows. Shared by
// the board card and the list view so a due chip looks identical everywhere.
// Kept pure (takes a timestamp, returns a string / class) so it's unit-testable
// without mounting a component. `now` is injectable for deterministic tests.

// Human-friendly relative label for a due timestamp (ms epoch). Past = "Overdue",
// within 24h = "Today", within 48h = "Tomorrow", else a "Mon D" date.
export function formatDue(ts: number | null | undefined, now: number = Date.now()): string {
  if (!ts) return "";
  const diff = ts - now;
  if (diff < 0) return "Overdue";
  if (diff < 86400000) return "Today";
  if (diff < 172800000) return "Tomorrow";
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

// Due chip styling: overdue = red, due today = amber, otherwise a quiet muted
// chip. Uses theme tokens only.
export function dueChipClass(ts: number, now: number = Date.now()): string {
  const diff = ts - now;
  if (diff < 0) return "bg-error/12 text-error";
  if (diff < 86400000) return "bg-warning/15 text-warning";
  return "bg-surface-alt text-content-muted";
}
