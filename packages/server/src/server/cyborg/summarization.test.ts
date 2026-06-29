import { describe, expect, it } from "vitest";
import {
  catchupDigestSystem,
  estimateTokens,
  finalSummarySystem,
  formatTranscript,
  splitOnSentences,
  SUMMARIZE_CHUNK_SYSTEM,
  summarizeTranscript,
  tokenBudget,
  type Completer,
} from "./summarization.js";
import type { StoredMessage } from "./storage.js";

function msg(from_name: string, text: string): StoredMessage {
  return {
    id: from_name + text,
    workspace_id: "w",
    channel_id: "c",
    from_id: "u_" + from_name,
    from_type: "human",
    from_name,
    to_id: null,
    text,
    mentions: null,
    parent_id: null,
    seq: 0,
    created_at: 0,
  };
}

// Records (system, user) pairs; returns a system-dependent stub.
function recordingCompleter(reply: (system: string, user: string) => string): {
  complete: Completer;
  calls: { system: string; user: string }[];
} {
  const calls: { system: string; user: string }[] = [];
  const complete: Completer = async (system, user) => {
    calls.push({ system, user });
    return reply(system, user);
  };
  return { complete, calls };
}

describe("estimateTokens / tokenBudget", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("reserves a 1000-token margin off 75% of the window", () => {
    expect(tokenBudget(100_000)).toBe(74_000);
  });
});

describe("splitOnSentences", () => {
  it("packs sentences into chunks no larger than maxChars", () => {
    const chunks = splitOnSentences("One. Two. Three. Four.", 10);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(10);
    expect(chunks.join("")).toBe("One. Two. Three. Four.");
  });

  it("hard-splits a single over-long sentence", () => {
    const chunks = splitOnSentences("x".repeat(20), 5);
    expect(chunks).toHaveLength(4);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(5);
  });
});

describe("formatTranscript", () => {
  it("prefixes @name and drops empty messages", () => {
    const t = formatTranscript([msg("alice", "hello"), msg("bob", "  "), msg("carol", "bye")]);
    expect(t).toBe("@alice: hello\n@carol: bye");
  });
});

describe("summarizeTranscript", () => {
  it("returns a sentinel for an empty transcript", async () => {
    const { complete, calls } = recordingCompleter(() => "x");
    expect(await summarizeTranscript({ transcript: "  ", channelName: "general", complete })).toBe(
      "Nothing to summarize.",
    );
    expect(calls).toHaveLength(0);
  });

  it("single-passes when under the token budget (no chunking)", async () => {
    const { complete, calls } = recordingCompleter(() => "THE SUMMARY");
    const out = await summarizeTranscript({
      transcript: "@alice: hello\n@bob: hi",
      channelName: "general",
      complete,
    });
    expect(out).toBe("THE SUMMARY");
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toContain("#general");
    // single pass → NOT the chunked-reduce variant
    expect(calls[0].system).not.toContain("partial summaries");
  });

  it("map-reduces when over budget: MAP per chunk then a chunked REDUCE", async () => {
    const { complete, calls } = recordingCompleter((system) =>
      system.includes("bullet-point summary") ? "chunk-summary." : "FINAL SUMMARY",
    );
    // inputTokenLimit 2000 → budget 500 tokens ≈ 2000 chars; make a longer transcript.
    const transcript = Array.from({ length: 80 }, (_, i) => `@u: message number ${i} here.`).join(
      "\n",
    );
    expect(estimateTokens(transcript)).toBeGreaterThan(tokenBudget(2000));

    const out = await summarizeTranscript({
      transcript,
      channelName: "general",
      complete,
      inputTokenLimit: 2000,
    });

    expect(out).toBe("FINAL SUMMARY");
    const mapCalls = calls.filter((c) => c.system.includes("bullet-point summary"));
    const finalCalls = calls.filter((c) => c.system.includes("#general"));
    expect(mapCalls.length).toBeGreaterThanOrEqual(2); // at least 2 chunks
    expect(finalCalls).toHaveLength(1);
    expect(finalCalls[0].system).toContain("partial summaries"); // chunked variant
  });

  it("recurses when joined summaries still overflow, and terminates at the depth cap", async () => {
    // Every MAP chunk returns a still-huge summary so the reduce must recurse.
    const big = "y".repeat(5000);
    const { complete, calls } = recordingCompleter((system) =>
      system.includes("bullet-point summary") ? big : "DONE",
    );
    const transcript = "z".repeat(12_000);
    const out = await summarizeTranscript({
      transcript,
      channelName: "general",
      complete,
      inputTokenLimit: 2000,
      maxReduceDepth: 2,
    });
    expect(out).toBe("DONE");
    // More than a single MAP+REDUCE round happened (recursion engaged).
    expect(calls.length).toBeGreaterThan(3);
    expect(calls.at(-1)?.system).toContain("partial summaries");
  });
});

// RAW-TEXT CONTRACT: the completer captures the model's raw output as the result —
// no JSON, no schema. Guard that every slash-summary prompt asks for raw markdown
// ONLY and NEVER mentions JSON (a re-added JSON instruction would make the model
// emit a JSON blob that the raw-text path would render verbatim).
describe("summarizer prompts ask for raw markdown (never JSON)", () => {
  const prompts = [
    ["SUMMARIZE_CHUNK_SYSTEM", SUMMARIZE_CHUNK_SYSTEM],
    ["finalSummarySystem (plain)", finalSummarySystem("general", false)],
    ["finalSummarySystem (chunked)", finalSummarySystem("general", true)],
  ] as const;

  for (const [name, prompt] of prompts) {
    it(`${name}: never instructs JSON`, () => {
      expect(prompt).not.toMatch(/json/i);
    });
    it(`${name}: asks for ONLY markdown, no preamble/code fences`, () => {
      expect(prompt).toMatch(/output only/i);
      expect(prompt).toMatch(/code fences/i);
    });
  }
});

describe("catchupDigestSystem (#597)", () => {
  it("frames a personal digest addressed to the caller, flagging their attention items", () => {
    const s = catchupDigestSystem({
      channelName: "general",
      callerName: "rodrigo",
      isChunked: false,
    });
    expect(s).toContain("@rodrigo");
    expect(s).toContain("#general");
    expect(s.toLowerCase()).toContain("missed");
    expect(s.toLowerCase()).toContain("decisions");
    // single-pass framing → not the chunked-combine variant
    expect(s).not.toContain("partial summaries");
  });

  it("switches to the chunked-combine framing when isChunked", () => {
    const s = catchupDigestSystem({
      channelName: "general",
      callerName: "rodrigo",
      isChunked: true,
    });
    expect(s).toContain("partial summaries");
  });
});

describe("summarizeTranscript finalSystem override (powers /catchup)", () => {
  it("uses the override for the single-pass FINAL prompt, not the channel summary", async () => {
    const { complete, calls } = recordingCompleter(() => "DIGEST");
    const out = await summarizeTranscript({
      transcript: "@alice: shipped the fix\n@bob: nice",
      channelName: "general",
      complete,
      finalSystem: (isChunked) =>
        catchupDigestSystem({ channelName: "general", callerName: "rodrigo", isChunked }),
    });
    expect(out).toBe("DIGEST");
    expect(calls).toHaveLength(1);
    // The digest prompt ran, addressed to the caller — NOT the default summary.
    expect(calls[0].system).toContain("@rodrigo");
    expect(calls[0].system.toLowerCase()).toContain("missed");
  });

  it("passes isChunked=true to the override on the reduce-final step", async () => {
    // Tiny budget forces MAP+REDUCE; the FINAL call must use the chunked override.
    const { complete, calls } = recordingCompleter((system) =>
      system === SUMMARIZE_CHUNK_SYSTEM ? "partial" : "FINAL DIGEST",
    );
    const long = Array.from({ length: 40 }, (_, i) => `@u${i}: message number ${i} here.`).join(
      "\n",
    );
    const out = await summarizeTranscript({
      transcript: long,
      channelName: "general",
      complete,
      inputTokenLimit: 1500,
      finalSystem: (isChunked) =>
        catchupDigestSystem({ channelName: "general", callerName: "rodrigo", isChunked }),
    });
    expect(out).toBe("FINAL DIGEST");
    const finalCall = calls.at(-1);
    expect(finalCall?.system).toContain("@rodrigo");
    expect(finalCall?.system).toContain("partial summaries");
  });
});
