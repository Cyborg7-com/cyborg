import { describe, it, expect } from "vitest";
import {
  extractToolCallFilePath,
  isFilePathLike,
  parseFilePathToken,
  formatFileLocation,
} from "./tool-call-file-path.js";
import type { ToolCallDetail } from "./types.js";

describe("extractToolCallFilePath", () => {
  it("returns filePath for read/edit/write", () => {
    expect(extractToolCallFilePath({ type: "read", filePath: "/abs/path.ts" })).toBe(
      "/abs/path.ts",
    );
    expect(extractToolCallFilePath({ type: "edit", filePath: "src/a.ts" })).toBe("src/a.ts");
    expect(extractToolCallFilePath({ type: "write", filePath: "out.txt" })).toBe("out.txt");
  });

  it("returns null for read/edit/write with empty path", () => {
    expect(extractToolCallFilePath({ type: "read", filePath: "" })).toBeNull();
  });

  it("parses the last argument of a known file-reading shell command", () => {
    expect(extractToolCallFilePath({ type: "shell", command: "cat src/index.ts" })).toBe(
      "src/index.ts",
    );
    expect(extractToolCallFilePath({ type: "shell", command: "head -n 5 /tmp/log.txt" })).toBe(
      "/tmp/log.txt",
    );
  });

  it("rejects shell commands that aren't file-reading or have operators", () => {
    expect(extractToolCallFilePath({ type: "shell", command: "ls -la" })).toBeNull();
    expect(extractToolCallFilePath({ type: "shell", command: "cat a.ts | grep x" })).toBeNull();
    expect(extractToolCallFilePath({ type: "shell", command: "rm foo.ts" })).toBeNull();
  });

  it("returns null for non-file tool types and undefined", () => {
    expect(extractToolCallFilePath(undefined)).toBeNull();
    expect(extractToolCallFilePath({ type: "fetch", url: "https://x.com" })).toBeNull();
    expect(extractToolCallFilePath({ type: "search", query: "foo" } as ToolCallDetail)).toBeNull();
  });
});

describe("isFilePathLike", () => {
  it("accepts paths with a separator or an extension", () => {
    expect(isFilePathLike("/abs/path.ts")).toBe(true);
    expect(isFilePathLike("src/index")).toBe(true); // has separator
    expect(isFilePathLike("README.md")).toBe(true); // has extension
    expect(isFilePathLike("~/notes.txt")).toBe(true);
    expect(isFilePathLike("a/b/c")).toBe(true);
  });

  it("rejects bare words, flags, URLs, and empties", () => {
    expect(isFilePathLike("README")).toBe(false);
    expect(isFilePathLike("true")).toBe(false);
    expect(isFilePathLike("-n")).toBe(false);
    expect(isFilePathLike("https://example.com/a.ts")).toBe(false);
    expect(isFilePathLike("")).toBe(false);
    expect(isFilePathLike("   ")).toBe(false);
  });
});

describe("parseFilePathToken", () => {
  it("parses a bare path with no line range", () => {
    expect(parseFilePathToken("/abs/path.ts")).toEqual({ path: "/abs/path.ts" });
    expect(parseFilePathToken("src/a.ts")).toEqual({ path: "src/a.ts" });
  });

  it("parses a single-line suffix", () => {
    expect(parseFilePathToken("path.ts:42")).toEqual({ path: "path.ts", lineStart: 42 });
    expect(parseFilePathToken("/abs/x.ts:1")).toEqual({ path: "/abs/x.ts", lineStart: 1 });
  });

  it("parses a line range", () => {
    expect(parseFilePathToken("path.ts:42-50")).toEqual({
      path: "path.ts",
      lineStart: 42,
      lineEnd: 50,
    });
  });

  it("parses line:col, keeping only the line", () => {
    expect(parseFilePathToken("src/a.ts:42:7")).toEqual({ path: "src/a.ts", lineStart: 42 });
  });

  it("does not mistake a Windows drive letter for a line range", () => {
    // No numeric line, and `C:\Users\me\a.ts` is still path-like via separators.
    expect(parseFilePathToken("C:\\Users\\me\\a.ts")).toEqual({ path: "C:\\Users\\me\\a.ts" });
  });

  it("rejects tokens that aren't paths even with a numeric suffix", () => {
    expect(parseFilePathToken("foo:42")).toBeNull(); // no separator/extension
    expect(parseFilePathToken("12:34")).toBeNull();
    expect(parseFilePathToken("README")).toBeNull();
    expect(parseFilePathToken("")).toBeNull();
    expect(parseFilePathToken(null)).toBeNull();
    expect(parseFilePathToken(undefined)).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(parseFilePathToken("  src/a.ts:5  ")).toEqual({ path: "src/a.ts", lineStart: 5 });
  });
});

describe("formatFileLocation", () => {
  it("formats a bare path", () => {
    expect(formatFileLocation({ path: "a.ts" })).toBe("a.ts");
  });

  it("formats a single line", () => {
    expect(formatFileLocation({ path: "a.ts", lineStart: 9 })).toBe("a.ts:9");
  });

  it("formats a range", () => {
    expect(formatFileLocation({ path: "a.ts", lineStart: 9, lineEnd: 20 })).toBe("a.ts:9-20");
  });

  it("collapses a zero-width range to a single line", () => {
    expect(formatFileLocation({ path: "a.ts", lineStart: 9, lineEnd: 9 })).toBe("a.ts:9");
  });

  it("round-trips with parseFilePathToken", () => {
    for (const token of ["a/b.ts", "a/b.ts:42", "a/b.ts:42-50"]) {
      const parsed = parseFilePathToken(token);
      expect(parsed).not.toBeNull();
      expect(formatFileLocation(parsed!)).toBe(token);
    }
  });
});
