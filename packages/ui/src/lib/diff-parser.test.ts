import { describe, it, expect } from "vitest";
import {
  additionsOnly,
  basename,
  buildSplitRows,
  diffStrings,
  parseHunkHeader,
  parseUnifiedDiff,
  type DiffFile,
  type DiffLine,
} from "./diff-parser.js";

// Pure diff-engine tests (#511) — the parser extracted out of DiffView.svelte.
// These pin the now-pure behavior (no DOM, no client) so the move stays honest.

describe("basename", () => {
  it("returns the last path segment", () => {
    expect(basename("src/lib/foo.ts")).toBe("foo.ts");
    expect(basename("foo.ts")).toBe("foo.ts");
  });

  it("falls back to the whole string for a trailing slash / empty tail", () => {
    expect(basename("src/lib/")).toBe("src/lib/");
    expect(basename("")).toBe("");
  });
});

describe("parseHunkHeader", () => {
  it("parses @@ -old,+new @@ with counts", () => {
    expect(parseHunkHeader("@@ -12,4 +13,6 @@ func()")).toEqual({ oldStart: 12, newStart: 13 });
  });

  it("parses hunk headers without counts", () => {
    expect(parseHunkHeader("@@ -1 +1 @@")).toEqual({ oldStart: 1, newStart: 1 });
  });

  it("parses combined-diff style with extra @ markers", () => {
    expect(parseHunkHeader("@@@ -1,2 +1,2 @@@")).toEqual({ oldStart: 1, newStart: 1 });
  });

  it("returns null for non-hunk lines", () => {
    expect(parseHunkHeader("not a hunk")).toBeNull();
    expect(parseHunkHeader("+added line")).toBeNull();
    expect(parseHunkHeader("@@ malformed @@")).toBeNull();
  });
});

describe("parseUnifiedDiff — basic git diff -> hunks/lines", () => {
  const diff = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "index e69de29..4b825dc 100644",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1,3 +1,4 @@",
    " context one",
    "-removed line",
    "+added line A",
    "+added line B",
    " context two",
  ].join("\n");

  it("derives the path from the `diff --git` header (b/ side)", () => {
    const files = parseUnifiedDiff(diff, "fallback");
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/foo.ts");
  });

  it("counts additions and deletions", () => {
    const [file] = parseUnifiedDiff(diff, "fallback");
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(1);
  });

  it("emits the header line plus typed body lines with line numbers", () => {
    const [file] = parseUnifiedDiff(diff, "fallback");
    expect(file.lines.map((l) => l.kind)).toEqual([
      "header",
      "context",
      "remove",
      "add",
      "add",
      "context",
    ]);

    const header = file.lines[0];
    expect(header).toMatchObject({
      kind: "header",
      oldNo: null,
      newNo: null,
      text: "@@ -1,3 +1,4 @@",
    });

    // Old/new numbering starts at the hunk's declared starts and advances per side.
    expect(file.lines[1]).toMatchObject({
      kind: "context",
      oldNo: 1,
      newNo: 1,
      text: "context one",
    });
    expect(file.lines[2]).toMatchObject({
      kind: "remove",
      oldNo: 2,
      newNo: null,
      text: "removed line",
    });
    expect(file.lines[3]).toMatchObject({
      kind: "add",
      oldNo: null,
      newNo: 2,
      text: "added line A",
    });
    expect(file.lines[4]).toMatchObject({
      kind: "add",
      oldNo: null,
      newNo: 3,
      text: "added line B",
    });
    expect(file.lines[5]).toMatchObject({
      kind: "context",
      oldNo: 3,
      newNo: 4,
      text: "context two",
    });
  });

  it("strips exactly one leading +/-/space and ignores the `\\ No newline` marker", () => {
    const d = ["@@ -1 +1 @@", "+ has a leading space kept", "\\ No newline at end of file"].join(
      "\n",
    );
    const [file] = parseUnifiedDiff(d, "f");
    // "+ ..." -> slice(1) keeps the leading space; the "\" line is skipped.
    expect(file.lines.map((l) => l.kind)).toEqual(["header", "add"]);
    expect(file.lines[1].text).toBe(" has a leading space kept");
  });

  it("handles CRLF line endings in the unified diff string", () => {
    // Windows diffs use \r\n; splitting on /\r?\n/ must not leave a trailing \r
    // on the kind-detection prefix or in the captured line text.
    const d = "@@ -1 +1 @@\r\n+added line\r\n context line";
    const [file] = parseUnifiedDiff(d, "f");
    expect(file.lines.map((l) => l.kind)).toEqual(["header", "add", "context"]);
    expect(file.lines[1].text).toBe("added line");
    expect(file.lines[2].text).toBe("context line");
  });
});

describe("parseUnifiedDiff — multi-file boundaries", () => {
  it("splits multiple `diff --git` files", () => {
    const diff = [
      "diff --git a/one.ts b/one.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/two.ts b/two.ts",
      "@@ -1 +1 @@",
      "-c",
      "+d",
    ].join("\n");
    const files = parseUnifiedDiff(diff, "fallback");
    expect(files.map((f) => f.path)).toEqual(["one.ts", "two.ts"]);
    expect(files.every((f) => f.additions === 1 && f.deletions === 1)).toBe(true);
  });

  it("splits plain `diff -u` output (no `diff --git`) on the ---/+++ pair", () => {
    const diff = [
      "--- a/one.ts",
      "+++ b/one.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "--- a/two.ts",
      "+++ b/two.ts",
      "@@ -1 +1 @@",
      "-c",
      "+d",
    ].join("\n");
    const files = parseUnifiedDiff(diff, "fallback");
    expect(files.map((f) => f.path)).toEqual(["one.ts", "two.ts"]);
  });

  it("uses fallbackPath when no header path is present", () => {
    const diff = ["@@ -1 +1 @@", "-a", "+b"].join("\n");
    const [file] = parseUnifiedDiff(diff, "my/fallback.ts");
    expect(file.path).toBe("my/fallback.ts");
  });

  it("treats /dev/null paths as absent (new/deleted file)", () => {
    const diff = [
      "--- /dev/null",
      "+++ b/created.ts",
      "@@ -0,0 +1,2 @@",
      "+line one",
      "+line two",
    ].join("\n");
    const [file] = parseUnifiedDiff(diff, "fallback");
    expect(file.path).toBe("created.ts");
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(0);
  });

  it("skips index/new file/deleted/rename/similarity metadata lines", () => {
    const diff = [
      "diff --git a/r.ts b/r.ts",
      "similarity index 95%",
      "rename from old.ts",
      "rename to r.ts",
      "new file mode 100644",
      "deleted file mode 100644",
      "index 111..222 100644",
      "@@ -1 +1 @@",
      "+x",
    ].join("\n");
    const [file] = parseUnifiedDiff(diff, "fallback");
    // Only the header + the single add survive; no metadata leaks into lines.
    expect(file.lines.map((l) => l.kind)).toEqual(["header", "add"]);
  });
});

describe("parseUnifiedDiff — empty / malformed", () => {
  it("yields a single empty context line for an empty string", () => {
    // `"".split("\n")` is `[""]`, so one bare (context) line is produced and the
    // file survives the `lines.length > 0` filter. Pinning the real behavior of
    // the moved code (DiffView only calls this when `diff.trim().length > 0`, so
    // this edge isn't reached in the component).
    const files = parseUnifiedDiff("", "f");
    expect(files).toHaveLength(1);
    expect(files[0].lines).toEqual([{ kind: "context", oldNo: 0, newNo: 0, text: "" }]);
  });

  it("returns [] for a header-only diff with no body (filtered: 0 lines)", () => {
    // A `diff --git` with no body lines is filtered out (lines.length === 0).
    expect(parseUnifiedDiff("diff --git a/x.ts b/x.ts", "f")).toEqual([]);
  });

  it("treats bare lines with no diff markers as context", () => {
    const [file] = parseUnifiedDiff("just some text\nmore text", "bare.ts");
    expect(file.lines.map((l) => l.kind)).toEqual(["context", "context"]);
    expect(file.lines.map((l) => l.text)).toEqual(["just some text", "more text"]);
  });
});

describe("diffStrings — LCS line diff", () => {
  it("marks every line added when old is empty", () => {
    const file = diffStrings("", "a\nb", "f.ts");
    expect(file.lines.map((l) => l.kind)).toEqual(["add", "add"]);
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(0);
    expect(file.lines[0]).toMatchObject({ oldNo: null, newNo: 1, text: "a" });
    expect(file.lines[1]).toMatchObject({ oldNo: null, newNo: 2, text: "b" });
  });

  it("marks every line removed when new is empty", () => {
    const file = diffStrings("a\nb", "", "f.ts");
    expect(file.lines.map((l) => l.kind)).toEqual(["remove", "remove"]);
    expect(file.additions).toBe(0);
    expect(file.deletions).toBe(2);
  });

  it("produces all-context for identical input", () => {
    const file = diffStrings("a\nb\nc", "a\nb\nc", "f.ts");
    expect(file.lines.map((l) => l.kind)).toEqual(["context", "context", "context"]);
    expect(file.additions).toBe(0);
    expect(file.deletions).toBe(0);
  });

  it("handles mixed CRLF and LF line endings correctly", () => {
    // A CRLF old side vs an LF new side must normalize so the LCS equality check
    // still matches — otherwise every line would read as removed then re-added.
    const file = diffStrings("a\r\nb\r\nc", "a\nb\nc", "f.ts");
    expect(file.lines.map((l) => l.kind)).toEqual(["context", "context", "context"]);
    expect(file.additions).toBe(0);
    expect(file.deletions).toBe(0);
  });

  it("keeps a common prefix/suffix as context around a modified middle line", () => {
    const file = diffStrings("a\nB\nc", "a\nX\nc", "f.ts");
    expect(file.lines.map((l) => l.kind)).toEqual(["context", "remove", "add", "context"]);
    expect(file.lines[1]).toMatchObject({ kind: "remove", oldNo: 2, newNo: null, text: "B" });
    expect(file.lines[2]).toMatchObject({ kind: "add", oldNo: null, newNo: 2, text: "X" });
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
  });

  it("recognizes a pure insertion in the middle (LCS keeps surrounding lines)", () => {
    const file = diffStrings("a\nc", "a\nb\nc", "f.ts");
    expect(file.lines.map((l) => l.kind)).toEqual(["context", "add", "context"]);
    expect(file.lines[1]).toMatchObject({ kind: "add", text: "b", newNo: 2 });
    expect(file.lines[2]).toMatchObject({ kind: "context", oldNo: 2, newNo: 3, text: "c" });
  });

  it("recognizes a pure deletion in the middle", () => {
    const file = diffStrings("a\nb\nc", "a\nc", "f.ts");
    expect(file.lines.map((l) => l.kind)).toEqual(["context", "remove", "context"]);
    expect(file.lines[1]).toMatchObject({ kind: "remove", text: "b", oldNo: 2 });
  });

  it("numbers old/new sides independently across a mixed diff", () => {
    const file = diffStrings("a\nb\nc\nd", "a\nx\nc\ny\nd", "f.ts");
    const lastContext = file.lines[file.lines.length - 1];
    expect(lastContext).toMatchObject({ kind: "context", text: "d" });
    // "d" is line 4 on the old side, line 5 on the new side.
    expect(lastContext.oldNo).toBe(4);
    expect(lastContext.newNo).toBe(5);
  });
});

describe("additionsOnly", () => {
  it("marks every line of content as an addition with sequential newNo", () => {
    const file = additionsOnly("one\ntwo\nthree", "new.ts");
    expect(file.path).toBe("new.ts");
    expect(file.lines.map((l) => l.kind)).toEqual(["add", "add", "add"]);
    expect(file.lines.map((l) => l.newNo)).toEqual([1, 2, 3]);
    expect(file.lines.every((l) => l.oldNo === null)).toBe(true);
    expect(file.additions).toBe(3);
    expect(file.deletions).toBe(0);
  });

  it("treats empty content as a single empty added line (split on \\n)", () => {
    const file = additionsOnly("", "empty.ts");
    expect(file.lines).toHaveLength(1);
    expect(file.lines[0]).toMatchObject({ kind: "add", newNo: 1, text: "" });
    expect(file.additions).toBe(1);
  });
});

describe("buildSplitRows", () => {
  const line = (
    kind: DiffLine["kind"],
    text: string,
    oldNo: number | null,
    newNo: number | null,
  ): DiffLine => ({
    kind,
    oldNo,
    newNo,
    text,
  });

  it("pairs consecutive removes with adds index-by-index", () => {
    const file: DiffFile = {
      path: "f.ts",
      additions: 2,
      deletions: 2,
      lines: [
        line("remove", "old1", 1, null),
        line("remove", "old2", 2, null),
        line("add", "new1", null, 1),
        line("add", "new2", null, 2),
      ],
    };
    const rows = buildSplitRows(file);
    expect(rows).toHaveLength(2);
    expect(rows[0].left?.text).toBe("old1");
    expect(rows[0].right?.text).toBe("new1");
    expect(rows[1].left?.text).toBe("old2");
    expect(rows[1].right?.text).toBe("new2");
  });

  it("leaves unmatched removes/adds one-sided when counts differ", () => {
    const file: DiffFile = {
      path: "f.ts",
      additions: 1,
      deletions: 2,
      lines: [
        line("remove", "old1", 1, null),
        line("remove", "old2", 2, null),
        line("add", "new1", null, 1),
      ],
    };
    const rows = buildSplitRows(file);
    expect(rows).toHaveLength(2);
    expect(rows[1].left?.text).toBe("old2");
    expect(rows[1].right).toBeNull();
  });

  it("emits a full-width header row and flushes pending buffers first", () => {
    const file: DiffFile = {
      path: "f.ts",
      additions: 1,
      deletions: 1,
      lines: [
        line("remove", "old", 1, null),
        line("add", "new", null, 1),
        line("header", "@@ -5 +5 @@", null, null),
        line("context", "ctx", 5, 5),
      ],
    };
    const rows = buildSplitRows(file);
    expect(rows).toHaveLength(3);
    // First the paired remove/add, then the header, then the context on both sides.
    expect(rows[0]).toMatchObject({ left: { text: "old" }, right: { text: "new" } });
    expect(rows[1]).toMatchObject({ header: "@@ -5 +5 @@", left: null, right: null });
    expect(rows[2].left).toBe(rows[2].right); // context shares one DiffLine on both sides
    expect(rows[2].left?.text).toBe("ctx");
  });

  it("puts context lines on both sides", () => {
    const file: DiffFile = {
      path: "f.ts",
      additions: 0,
      deletions: 0,
      lines: [line("context", "same", 1, 1)],
    };
    const [row] = buildSplitRows(file);
    expect(row.left?.text).toBe("same");
    expect(row.right?.text).toBe("same");
    expect(row.header).toBeUndefined();
  });

  it("returns [] for a file with no lines", () => {
    const file: DiffFile = { path: "f.ts", additions: 0, deletions: 0, lines: [] };
    expect(buildSplitRows(file)).toEqual([]);
  });
});
