import { describe, expect, it } from "vitest";
import { relativeTime } from "./datetime.js";

// Fixed reference instant so every case is deterministic regardless of wall clock.
const NOW = Date.UTC(2026, 5, 13, 12, 0, 0); // 2026-06-13T12:00:00Z
const ago = (ms: number) => NOW - ms;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

describe("relativeTime", () => {
  it("sub-minute → 'just now'", () => {
    expect(relativeTime(ago(0), NOW)).toBe("just now");
    expect(relativeTime(ago(59 * 1000), NOW)).toBe("just now");
  });

  it("minutes / hours / days buckets (floored)", () => {
    expect(relativeTime(ago(MINUTE), NOW)).toBe("1m ago");
    expect(relativeTime(ago(59 * MINUTE), NOW)).toBe("59m ago");
    expect(relativeTime(ago(HOUR), NOW)).toBe("1h ago");
    expect(relativeTime(ago(23 * HOUR), NOW)).toBe("23h ago");
    expect(relativeTime(ago(DAY), NOW)).toBe("1d ago");
    expect(relativeTime(ago(6 * DAY), NOW)).toBe("6d ago");
  });

  it("weeks / months / years buckets", () => {
    expect(relativeTime(ago(WEEK), NOW)).toBe("1w ago");
    expect(relativeTime(ago(3 * WEEK), NOW)).toBe("3w ago");
    expect(relativeTime(ago(MONTH), NOW)).toBe("1mo ago");
    expect(relativeTime(ago(6 * MONTH), NOW)).toBe("6mo ago");
    expect(relativeTime(ago(YEAR), NOW)).toBe("1y ago");
    expect(relativeTime(ago(5 * YEAR), NOW)).toBe("5y ago");
  });

  it("accepts ISO strings, epoch ms, and Date objects alike", () => {
    const iso = new Date(ago(2 * HOUR)).toISOString();
    expect(relativeTime(iso, NOW)).toBe("2h ago");
    expect(relativeTime(ago(2 * HOUR), NOW)).toBe("2h ago");
    expect(relativeTime(new Date(ago(2 * HOUR)), NOW)).toBe("2h ago");
  });

  it("clamps future instants to 'just now'", () => {
    expect(relativeTime(NOW + HOUR, NOW)).toBe("just now");
  });

  it("returns '' for a nullish or unparseable input rather than 'NaN ago' / epoch", () => {
    expect(relativeTime("not a date", NOW)).toBe("");
    expect(relativeTime(NaN, NOW)).toBe("");
    // new Date(null) is epoch 0 (finite) — must be guarded, not rendered as "56y ago".
    expect(relativeTime(null, NOW)).toBe("");
    expect(relativeTime(undefined, NOW)).toBe("");
  });
});
