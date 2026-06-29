import { describe, expect, it } from "vitest";
import { isDesktopActiveForPush } from "./push-active.js";

const NOW = 1_000_000_000_000;
const IDLE = 30 * 60 * 1000; // 30 min

describe("isDesktopActiveForPush", () => {
  it("foregrounded desktop active just now silences the phone", () => {
    expect(
      isDesktopActiveForPush(
        { clientType: "desktop", backgrounded: false, wsOpen: true, lastActivityAt: NOW },
        NOW,
        IDLE,
      ),
    ).toBe(true);
  });

  it("foregrounded web active within the window silences the phone", () => {
    expect(
      isDesktopActiveForPush(
        { clientType: "web", backgrounded: false, wsOpen: true, lastActivityAt: NOW - 60_000 },
        NOW,
        IDLE,
      ),
    ).toBe(true);
  });

  it("foregrounded desktop idle past the window does NOT silence the phone (the fix)", () => {
    expect(
      isDesktopActiveForPush(
        { clientType: "desktop", backgrounded: false, wsOpen: true, lastActivityAt: NOW - IDLE - 1 },
        NOW,
        IDLE,
      ),
    ).toBe(false);
  });

  it("treats the idle boundary as inactive (>= idleMs releases the phone)", () => {
    expect(
      isDesktopActiveForPush(
        { clientType: "desktop", backgrounded: false, wsOpen: true, lastActivityAt: NOW - IDLE },
        NOW,
        IDLE,
      ),
    ).toBe(false);
  });

  it("backgrounded desktop never silences the phone", () => {
    expect(
      isDesktopActiveForPush(
        { clientType: "desktop", backgrounded: true, wsOpen: true, lastActivityAt: NOW },
        NOW,
        IDLE,
      ),
    ).toBe(false);
  });

  it("closed socket never silences the phone", () => {
    expect(
      isDesktopActiveForPush(
        { clientType: "desktop", backgrounded: false, wsOpen: false, lastActivityAt: NOW },
        NOW,
        IDLE,
      ),
    ).toBe(false);
  });

  it("mobile connections never count as active-desktop", () => {
    expect(
      isDesktopActiveForPush(
        { clientType: "mobile", backgrounded: false, wsOpen: true, lastActivityAt: NOW },
        NOW,
        IDLE,
      ),
    ).toBe(false);
  });

  it("missing clientType (old client) never counts as active-desktop", () => {
    expect(
      isDesktopActiveForPush({ wsOpen: true, lastActivityAt: NOW }, NOW, IDLE),
    ).toBe(false);
  });

  it("never-active connection (no lastActivityAt) does not silence the phone", () => {
    expect(
      isDesktopActiveForPush(
        { clientType: "desktop", backgrounded: false, wsOpen: true },
        NOW,
        IDLE,
      ),
    ).toBe(false);
  });
});
