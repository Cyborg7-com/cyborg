import { describe, expect, it } from "vitest";
import { isGroupedWith, isNewDay } from "./grouping.js";

const base = { fromId: "u1", fromType: "human", createdAt: 1_000_000 };

describe("isGroupedWith", () => {
  it("groups same user + type within the window", () => {
    expect(isGroupedWith(base, { ...base, createdAt: base.createdAt + 60_000 })).toBe(true);
  });

  it("splits same user beyond the window", () => {
    expect(isGroupedWith(base, { ...base, createdAt: base.createdAt + 360_000 })).toBe(false);
  });

  it("splits same user when messages are out of order (negative gap)", () => {
    expect(isGroupedWith(base, { ...base, createdAt: base.createdAt - 10_000 })).toBe(false);
  });

  it("splits same user within the window but across a day boundary", () => {
    const lateNight = new Date(2026, 0, 1, 23, 59, 0).getTime();
    const earlyMorning = new Date(2026, 0, 2, 0, 1, 0).getTime();
    expect(
      isGroupedWith({ ...base, createdAt: lateNight }, { ...base, createdAt: earlyMorning }),
    ).toBe(false);
  });

  it("splits different fromId", () => {
    expect(isGroupedWith(base, { ...base, fromId: "u2", createdAt: base.createdAt + 1_000 })).toBe(
      false,
    );
  });

  it("splits different fromType", () => {
    expect(
      isGroupedWith(base, { ...base, fromType: "agent", createdAt: base.createdAt + 1_000 }),
    ).toBe(false);
  });
});

describe("isNewDay", () => {
  const noon = new Date(2026, 0, 1, 12, 0, 0).getTime();

  it("false within the same calendar day", () => {
    const evening = new Date(2026, 0, 1, 20, 0, 0).getTime();
    expect(isNewDay({ ...base, createdAt: noon }, { ...base, createdAt: evening })).toBe(false);
  });

  it("true across a day boundary", () => {
    const nextDay = new Date(2026, 0, 2, 9, 0, 0).getTime();
    expect(isNewDay({ ...base, createdAt: noon }, { ...base, createdAt: nextDay })).toBe(true);
  });
});
