import { describe, it, expect } from "vitest";
import {
  formatSize,
  formatDuration,
  isSameDay,
  formatTime,
  formatMessageTimestamp,
} from "./utils.js";

// #508: these are the consolidated date/time/size formatters that previously
// existed as per-component copies. The deterministic ones (size, duration,
// same-day) are pinned exactly; the locale/now-dependent ones are checked
// structurally so the suite stays stable across machines/timezones.

describe("formatSize", () => {
  it("formats bytes / KB / MB / GB with round-or-1dp", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(820)).toBe("820 B");
    expect(formatSize(1024)).toBe("1 KB"); // whole → no decimal
    expect(formatSize(1536)).toBe("1.5 KB"); // <10 → 1 decimal
    expect(formatSize(2 * 1024 * 1024)).toBe("2 MB");
    expect(formatSize(3.4 * 1024 * 1024)).toBe("3.4 MB");
    expect(formatSize(15 * 1024 * 1024)).toBe("15 MB"); // ≥10 → rounded
    expect(formatSize(2 * 1024 * 1024 * 1024)).toBe("2 GB");
  });

  it("caps the unit at GB (no TB)", () => {
    expect(formatSize(5 * 1024 ** 4)).toBe("5120 GB");
  });
});

describe("formatDuration", () => {
  it("formats seconds as m:ss with zero-padded seconds", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(7)).toBe("0:07");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(222)).toBe("3:42");
    expect(formatDuration(59.8)).toBe("0:59"); // floors fractional seconds
  });

  it("guards NaN / negative / Infinity → 0:00", () => {
    expect(formatDuration(Number.NaN)).toBe("0:00");
    expect(formatDuration(-5)).toBe("0:00");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0:00");
  });
});

describe("isSameDay", () => {
  it("is true within the same calendar day, false across days", () => {
    const a = new Date(2026, 5, 9, 8, 0, 0).getTime();
    const b = new Date(2026, 5, 9, 23, 59, 0).getTime();
    const c = new Date(2026, 5, 10, 0, 1, 0).getTime();
    expect(isSameDay(a, b)).toBe(true);
    expect(isSameDay(a, c)).toBe(false);
  });
});

describe("formatMessageTimestamp", () => {
  it("today → just the clock time (no date prefix)", () => {
    const now = Date.now();
    expect(formatMessageTimestamp(now)).toBe(formatTime(now));
  });

  it("yesterday → 'Yesterday <time>'", () => {
    // Construct via setDate (not a hardcoded -24h) so it's DST-safe.
    const d = new Date();
    d.setDate(d.getDate() - 1);
    expect(formatMessageTimestamp(d.getTime())).toMatch(/^Yesterday /);
  });

  it("older → 'Mon D <time>' (carries a month/day prefix, not 'Yesterday')", () => {
    const d = new Date();
    d.setDate(d.getDate() - 10);
    const old = d.getTime();
    const out = formatMessageTimestamp(old);
    expect(out).not.toMatch(/^Yesterday/);
    expect(out.endsWith(formatTime(old))).toBe(true);
  });
});
