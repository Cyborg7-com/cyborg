import { describe, expect, it } from "vitest";
import {
  describeCountAction,
  interpretCountArg,
  parseChannelSlashInput,
} from "./slash-commands.js";

// The interpretation echo must mirror the server's parseCountArg rules
// (packages/server cyborg/slash-commands.ts): optional LEADING integer,
// clamped to [1, max], everything else in the args silently ignored.
describe("interpretCountArg", () => {
  const summarize = parseChannelSlashInput("/summarize")!.command;

  it("uses the command default when no args are typed", () => {
    expect(interpretCountArg("", summarize)).toEqual({
      count: 200,
      usedDefault: true,
      clamped: false,
      ignoredText: "",
    });
  });

  it("reads a valid leading count", () => {
    expect(interpretCountArg("10", summarize)).toEqual({
      count: 10,
      usedDefault: false,
      clamped: false,
      ignoredText: "",
    });
  });

  it("flags trailing text after the count as ignored", () => {
    expect(interpretCountArg("10 enfocate en bugs", summarize)).toEqual({
      count: 10,
      usedDefault: false,
      clamped: false,
      ignoredText: "enfocate en bugs",
    });
  });

  it("falls back to the default AND flags non-numeric args as ignored", () => {
    expect(interpretCountArg("enfocate en bugs", summarize)).toEqual({
      count: 200,
      usedDefault: true,
      clamped: false,
      ignoredText: "enfocate en bugs",
    });
  });

  it("clamps a count above the max down to the max", () => {
    expect(interpretCountArg("5000", summarize)).toMatchObject({
      count: 1000,
      usedDefault: false,
      clamped: true,
    });
  });

  it("clamps zero up to 1", () => {
    expect(interpretCountArg("0", summarize)).toMatchObject({
      count: 1,
      usedDefault: false,
      clamped: true,
    });
  });

  it("does not clamp a count exactly at the max", () => {
    expect(interpretCountArg("1000", summarize)).toMatchObject({
      count: 1000,
      clamped: false,
    });
  });

  it("returns null for commands without count semantics (translate, ask)", () => {
    // /translate's arg is the target language and /ask's is "@cybo question" —
    // echoing them as an ignored count would be wrong.
    const translate = parseChannelSlashInput("/translate")!.command;
    const ask = parseChannelSlashInput("/ask")!.command;
    expect(interpretCountArg("spanish", translate)).toBeNull();
    expect(interpretCountArg("@pi hello", ask)).toBeNull();
  });
});

describe("describeCountAction", () => {
  it("names the action per command and pluralizes", () => {
    const summarize = parseChannelSlashInput("/summarize")!.command;
    const standup = parseChannelSlashInput("/standup")!.command;
    expect(describeCountAction(summarize, 10)).toBe("Will summarize the last 10 messages");
    expect(describeCountAction(summarize, 1)).toBe("Will summarize the last 1 message");
    expect(describeCountAction(standup, 200)).toBe("Will build the standup from the last 200 messages");
  });
});
