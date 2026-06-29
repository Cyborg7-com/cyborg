// Unit tests for the PURE due-date presentation. No DOM; `now` is injected so
// the relative buckets are deterministic.
import { describe, expect, it } from "vitest";
import { dueChipClass, formatDue } from "./due.js";

const NOW = 1_000_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("formatDue", () => {
  it("returns empty for no due date", () => {
    expect(formatDue(null, NOW)).toBe("");
    expect(formatDue(undefined, NOW)).toBe("");
    expect(formatDue(0, NOW)).toBe("");
  });
  it("labels a past due as Overdue", () => {
    expect(formatDue(NOW - HOUR, NOW)).toBe("Overdue");
  });
  it("labels within 24h as Today", () => {
    expect(formatDue(NOW + HOUR, NOW)).toBe("Today");
  });
  it("labels within 48h as Tomorrow", () => {
    expect(formatDue(NOW + DAY + HOUR, NOW)).toBe("Tomorrow");
  });
  it("labels further out as a date string", () => {
    const label = formatDue(NOW + 5 * DAY, NOW);
    expect(label).not.toBe("");
    expect(["Overdue", "Today", "Tomorrow"]).not.toContain(label);
  });
});

describe("dueChipClass", () => {
  it("overdue is red", () => {
    expect(dueChipClass(NOW - HOUR, NOW)).toContain("text-error");
  });
  it("today is amber", () => {
    expect(dueChipClass(NOW + HOUR, NOW)).toContain("text-warning");
  });
  it("later is muted", () => {
    expect(dueChipClass(NOW + 5 * DAY, NOW)).toContain("text-content-muted");
  });
});
