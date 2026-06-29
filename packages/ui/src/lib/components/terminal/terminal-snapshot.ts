// Render a Paseo terminal SCREEN SNAPSHOT into an ANSI string (internal docs
// Phase 1). The daemon forwards Paseo's `{type:"snapshot", state}` over the relay
// as a `cyborg:terminal_snapshot` frame (cyborg-messages.ts); this turns the
// serialized `TerminalState` (grid + scrollback cells, styles, cursor) back into
// the escape sequences that repaint an xterm — the same self-heal Paseo's React
// app does in `terminal-stream-controller`.
//
// This is a faithful UI-local port of `@getpaseo/protocol`'s
// `renderTerminalSnapshotToAnsi` (packages/protocol/src/terminal-snapshot.ts).
// It is vendored here rather than imported because packages/ui is deliberately
// decoupled from the @getpaseo/* packages (zero @getpaseo imports in ui/src) and
// must stay buildable on its own (Vite bundle, adapter-static). The shape is
// frozen by the wire contract (TerminalStateSchema), so drift is bounded.

// Wire shape of one terminal cell — mirrors TerminalCellSchema in
// @getpaseo/protocol/messages. All fields are plain JSON (the snapshot survives
// the daemon→relay→client JSON hop with no Buffers / typed arrays).
export interface TerminalCell {
  char: string;
  fg?: number;
  bg?: number;
  fgMode?: number;
  bgMode?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  inverse?: boolean;
  strikethrough?: boolean;
}

export interface TerminalCursor {
  row: number;
  col: number;
  hidden?: boolean;
  style?: "block" | "underline" | "bar";
  blink?: boolean;
}

// Mirrors TerminalStateSchema. `gridWrapped`/`scrollbackWrapped` are the optional
// per-row soft-wrap flags (only present from daemons advertising the reflow cap).
export interface TerminalState {
  rows: number;
  cols: number;
  grid: TerminalCell[][];
  scrollback: TerminalCell[][];
  cursor: TerminalCursor;
  title?: string;
  gridWrapped?: boolean[];
  scrollbackWrapped?: boolean[];
}

interface TerminalStyle {
  fg: number | undefined;
  bg: number | undefined;
  fgMode: number | undefined;
  bgMode: number | undefined;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  dim: boolean;
  inverse: boolean;
  strikethrough: boolean;
}

const DEFAULT_STYLE: TerminalStyle = {
  fg: undefined,
  bg: undefined,
  fgMode: undefined,
  bgMode: undefined,
  bold: false,
  italic: false,
  underline: false,
  dim: false,
  inverse: false,
  strikethrough: false,
};

// True when a snapshot carries NO visible screen content — empty scrollback AND
// an all-blank grid (every cell empty or a space). Such a snapshot must never
// drive a `term.reset()` + repaint: on a PtyHost REHYDRATED re-attach the daemon
// replays the real screen as `cyborg:terminal_output` bytes and THEN emits a
// second, EMPTY `cyborg:terminal_snapshot` (historyReplayed:false, because the
// proxied session has no tracked grid — pty-host-client.ts emptyState). Resetting
// from that empty snapshot WIPES the byte-replayed screen and leaves the terminal
// black with input gated off — the exact "reattached terminal is a black screen"
// bug. A blank snapshot clearing a populated screen is never correct (the live
// output is the authoritative ground truth), so callers skip the repaint.
export function isBlankTerminalState(state: TerminalState): boolean {
  const hasInk = (rows: TerminalCell[][]): boolean => {
    for (const row of rows) {
      for (const cell of row) {
        if (cell.char && cell.char !== " ") return true;
      }
    }
    return false;
  };
  return !hasInk(state.scrollback) && !hasInk(state.grid);
}

export function renderTerminalSnapshotToAnsi(state: TerminalState): string {
  const rows = [...state.scrollback, ...state.grid];
  const wrapFlags = [...(state.scrollbackWrapped ?? []), ...(state.gridWrapped ?? [])];
  // Soft-wrapped lines can only be re-wrapped on resize when we know which rows
  // were continuations. With that per-row flag we replay each logical line as one
  // unbroken run (autowrap on) so xterm marks the continuations wrapped and reflows
  // them. Without it (old daemon) we keep the verbatim per-row replay: autowrap off
  // plus a hard newline per row.
  const hasWrapInfo = wrapFlags.length === rows.length;
  const lines: string[] = hasWrapInfo ? [] : ["\x1b[?7l"];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const continuesToNextRow = hasWrapInfo && wrapFlags[rowIndex] === true;
    // A continuation row must fill the full width so the next row's first cell
    // triggers xterm auto-wrap, which is what marks the row wrapped/reflowable.
    lines.push(renderTerminalRow(row, continuesToNextRow ? state.cols : undefined));
    if (rowIndex < rows.length - 1 && !continuesToNextRow) {
      lines.push("\r\n");
    }
  }

  lines.push("\x1b[0m");
  const cursorPresentationAnsi = renderCursorPresentationToAnsi(state.cursor);
  if (cursorPresentationAnsi) {
    lines.push(cursorPresentationAnsi);
  }
  lines.push(`\x1b[${state.cursor.row + 1};${state.cursor.col + 1}H`);
  lines.push(state.cursor.hidden ? "\x1b[?25l" : "\x1b[?25h");
  if (!hasWrapInfo) {
    lines.push("\x1b[?7h");
  }
  return lines.join("");
}

function renderCursorPresentationToAnsi(cursor: TerminalCursor): string | null {
  if (!cursor.style) {
    return null;
  }

  const cursorStyleCode = (() => {
    if (cursor.style === "block") {
      return cursor.blink === false ? 2 : 1;
    }
    if (cursor.style === "underline") {
      return cursor.blink === false ? 4 : 3;
    }
    return cursor.blink === false ? 6 : 5;
  })();

  return `\x1b[${cursorStyleCode} q`;
}

function renderTerminalRow(row: TerminalCell[], padToCols?: number): string {
  const output: string[] = [];
  const contentLength = getTerminalRowLength(row);
  const length = padToCols !== undefined ? Math.max(contentLength, padToCols) : contentLength;
  let previousStyle = DEFAULT_STYLE;

  for (let index = 0; index < length; index += 1) {
    const cell = row[index] ?? { char: " " };
    const nextStyle = getTerminalStyle(cell);
    if (!terminalStylesEqual(previousStyle, nextStyle)) {
      output.push(styleToAnsi(nextStyle));
      previousStyle = nextStyle;
    }
    output.push(cell.char || " ");
  }

  if (!terminalStylesEqual(previousStyle, DEFAULT_STYLE)) {
    output.push("\x1b[0m");
  }

  return output.join("");
}

function getTerminalRowLength(row: TerminalCell[]): number {
  for (let index = row.length - 1; index >= 0; index -= 1) {
    const cell = row[index];
    if (!cell) {
      continue;
    }
    if (cell.char !== " ") {
      return index + 1;
    }
    if (
      cell.fg !== undefined ||
      cell.bg !== undefined ||
      cell.fgMode !== undefined ||
      cell.bgMode !== undefined ||
      cell.bold ||
      cell.italic ||
      cell.underline ||
      cell.dim ||
      cell.inverse ||
      cell.strikethrough
    ) {
      return index + 1;
    }
  }
  return 0;
}

function getTerminalStyle(cell: TerminalCell): TerminalStyle {
  return {
    fg: cell.fg,
    bg: cell.bg,
    fgMode: cell.fgMode,
    bgMode: cell.bgMode,
    bold: Boolean(cell.bold),
    italic: Boolean(cell.italic),
    underline: Boolean(cell.underline),
    dim: Boolean(cell.dim),
    inverse: Boolean(cell.inverse),
    strikethrough: Boolean(cell.strikethrough),
  };
}

function terminalStylesEqual(left: TerminalStyle, right: TerminalStyle): boolean {
  return (
    left.fg === right.fg &&
    left.bg === right.bg &&
    left.fgMode === right.fgMode &&
    left.bgMode === right.bgMode &&
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.underline === right.underline &&
    left.dim === right.dim &&
    left.inverse === right.inverse &&
    left.strikethrough === right.strikethrough
  );
}

function styleToAnsi(style: TerminalStyle): string {
  const codes = ["0"];

  if (style.bold) {
    codes.push("1");
  }
  if (style.dim) {
    codes.push("2");
  }
  if (style.italic) {
    codes.push("3");
  }
  if (style.underline) {
    codes.push("4");
  }
  if (style.inverse) {
    codes.push("7");
  }
  if (style.strikethrough) {
    codes.push("9");
  }

  if (style.fg !== undefined && style.fgMode !== undefined) {
    codes.push(...colorToSgr(style.fgMode, style.fg, false));
  }

  if (style.bg !== undefined && style.bgMode !== undefined) {
    codes.push(...colorToSgr(style.bgMode, style.bg, true));
  }

  return `\x1b[${codes.join(";")}m`;
}

function colorToSgr(mode: number, value: number, background: boolean): string[] {
  if (mode === 1) {
    if (value >= 8) {
      return [String((background ? 100 : 90) + (value - 8))];
    }
    return [String((background ? 40 : 30) + value)];
  }

  if (mode === 2) {
    return [background ? "48" : "38", "5", String(value)];
  }

  if (mode === 3) {
    return [
      background ? "48" : "38",
      "2",
      String((value >> 16) & 0xff),
      String((value >> 8) & 0xff),
      String(value & 0xff),
    ];
  }

  return [];
}
