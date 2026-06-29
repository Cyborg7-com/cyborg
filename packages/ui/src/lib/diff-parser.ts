// Pure diff engine extracted from components/message/DiffView.svelte (#511).
//
// ToolCallDetail only carries raw strings (unifiedDiff / oldString / newString /
// content), so consumers parse them into a structured diff model
// (files -> hunks -> lines) for rendering. No external deps, no DOM — this is a
// pure, branch-heavy parser that benefits from unit tests and can be reused by a
// future code-review/diff surface.

export type LineKind = "add" | "remove" | "context" | "header";

export interface DiffLine {
  kind: LineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface DiffFile {
  path: string;
  lines: DiffLine[];
  additions: number;
  deletions: number;
}

// A row in split view: left cell (old side) and right cell (new side). A
// header spans the full width; context appears on both sides.
export interface SplitRow {
  header?: string;
  left: DiffLine | null;
  right: DiffLine | null;
}

const LCS_LINE_CAP = 4000;

export function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

function stripDiffPrefix(p: string): string {
  // git diff paths look like "a/src/foo.ts" / "b/src/foo.ts"
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

export function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  // @@ -oldStart[,oldCount] +newStart[,newCount] @@
  const m = /^@@+\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@+/.exec(line);
  if (!m) return null;
  return { oldStart: Number(m[1]), newStart: Number(m[2]) };
}

// oxlint-disable-next-line eslint/complexity -- verbatim move (#511); single line-type dispatch loop, not refactored
export function parseUnifiedDiff(diff: string, fallbackPath: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;

  const ensureFile = (path: string): DiffFile => {
    if (!current) {
      current = { path, lines: [], additions: 0, deletions: 0 };
      files.push(current);
    }
    return current;
  };

  // Split on /\r?\n/ so CRLF (Windows) diffs don't leave a trailing \r on every
  // line, which would corrupt prefix checks and the parsed line text.
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("diff --git")) {
      // New file boundary. Best-effort path from the header itself.
      const m = /\sb\/(\S+)\s*$/.exec(raw);
      current = { path: m ? m[1] : fallbackPath, lines: [], additions: 0, deletions: 0 };
      files.push(current);
      continue;
    }
    // A new file boundary in plain `diff -u` output (no `diff --git`) is
    // signalled by the `---`/`+++` header pair. Start a fresh file once the
    // current one already has lines so we don't overwrite its path and merge
    // every subsequent file's lines into it.
    if (raw.startsWith("--- ")) {
      const path = stripDiffPrefix(raw.slice(4).trim());
      if (path && path !== "/dev/null") {
        if (current && current.lines.length > 0) current = null;
        ensureFile(path).path = path;
      }
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const path = stripDiffPrefix(raw.slice(4).trim());
      if (path && path !== "/dev/null") {
        if (current && current.lines.length > 0) current = null;
        ensureFile(path).path = path;
      }
      continue;
    }
    if (
      raw.startsWith("index ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("rename ") ||
      raw.startsWith("similarity ")
    ) {
      continue;
    }
    const hunk = parseHunkHeader(raw);
    if (hunk) {
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      ensureFile(fallbackPath).lines.push({ kind: "header", oldNo: null, newNo: null, text: raw });
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"

    const file = ensureFile(fallbackPath);
    if (raw.startsWith("+")) {
      file.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: raw.slice(1) });
      file.additions++;
    } else if (raw.startsWith("-")) {
      file.lines.push({ kind: "remove", oldNo: oldNo++, newNo: null, text: raw.slice(1) });
      file.deletions++;
    } else {
      // context line (leading space, or a bare line)
      const text = raw.startsWith(" ") ? raw.slice(1) : raw;
      file.lines.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text });
    }
  }
  return files.filter((f) => f.lines.length > 0);
}

// Line-based diff of two whole strings via LCS. Used when only oldString /
// newString are available (no precomputed unified diff).
export function diffStrings(oldStr: string, newStr: string, path: string): DiffFile {
  // Split on /\r?\n/ so a CRLF side compared against an LF side doesn't keep a
  // trailing \r and make the LCS equality check (oldLines[i] === newLines[j])
  // always fail — which would mark every line removed then re-added.
  const oldLines = oldStr.length ? oldStr.split(/\r?\n/) : [];
  const newLines = newStr.length ? newStr.split(/\r?\n/) : [];
  const file: DiffFile = { path, lines: [], additions: 0, deletions: 0 };

  if (oldLines.length + newLines.length > LCS_LINE_CAP) {
    // Too large to LCS cheaply — show removes then adds.
    let o = 1;
    let n = 1;
    for (const t of oldLines) {
      file.lines.push({ kind: "remove", oldNo: o++, newNo: null, text: t });
      file.deletions++;
    }
    for (const t of newLines) {
      file.lines.push({ kind: "add", oldNo: null, newNo: n++, text: t });
      file.additions++;
    }
    return file;
  }

  const m = oldLines.length;
  const k = newLines.length;
  // Flat Int32Array (row-major, stride = k + 1) instead of nested arrays:
  // avoids allocating millions of boxed numbers and the GC churn that comes
  // with it near the LCS_LINE_CAP ceiling.
  const stride = k + 1;
  const dp = new Int32Array((m + 1) * stride);
  for (let i = m - 1; i >= 0; i--) {
    const rowOffset = i * stride;
    const nextRowOffset = (i + 1) * stride;
    for (let j = k - 1; j >= 0; j--) {
      dp[rowOffset + j] =
        oldLines[i] === newLines[j]
          ? dp[nextRowOffset + j + 1] + 1
          : Math.max(dp[nextRowOffset + j], dp[rowOffset + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < m && j < k) {
    if (oldLines[i] === newLines[j]) {
      file.lines.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text: oldLines[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * stride + j] >= dp[i * stride + j + 1]) {
      file.lines.push({ kind: "remove", oldNo: oldNo++, newNo: null, text: oldLines[i] });
      file.deletions++;
      i++;
    } else {
      file.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: newLines[j] });
      file.additions++;
      j++;
    }
  }
  while (i < m) {
    file.lines.push({ kind: "remove", oldNo: oldNo++, newNo: null, text: oldLines[i++] });
    file.deletions++;
  }
  while (j < k) {
    file.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: newLines[j++] });
    file.additions++;
  }
  return file;
}

// A whole new file (write tool): every line is an addition.
export function additionsOnly(content: string, path: string): DiffFile {
  // Split on /\r?\n/ so CRLF content doesn't leave a trailing \r on each line.
  const lines = content.split(/\r?\n/);
  const file: DiffFile = { path, lines: [], additions: 0, deletions: 0 };
  let n = 1;
  for (const t of lines) {
    file.lines.push({ kind: "add", oldNo: null, newNo: n++, text: t });
    file.additions++;
  }
  return file;
}

// Pair removes with adds for split view, leaving unmatched lines one-sided.
export function buildSplitRows(file: DiffFile): SplitRow[] {
  const rows: SplitRow[] = [];
  let removeBuf: DiffLine[] = [];
  let addBuf: DiffLine[] = [];

  const flush = () => {
    const n = Math.max(removeBuf.length, addBuf.length);
    for (let idx = 0; idx < n; idx++) {
      rows.push({ left: removeBuf[idx] ?? null, right: addBuf[idx] ?? null });
    }
    removeBuf = [];
    addBuf = [];
  };

  for (const line of file.lines) {
    if (line.kind === "remove") {
      removeBuf.push(line);
    } else if (line.kind === "add") {
      addBuf.push(line);
    } else if (line.kind === "header") {
      flush();
      rows.push({ header: line.text, left: null, right: null });
    } else {
      flush();
      rows.push({ left: line, right: line });
    }
  }
  flush();
  return rows;
}
