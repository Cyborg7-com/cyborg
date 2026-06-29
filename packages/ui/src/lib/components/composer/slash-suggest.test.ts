import { describe, expect, it } from "vitest";
import { CHANNEL_SLASH_COMMANDS, matchChannelSlashCommands } from "./slash-commands.js";
import {
  editDistance,
  extractSlashTriggerCandidate,
  fuzzyTriggerScore,
  suggestClosestTrigger,
} from "./slash-suggest.js";

const TRIGGERS = CHANNEL_SLASH_COMMANDS.map((c) => c.trigger);

describe("editDistance", () => {
  it("computes basic distances", () => {
    expect(editDistance("summarize", "summarize")).toBe(0);
    expect(editDistance("sumarize", "summarize")).toBe(1); // missing m
    expect(editDistance("summarise", "summarize")).toBe(1); // s↔z
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("kitten", "sitting")).toBe(3);
  });
});

describe("extractSlashTriggerCandidate (false-positive guard)", () => {
  it("extracts the trigger from command-looking text", () => {
    expect(extractSlashTriggerCandidate("/sumarize 10")).toBe("sumarize");
    expect(extractSlashTriggerCandidate("/sumarize")).toBe("sumarize");
    expect(extractSlashTriggerCandidate("/Action-Items")).toBe("action-items");
  });

  it("does NOT treat path-like or mid-text slashes as commands", () => {
    expect(extractSlashTriggerCandidate("/etc/hosts")).toBeNull(); // second slash
    expect(extractSlashTriggerCandidate("//cdn.example.com")).toBeNull();
    expect(extractSlashTriggerCandidate("/ hello")).toBeNull(); // space after /
    expect(extractSlashTriggerCandidate("/123")).toBeNull(); // digit-initial
    expect(extractSlashTriggerCandidate("see /summarize")).toBeNull(); // not at start
    expect(extractSlashTriggerCandidate("hello world")).toBeNull();
  });
});

describe("suggestClosestTrigger", () => {
  it("suggests for a small typo of a full trigger", () => {
    expect(suggestClosestTrigger("sumarize", TRIGGERS)).toBe("summarize");
    expect(suggestClosestTrigger("standap", TRIGGERS)).toBe("standup");
    expect(suggestClosestTrigger("actionitems", TRIGGERS)).toBe("action-items");
  });

  it("suggests for an unambiguous fuzzy prefix", () => {
    expect(suggestClosestTrigger("sumar", TRIGGERS)).toBe("summarize");
  });

  it("returns null when nothing is close", () => {
    expect(suggestClosestTrigger("deploy", TRIGGERS)).toBeNull();
    expect(suggestClosestTrigger("xyzzy", TRIGGERS)).toBeNull();
  });
});

describe("matchChannelSlashCommands (fuzzy menu ranking)", () => {
  it("keeps exact-prefix behavior, ranked first", () => {
    expect(matchChannelSlashCommands("summ")[0].trigger).toBe("summarize");
    expect(matchChannelSlashCommands("").map((c) => c.trigger)).toEqual(TRIGGERS);
  });

  it('offers summarize for the typo\'d prefix "sumar"', () => {
    expect(matchChannelSlashCommands("sumar").map((c) => c.trigger)).toContain("summarize");
  });

  it("returns nothing for far-off queries", () => {
    expect(matchChannelSlashCommands("xyzzy")).toEqual([]);
  });

  it("short queries stay prefix-only (no fuzzy noise at 1-2 chars)", () => {
    expect(fuzzyTriggerScore("s", "ask")).toBeNull();
    expect(matchChannelSlashCommands("s").map((c) => c.trigger)).toEqual(["summarize", "standup"]);
  });
});
