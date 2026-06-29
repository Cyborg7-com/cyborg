import { describe, it, expect } from "vitest";
import {
  curateAgentActivity,
  curateLastActivity,
  MAX_TOOL_INPUT_CHARS,
  MAX_TOOL_SUMMARY_CHARS,
} from "./activity-curator.js";
import type { StreamEntry } from "./state.svelte.js";
import type { ToolCallDetail } from "./types.js";

// Pure curator tests (#594) — port of Paseo's activity-curator behaviors onto
// our StreamEntry timeline. No DOM, no client, no stream state. Each test maps
// to a falsifiable-DONE behavior from the issue.

let seq = 0;
function id(): string {
  return `e${++seq}`;
}

function text(content: string): StreamEntry {
  return { id: id(), kind: "text", content };
}
function thinking(content: string): StreamEntry {
  return { id: id(), kind: "thinking", content };
}
function user(content: string): StreamEntry {
  return { id: id(), kind: "user_message", content };
}
function err(content: string): StreamEntry {
  return { id: id(), kind: "error", content };
}
function boundary(): StreamEntry {
  return { id: id(), kind: "turn_boundary" };
}
function tool(
  name: string,
  status: "running" | "completed" | "failed" | "canceled",
  detail: ToolCallDetail,
): StreamEntry {
  return { id: id(), kind: "tool_call", callId: `c${id()}`, name, status, detail, error: null };
}
function shell(command: string, status: "running" | "completed" = "running"): StreamEntry {
  return tool("Bash", status, { type: "shell", command });
}

describe("curateLastActivity — empty / no-activity", () => {
  it("returns null for an empty timeline", () => {
    expect(curateLastActivity([])).toBeNull();
  });

  it("returns null for a timeline of only turn boundaries", () => {
    expect(curateLastActivity([boundary(), boundary()])).toBeNull();
  });
});

describe("contiguous assistant text coalesces into one [Assistant] line", () => {
  it("merges adjacent text entries into a single labeled line", () => {
    // appendText trims each chunk and joins with "\n" (Paseo behavior), so the
    // trailing space on "Hello " is dropped at the join.
    const lines = curateAgentActivity([text("Hello "), text("world"), text("!")]);
    expect(lines).toHaveLength(1);
    expect(lines[0].line).toBe("[Assistant] Hello\nworld\n!");
    expect(lines[0].label).toBe("Assistant");
    expect(lines[0].kind).toBe("Assistant");
    expect(lines[0].text).toBe("Hello\nworld\n!");
  });

  it("last activity for an assistant-only timeline is that [Assistant] line", () => {
    const last = curateLastActivity([text("Done — 42 passing")]);
    expect(last?.line).toBe("[Assistant] Done — 42 passing");
    expect(last?.label).toBe("Assistant");
  });

  it("can omit the [Assistant] prefix when labelAssistantMessages=false", () => {
    const last = curateLastActivity([text("raw text")], { labelAssistantMessages: false });
    expect(last?.line).toBe("raw text");
    expect(last?.label).toBe("Assistant");
  });
});

describe("contiguous reasoning coalesces into one [Thought] line", () => {
  it("merges adjacent thinking entries", () => {
    const lines = curateAgentActivity([thinking("Let me "), thinking("think about it")]);
    expect(lines).toHaveLength(1);
    expect(lines[0].line).toBe("[Thought] Let me\nthink about it");
    expect(lines[0].kind).toBe("Thought");
  });

  it("separates an assistant block and a following thought block", () => {
    // text, then text → one [Assistant]; then thinking → one [Thought].
    const lines = curateAgentActivity([text("answer"), thinking("reflecting")]);
    expect(lines.map((l) => l.line)).toEqual(["[Assistant] answer", "[Thought] reflecting"]);
  });
});

describe("tool calls dedup by status — running→done shows once, latest", () => {
  it("our timeline already merges by callId; a completed tool renders one line", () => {
    // State merges running→completed in place by callId, so the curator sees ONE
    // entry carrying the latest status. The output is a single tool line.
    const lines = curateAgentActivity([shell("pnpm test", "completed")]);
    expect(lines).toHaveLength(1);
    expect(lines[0].line).toBe("[Shell] pnpm test");
    expect(lines[0].kind).toBe("Tool");
    expect(lines[0].label).toBe("Shell");
  });

  it("a running tool surfaces as the last activity", () => {
    const last = curateLastActivity([text("ok"), shell("pnpm test", "running")]);
    expect(last?.line).toBe("[Shell] pnpm test");
  });
});

describe("tool display names + summaries from detail", () => {
  it("read/edit/write summarize to the file's last path segment", () => {
    expect(
      curateLastActivity([tool("Read", "completed", { type: "read", filePath: "/a/b/foo.ts" })])
        ?.line,
    ).toBe("[Read] foo.ts");
    expect(
      curateLastActivity([tool("Edit", "completed", { type: "edit", filePath: "/a/b/bar.ts" })])
        ?.line,
    ).toBe("[Edit] bar.ts");
    expect(
      curateLastActivity([tool("Write", "completed", { type: "write", filePath: "/x/baz.md" })])
        ?.line,
    ).toBe("[Write] baz.md");
  });

  it("read/edit/write summarize a Windows path to its basename", () => {
    // A daemon on Windows emits backslash paths; lastPathSegment must split on
    // `\` too, otherwise the whole `C:\…\file` absolute path leaks as the summary.
    expect(
      curateLastActivity([
        tool("Read", "completed", { type: "read", filePath: "C:\\Users\\dev\\proj\\app.ts" }),
      ])?.line,
    ).toBe("[Read] app.ts");
    expect(
      curateLastActivity([
        tool("Write", "completed", { type: "write", filePath: "D:\\work\\notes.md\\" }),
      ])?.line,
    ).toBe("[Write] notes.md");
  });

  it("search/fetch summarize to query/url", () => {
    expect(
      curateLastActivity([tool("Grep", "completed", { type: "search", query: "needle" })])?.line,
    ).toBe("[Search] needle");
    expect(
      curateLastActivity([tool("Fetch", "completed", { type: "fetch", url: "https://x.dev" })])
        ?.line,
    ).toBe("[Fetch] https://x.dev");
  });

  it("a detail-less unknown tool renders just the bracketed display name", () => {
    const last = curateLastActivity([
      tool("custom_tool", "running", { type: "unknown", input: undefined, output: undefined }),
    ]);
    // humanizeToolName title-cases each `_`-separated segment.
    expect(last?.line).toBe("[Custom Tool]");
    expect(last?.text).toBe("");
  });
});

describe("external (namespaced/MCP) tool input collapse", () => {
  it("collapses a namespaced tool's unknown input to raw JSON", () => {
    const last = curateLastActivity([
      tool("mcp__supabase__execute_sql", "running", {
        type: "unknown",
        input: { query: "select 1" },
        output: undefined,
      }),
    ]);
    expect(last?.line).toBe('[mcp__supabase__execute_sql] {"query":"select 1"}');
  });

  it("a non-external tool with unknown input but no summary shows just the name", () => {
    const last = curateLastActivity([
      tool("localtool", "running", { type: "unknown", input: { a: 1 }, output: undefined }),
    ]);
    // `localtool` is not namespaced → not external → input is NOT surfaced.
    expect(last?.line).toBe("[Localtool]");
  });

  it("an external tool with a TYPED detail falls back to the summary, not `null`", () => {
    // Regression (#724): a namespaced/MCP tool whose detail is a typed variant
    // (e.g. read) has no `unknown.input`. inputFromUnknownDetail must yield
    // `undefined` (→ formatToolInputJson null) so the external branch is skipped
    // and the typed summary is used — NOT the JSON string "null".
    const last = curateLastActivity([
      tool("mcp__fs__read_file", "running", { type: "read", filePath: "/etc/hosts" }),
    ]);
    expect(last?.line).toBe("[Read] hosts");
    expect(last?.line).not.toContain("null");
  });

  it("an external tool with a TYPED but summary-less detail shows just the name", () => {
    // Same regression, no summary to fall back to (plan has none): the line is
    // the bare display name, never `[Name] null`.
    const last = curateLastActivity([
      tool("mcp__planner__plan", "running", { type: "plan", text: "do the thing" }),
    ]);
    expect(last?.line).toBe("[Plan]");
    expect(last?.line).not.toContain("null");
  });
});

describe("[Error] labeling", () => {
  it("labels an error entry and is the last activity when it ends the turn", () => {
    const last = curateLastActivity([shell("pnpm test", "completed"), err("exit code 1")]);
    expect(last?.line).toBe("[Error] exit code 1");
    expect(last?.kind).toBe("Error");
    expect(last?.label).toBe("Error");
  });
});

describe("todo → [Tasks] with active item + progress", () => {
  it("summarizes the first incomplete task with a done/total count", () => {
    const last = curateLastActivity([
      {
        id: id(),
        kind: "todo",
        items: [
          { text: "write curator", completed: true },
          { text: "wire derived", completed: false },
          { text: "render row", completed: false },
        ],
      },
    ]);
    expect(last?.line).toBe("[Tasks] wire derived (1/3)");
    expect(last?.kind).toBe("Tasks");
  });

  it("reports done/total when all tasks complete", () => {
    const last = curateLastActivity([
      { id: id(), kind: "todo", items: [{ text: "x", completed: true }] },
    ]);
    expect(last?.line).toBe("[Tasks] 1/1 done");
  });
});

describe("compaction → [Compacted]", () => {
  it("labels a compaction entry", () => {
    const last = curateLastActivity([{ id: id(), kind: "compaction", status: "completed" }]);
    expect(last?.line).toBe("[Compacted]");
    expect(last?.kind).toBe("Compacted");
  });
});

describe("user message → [User]", () => {
  it("labels a trailing user message", () => {
    const last = curateLastActivity([text("done"), boundary(), user("now do X")]);
    expect(last?.line).toBe("[User] now do X");
    expect(last?.kind).toBe("User");
  });
});

describe("truncation at the Paseo limits", () => {
  it("truncates a tool summary to MAX_TOOL_SUMMARY_CHARS with an ellipsis", () => {
    const longCmd = "x".repeat(MAX_TOOL_SUMMARY_CHARS + 50);
    const last = curateLastActivity([shell(longCmd, "running")]);
    const summary = last!.line.slice("[Shell] ".length);
    expect(summary.length).toBe(MAX_TOOL_SUMMARY_CHARS);
    expect(summary.endsWith("...")).toBe(true);
  });

  it("normalizes whitespace inside a tool summary before truncating", () => {
    const last = curateLastActivity([shell("echo   a\n\nb", "running")]);
    expect(last?.line).toBe("[Shell] echo a b");
  });

  it("truncates an external tool's JSON input to MAX_TOOL_INPUT_CHARS", () => {
    const bigValue = "y".repeat(MAX_TOOL_INPUT_CHARS + 100);
    const last = curateLastActivity([
      tool("mcp__x__y", "running", {
        type: "unknown",
        input: { v: bigValue },
        output: undefined,
      }),
    ]);
    const jsonPart = last!.line.slice("[mcp__x__y] ".length);
    expect(jsonPart.length).toBe(MAX_TOOL_INPUT_CHARS + 3); // sliced body + "..."
    expect(jsonPart.endsWith("...")).toBe(true);
  });
});

describe("maxItems cap (tail window over the timeline)", () => {
  it("only the last `maxItems` raw entries are curated", () => {
    const lines = curateAgentActivity(
      [text("first"), shell("a", "completed"), shell("b", "completed"), shell("c", "completed")],
      { maxItems: 1 },
    );
    // Window = last 1 raw entry = the `c` shell call.
    expect(lines).toHaveLength(1);
    expect(lines[0].line).toBe("[Shell] c");
  });

  it("maxItems=0 keeps the full timeline", () => {
    const lines = curateAgentActivity([text("a"), shell("b", "completed")], { maxItems: 0 });
    expect(lines.map((l) => l.line)).toEqual(["[Assistant] a", "[Shell] b"]);
  });
});

describe("realistic interleaved turn → last activity tracks the stream head", () => {
  it("[bash] running… then [Assistant] Done reflects the latest", () => {
    const running: StreamEntry[] = [
      user("run the tests"),
      thinking("planning"),
      shell("pnpm test", "running"),
    ];
    expect(curateLastActivity(running)?.line).toBe("[Shell] pnpm test");

    // Stream advances: tool completes (merged in place by callId), assistant replies.
    const done: StreamEntry[] = [
      user("run the tests"),
      thinking("planning"),
      shell("pnpm test", "completed"),
      text("Done — 42 passing"),
    ];
    expect(curateLastActivity(done)?.line).toBe("[Assistant] Done — 42 passing");
  });

  it("the full curated list coalesces the turn into ordered labeled lines", () => {
    const lines = curateAgentActivity([
      user("run the tests"),
      thinking("planning "),
      thinking("approach"),
      shell("pnpm test", "completed"),
      text("Done — "),
      text("42 passing"),
    ]);
    expect(lines.map((l) => l.line)).toEqual([
      "[User] run the tests",
      "[Thought] planning\napproach",
      "[Shell] pnpm test",
      "[Assistant] Done —\n42 passing",
    ]);
  });
});
