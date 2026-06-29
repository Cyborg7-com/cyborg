import { describe, expect, it } from "vitest";
import {
  actionItemsCommand,
  askCommand,
  describeCountArgWarnings,
  getSlashCommand,
  listSlashCommands,
  parseCountArg,
  parseCountArgDetailed,
  parseSlashCommand,
  standupCommand,
  suggestSlashTrigger,
  summarizeCommand,
  unknownSlashTriggerError,
} from "./slash-commands.js";

describe("parseSlashCommand", () => {
  it("parses trigger and args", () => {
    expect(parseSlashCommand("/summarize 50")).toEqual({ trigger: "summarize", args: "50" });
  });

  it("lowercases the trigger and trims args", () => {
    expect(parseSlashCommand("/Summarize   hello world ")).toEqual({
      trigger: "summarize",
      args: "hello world",
    });
  });

  it("handles a bare trigger with no args", () => {
    expect(parseSlashCommand("/summarize")).toEqual({ trigger: "summarize", args: "" });
  });

  it("tolerates leading whitespace", () => {
    expect(parseSlashCommand("   /ask hi")).toEqual({ trigger: "ask", args: "hi" });
  });

  it("returns null for non-slash text", () => {
    expect(parseSlashCommand("summarize this")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
  });
});

describe("parseCountArg", () => {
  it("reads a leading integer", () => {
    expect(parseCountArg("50", 30, 200)).toBe(50);
    expect(parseCountArg("50 extra", 30, 200)).toBe(50);
  });

  it("falls back when no number is present", () => {
    expect(parseCountArg("", 30, 200)).toBe(30);
    expect(parseCountArg("foo", 30, 200)).toBe(30);
  });

  it("clamps to [1, max]", () => {
    expect(parseCountArg("9999", 30, 200)).toBe(200);
    expect(parseCountArg("0", 30, 200)).toBe(1);
  });
});

describe("parseCountArgDetailed + describeCountArgWarnings", () => {
  it("clean input produces no warnings", () => {
    const parsed = parseCountArgDetailed("50", 200, 1000);
    expect(parsed).toEqual({ count: 50 });
    expect(describeCountArgWarnings(parsed, "summarize")).toEqual([]);
    expect(describeCountArgWarnings(parseCountArgDetailed("", 200, 1000), "summarize")).toEqual([]);
  });

  it("/summarize '10 texto': uses 10 and warns about the ignored text", () => {
    const parsed = parseCountArgDetailed(
      "10 texto",
      summarizeCommand.contextMessages,
      summarizeCommand.maxContextMessages,
    );
    expect(parsed.count).toBe(10);
    expect(parsed.clamped).toBeUndefined();
    expect(parsed.ignoredText).toBe("texto");
    const warnings = describeCountArgWarnings(parsed, "summarize");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"texto" was ignored');
    expect(warnings[0]).toContain("/summarize only takes a message count");
    expect(warnings[0]).toContain("/ask");
  });

  it("/action-items 'sin numero': falls back to the default and warns the text was ignored", () => {
    const parsed = parseCountArgDetailed(
      "sin numero",
      actionItemsCommand.contextMessages,
      actionItemsCommand.maxContextMessages,
    );
    expect(parsed.count).toBe(actionItemsCommand.contextMessages);
    expect(parsed.ignoredText).toBe("sin numero");
    const warnings = describeCountArgWarnings(parsed, "action-items");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"sin numero" was ignored');
    expect(warnings[0]).toContain("/action-items only takes a message count");
  });

  it("/standup '99999': clamps to max and says which count was used", () => {
    const parsed = parseCountArgDetailed(
      "99999",
      standupCommand.contextMessages,
      standupCommand.maxContextMessages,
    );
    expect(parsed.count).toBe(standupCommand.maxContextMessages);
    expect(parsed.clamped).toEqual({ from: 99999, to: standupCommand.maxContextMessages });
    expect(parsed.ignoredText).toBeUndefined();
    const warnings = describeCountArgWarnings(parsed, "standup");
    expect(warnings).toEqual([
      `Used count=${standupCommand.maxContextMessages} (max ${standupCommand.maxContextMessages}).`,
    ]);
  });

  it("'0' clamps up to the minimum and reports it", () => {
    const parsed = parseCountArgDetailed("0", 200, 1000);
    expect(parsed.count).toBe(1);
    expect(parsed.clamped).toEqual({ from: 0, to: 1 });
    expect(describeCountArgWarnings(parsed, "summarize")).toEqual(["Used count=1 (min 1)."]);
  });

  it("'99999 y algo mas' reports both the clamp and the ignored text", () => {
    const parsed = parseCountArgDetailed("99999 y algo mas", 200, 1000);
    expect(parsed.count).toBe(1000);
    expect(parsed.clamped).toEqual({ from: 99999, to: 1000 });
    expect(parsed.ignoredText).toBe("y algo mas");
    expect(describeCountArgWarnings(parsed, "summarize")).toHaveLength(2);
  });

  it("truncates very long ignored text in the warning", () => {
    const long = "x".repeat(100);
    const warnings = describeCountArgWarnings(parseCountArgDetailed(long, 200, 1000), "standup");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`"${"x".repeat(57)}…"`);
  });

  it("parseCountArg stays count-only and consistent with the detailed form", () => {
    expect(parseCountArg("10 texto", 200, 1000)).toBe(10);
    expect(parseCountArg("99999", 200, 1000)).toBe(1000);
    expect(parseCountArg("sin numero", 200, 1000)).toBe(200);
    // Exact parity with the original anchored regex: a LEADING-space number is
    // not a leading number — falls back (and the detailed form reports it).
    expect(parseCountArg(" 50", 200, 1000)).toBe(200);
    expect(parseCountArgDetailed(" 50", 200, 1000)).toEqual({ count: 200, ignoredText: "50" });
  });
});

describe("registry", () => {
  it("resolves summarize case-insensitively", () => {
    expect(getSlashCommand("summarize")).toBe(summarizeCommand);
    expect(getSlashCommand("SUMMARIZE")).toBe(summarizeCommand);
  });

  it("returns undefined for unknown triggers", () => {
    expect(getSlashCommand("nope")).toBeUndefined();
  });

  it("lists registered commands with their kind", () => {
    expect(listSlashCommands().map((c) => c.trigger)).toContain("summarize");
    expect(summarizeCommand.kind).toBe("summary");
  });

  it("registers /ask as the ask kind with a @cybo hint and no history read", () => {
    expect(getSlashCommand("ask")).toBe(askCommand);
    expect(getSlashCommand("ASK")).toBe(askCommand);
    expect(askCommand.kind).toBe("ask");
    expect(askCommand.hint).toBe("@cybo <question>");
    // /ask invokes a named cybo directly — it reads no channel transcript.
    expect(askCommand.contextMessages).toBe(0);
  });
});

// The dispatcher's unknown-trigger guard: a trigger that isn't registered must
// ack an EXPLICIT error (CLI/API callers bypass the composer's client-side
// guard), with a "did you mean" suggestion when a registered trigger is close.
describe("unknownSlashTriggerError / suggestSlashTrigger", () => {
  it("suggests the closest trigger for a small typo", () => {
    expect(suggestSlashTrigger("sumarize")).toBe("summarize");
    expect(suggestSlashTrigger("standap")).toBe("standup");
    expect(suggestSlashTrigger("actionitems")).toBe("action-items");
  });

  it("suggests nothing when no trigger is close", () => {
    expect(suggestSlashTrigger("deploy")).toBeNull();
    expect(suggestSlashTrigger("xyzzy")).toBeNull();
  });

  it("builds an ack error naming the trigger, the suggestion, and the registry", () => {
    const msg = unknownSlashTriggerError("sumarize");
    expect(msg).toContain('Unknown command "/sumarize"');
    expect(msg).toContain('Did you mean "/summarize"?');
    expect(msg).toContain("/summarize");
    expect(msg).toContain("/action-items");
  });

  it("omits the suggestion (but still lists commands) when nothing is close", () => {
    const msg = unknownSlashTriggerError("deploy");
    expect(msg).toContain('Unknown command "/deploy"');
    expect(msg).not.toContain("Did you mean");
    expect(msg).toContain("/summarize");
  });
});

describe("/catchup registration (#597)", () => {
  it("is registered, parses with no count arg, and is the catchup kind", () => {
    const cmd = getSlashCommand("catchup");
    expect(cmd).toBeDefined();
    expect(cmd?.kind).toBe("catchup");
    // Window is defined by last_read_at, not a count.
    expect(cmd?.contextMessages).toBe(0);
    expect(cmd?.maxContextMessages).toBe(500);
    expect(cmd?.hint).toBeUndefined();
  });

  it("appears in the registry listing and parses from a raw composer string", () => {
    expect(listSlashCommands().some((c) => c.trigger === "catchup")).toBe(true);
    expect(parseSlashCommand("/catchup")).toEqual({ trigger: "catchup", args: "" });
  });

  it("is a near-miss suggestion for a typo'd trigger", () => {
    expect(suggestSlashTrigger("catchu")).toBe("catchup");
  });
});
