// Pure helpers for turning a tool call's target into an openable file path.
//
// Mirrors Paseo's `packages/app/src/utils/extract-tool-call-file-path.ts`
// (which `tool-calls/presentation.ts:76` surfaces as `openFilePath`): a
// read/edit/write detail's `filePath` is the target, and a `shell` command's
// last argument is the target when the command is a known file-reading one.
//
// On top of that, `parseFilePathToken` splits an optional trailing line range
// off the path string (`foo.ts:42`, `foo.ts:42-50`, `foo.ts:42:7`) so the UI
// can show / copy a precise location. The path itself stays untouched —
// Cyborg7 has no IDE pane, so "open" is a copy-path affordance (the line range
// rides along), not a main/side editor split. Keeping the parse here (no DOM)
// makes the regex unit-testable.

import type { ToolCallDetail } from "./types.js";

// Shell commands whose final argument is a file we'd want to open. Mirrors the
// Paseo set so behavior matches across the two apps.
const SHELL_FILE_COMMANDS = new Set([
  "cat",
  "bat",
  "less",
  "more",
  "head",
  "tail",
  "wc",
  "nl",
  "tac",
  "od",
  "xxd",
  "file",
  "stat",
  "column",
  "md5",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "shasum",
]);

// A shell operator means the "last token" heuristic is unreliable (pipes,
// redirects, subshells), so bail rather than guess a wrong path.
const SHELL_OPERATOR_PATTERN = /[|><&;`$()]/;
const SHORT_FLAG_PATTERN = /^-[a-zA-Z]$/;

// Trailing `:line`, `:line-line`, or `:line:col` suffix on a path token.
// Captures: 1 = path, 2 = start line, 3 = end line (range), 4 = column.
// Only fully-numeric segments after a colon count, so a Windows drive letter
// (`C:\…`) or a `http://` scheme is never mistaken for a line range.
const LINE_SUFFIX_PATTERN = /^(.*?):(\d+)(?:-(\d+))?(?::(\d+))?$/;

// A token is "path-like" if it has a directory separator OR a file extension.
// Rejects bare words ("README", "true"), flags, and URLs. Deliberately
// permissive on the rest (relative paths, `~/…`, spaces are pre-split out by
// the shell tokenizer) — the goal is "looks openable", not strict validation.
const PATH_LIKE_PATTERN = /[\\/]|\.[A-Za-z0-9]+$/;
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

export interface ParsedFilePath {
  // The path with any `:line` suffix stripped (what an editor would open).
  path: string;
  // First line of the range, when the token carried one.
  lineStart?: number;
  // Last line of an explicit `start-end` range (absent for a single line).
  lineEnd?: number;
}

function extractFromShellCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed || SHELL_OPERATOR_PATTERN.test(trimmed)) {
    return null;
  }
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2) {
    return null;
  }
  if (!SHELL_FILE_COMMANDS.has(tokens[0])) {
    return null;
  }
  const last = tokens[tokens.length - 1];
  if (last.startsWith("-")) {
    return null;
  }
  if (tokens.length > 2) {
    const prev = tokens[tokens.length - 2];
    if (!prev.startsWith("-")) {
      const prevPrev = tokens[tokens.length - 3];
      if (!prevPrev || !SHORT_FLAG_PATTERN.test(prevPrev)) {
        return null;
      }
    }
  }
  return last;
}

// The openable target of a tool call, or null when there isn't one. Additive
// mirror of Paseo's `extractToolCallFilePath` — read/edit/write expose their
// `filePath`; a file-reading shell command exposes its last argument.
export function extractToolCallFilePath(detail: ToolCallDetail | undefined): string | null {
  if (!detail) {
    return null;
  }
  switch (detail.type) {
    case "read":
    case "edit":
    case "write":
      return detail.filePath || null;
    case "shell":
      return extractFromShellCommand(detail.command);
    default:
      return null;
  }
}

// True when a raw token (post line-suffix strip) looks like a file path we'd
// linkify: has a separator or extension, isn't a URL, isn't a bare flag.
export function isFilePathLike(token: string): boolean {
  const t = token.trim();
  if (!t || t.startsWith("-")) return false;
  if (URL_SCHEME_PATTERN.test(t)) return false;
  return PATH_LIKE_PATTERN.test(t);
}

// Split a path token into its path + optional line range. Returns null when the
// token doesn't look like a path at all (so callers can fall back to plain
// text). A `:line` suffix is only peeled off a token whose remaining path is
// itself path-like, so `foo:42` (no slash/ext) is rejected but `a/foo:42` and
// `foo.ts:42` parse.
export function parseFilePathToken(token: string | null | undefined): ParsedFilePath | null {
  if (!token) return null;
  const raw = token.trim();
  if (!raw) return null;

  const m = LINE_SUFFIX_PATTERN.exec(raw);
  if (m) {
    const path = m[1];
    // Only treat the suffix as a line range when the leading part is a real
    // path (guards `C:\Users` → drive letter, `12:34` → not a path).
    if (isFilePathLike(path)) {
      const lineStart = Number(m[2]);
      const lineEnd = m[3] !== undefined ? Number(m[3]) : undefined;
      return { path, lineStart, ...(lineEnd !== undefined ? { lineEnd } : {}) };
    }
  }

  if (!isFilePathLike(raw)) return null;
  return { path: raw };
}

// Canonical single-string form of a parsed location, e.g. `foo.ts`,
// `foo.ts:42`, `foo.ts:42-50`. This is what we copy to the clipboard so the
// line range travels with the path.
export function formatFileLocation(parsed: ParsedFilePath): string {
  if (parsed.lineStart === undefined) return parsed.path;
  if (parsed.lineEnd !== undefined && parsed.lineEnd !== parsed.lineStart) {
    return `${parsed.path}:${parsed.lineStart}-${parsed.lineEnd}`;
  }
  return `${parsed.path}:${parsed.lineStart}`;
}
