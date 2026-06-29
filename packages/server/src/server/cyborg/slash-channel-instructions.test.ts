import { describe, it, expect } from "vitest";
import {
  summarizeTranscript,
  finalSummarySystem,
  channelGuidelinesBlock,
  CHANNEL_GUIDELINES_MAX_CHARS,
  type Completer,
} from "./summarization.js";
import { extractActionItems, generateStandup, translateMessages } from "./channel-ai-commands.js";

// Channel instructions ("Guidelines for agents acting in this channel") must
// flow into the slash-command prompts when set — and leave the prompt
// byte-identical when not set.

const GUIDELINES = "Always answer in Spanish. Max 5 bullets. Never @-mention people.";

function capture(): { complete: Completer; systems: string[] } {
  const systems: string[] = [];
  const complete: Completer = async (system, _user) => {
    systems.push(system);
    return "ok";
  };
  return { complete, systems };
}

describe("channelGuidelinesBlock", () => {
  it("is empty for null/undefined/blank instructions", () => {
    expect(channelGuidelinesBlock(null)).toBe("");
    expect(channelGuidelinesBlock(undefined)).toBe("");
    expect(channelGuidelinesBlock("   \n  ")).toBe("");
  });

  it("wraps instructions in a delimited, subordinated block", () => {
    const block = channelGuidelinesBlock(GUIDELINES);
    expect(block).toContain("<channel_guidelines>");
    expect(block).toContain(GUIDELINES);
    expect(block).toContain("</channel_guidelines>");
    // Subordination: guidelines must not be able to replace the task.
    expect(block).toContain("never override or replace the task");
  });

  it("caps oversized instructions at CHANNEL_GUIDELINES_MAX_CHARS", () => {
    const huge = "x".repeat(CHANNEL_GUIDELINES_MAX_CHARS + 5000);
    const block = channelGuidelinesBlock(huge);
    expect(block).not.toContain(huge);
    expect(block).toContain("x".repeat(CHANNEL_GUIDELINES_MAX_CHARS));
  });
});

describe("/summarize", () => {
  it("includes the guidelines in the completer's system prompt when set", async () => {
    const { complete, systems } = capture();
    await summarizeTranscript({
      transcript: "@a: hello\n@b: world",
      channelName: "general",
      complete,
      channelInstructions: GUIDELINES,
    });
    expect(systems).toHaveLength(1);
    expect(systems[0]).toContain(GUIDELINES);
    // The original task is intact and the guidelines ride AFTER it.
    expect(systems[0]).toContain("You summarize a conversation from the channel #general.");
    expect(systems[0].indexOf(GUIDELINES)).toBeGreaterThan(
      systems[0].indexOf("You summarize a conversation"),
    );
  });

  it("is byte-identical to the no-guidelines prompt when none are set", async () => {
    const { complete, systems } = capture();
    await summarizeTranscript({ transcript: "@a: hi", channelName: "general", complete });
    expect(systems[0]).toBe(finalSummarySystem("general", false));
    expect(systems[0]).not.toContain("<channel_guidelines>");
  });
});

describe("/action-items and /standup", () => {
  it("include the guidelines when set; unchanged when not", async () => {
    for (const run of [extractActionItems, generateStandup]) {
      const withG = capture();
      await run({
        transcript: "@a: do x",
        channelName: "general",
        complete: withG.complete,
        channelInstructions: GUIDELINES,
      });
      expect(withG.systems[0]).toContain(GUIDELINES);

      const without = capture();
      await run({ transcript: "@a: do x", channelName: "general", complete: without.complete });
      expect(without.systems[0]).not.toContain("<channel_guidelines>");
      // The with-guidelines prompt is the plain prompt + the block, nothing else.
      expect(withG.systems[0]).toBe(without.systems[0] + channelGuidelinesBlock(GUIDELINES));
    }
  });
});

describe("/translate", () => {
  it("deliberately ignores guidelines (verbatim-translation contract)", async () => {
    const { complete, systems } = capture();
    await translateMessages({
      transcript: "@a: hola",
      channelName: "general",
      complete,
      targetLang: "english",
      channelInstructions: GUIDELINES,
    });
    expect(systems[0]).not.toContain(GUIDELINES);
    expect(systems[0]).not.toContain("<channel_guidelines>");
  });
});
