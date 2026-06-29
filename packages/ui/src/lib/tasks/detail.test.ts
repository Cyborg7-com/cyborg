// Unit tests for the PURE task-detail helpers: status presentation, the
// date-input <-> epoch round-trip (including the timezone-safe local Y/M/D and
// the end-of-day pin), and member-name resolution with its id-slice fallback.
import { describe, expect, it } from "vitest";
import type { WorkspaceMember } from "$lib/core/types.js";
import {
  STATUS_OPTIONS,
  statusLabel,
  statusPillClass,
  dueToInputValue,
  dueFromInputValue,
  resolveMemberName,
} from "./detail.js";

describe("statusLabel", () => {
  it("maps the four known statuses", () => {
    expect(statusLabel("in_progress")).toBe("In Progress");
    expect(statusLabel("pending_review")).toBe("Pending Review");
    expect(statusLabel("done")).toBe("Done");
    expect(statusLabel("pending")).toBe("Inbox");
  });
  it("falls back to Inbox for an unknown status", () => {
    expect(statusLabel("whatever")).toBe("Inbox");
  });
});

describe("statusPillClass", () => {
  it("uses theme tokens per status", () => {
    expect(statusPillClass("in_progress")).toContain("text-accent");
    expect(statusPillClass("pending_review")).toContain("text-warning");
    expect(statusPillClass("done")).toContain("text-online");
    expect(statusPillClass("pending")).toContain("text-content-dim");
  });
  it("never contains a raw hex color", () => {
    for (const s of ["pending", "in_progress", "pending_review", "done"]) {
      expect(statusPillClass(s)).not.toMatch(/#[0-9a-f]{3,6}/i);
    }
  });
});

describe("STATUS_OPTIONS", () => {
  it("covers exactly the four board statuses in workflow order", () => {
    expect(STATUS_OPTIONS.map((s) => s.value)).toEqual([
      "pending",
      "in_progress",
      "pending_review",
      "done",
    ]);
  });
});

describe("due round-trip", () => {
  it("empty/null due -> empty input value", () => {
    expect(dueToInputValue(null)).toBe("");
    expect(dueToInputValue(undefined)).toBe("");
    expect(dueToInputValue(0)).toBe("");
  });
  it("empty input value -> null (clears the due date)", () => {
    expect(dueFromInputValue("")).toBeNull();
  });
  it("malformed input value -> null, not NaN", () => {
    expect(dueFromInputValue("not-a-date")).toBeNull();
  });
  it("formats a timestamp to its LOCAL calendar day (no UTC day-shift)", () => {
    // Build a local noon timestamp so it can't drift across a date boundary.
    const ts = new Date(2026, 5, 30, 12, 0, 0).getTime(); // 2026-06-30 local
    expect(dueToInputValue(ts)).toBe("2026-06-30");
  });
  it("input value parses to that LOCAL day pinned at end-of-day", () => {
    const ms = dueFromInputValue("2026-06-30");
    expect(ms).not.toBeNull();
    const d = new Date(ms as number);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5);
    expect(d.getDate()).toBe(30);
    expect(d.getHours()).toBe(23);
  });
  it("round-trips a date through input value and back to the same local day", () => {
    const ts = new Date(2026, 0, 1, 9, 0, 0).getTime();
    const back = dueFromInputValue(dueToInputValue(ts));
    const d = new Date(back as number);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(1);
  });
});

describe("resolveMemberName", () => {
  const members = [
    { userId: "u1", name: "Ada Lovelace", email: "ada@x.com" },
    { userId: "u2", name: null, email: "grace@x.com" },
  ] as unknown as WorkspaceMember[];

  it("returns a member's name", () => {
    expect(resolveMemberName("u1", members)).toBe("Ada Lovelace");
  });
  it("falls back to email when name is missing", () => {
    expect(resolveMemberName("u2", members)).toBe("grace@x.com");
  });
  it("falls back to an id slice for a non-member id", () => {
    expect(resolveMemberName("a4e9d6d4-cb8b-1234", members)).toBe("a4e9d6d4");
  });
  it("returns empty for no id", () => {
    expect(resolveMemberName(null, members)).toBe("");
    expect(resolveMemberName(undefined, members)).toBe("");
  });
});
