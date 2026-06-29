import { describe, expect, it } from "vitest";

import {
  isBlankTerminalState,
  type TerminalCell,
  type TerminalState,
} from "./terminal-snapshot.js";

const cell = (char: string): TerminalCell => ({ char });
const row = (text: string): TerminalCell[] => [...text].map(cell);
const blankRow = (n: number): TerminalCell[] => Array.from({ length: n }, () => cell(" "));

function state(over: Partial<TerminalState> = {}): TerminalState {
  return {
    rows: 2,
    cols: 4,
    grid: [blankRow(4), blankRow(4)],
    scrollback: [],
    cursor: { row: 0, col: 0 },
    ...over,
  };
}

describe("isBlankTerminalState", () => {
  it("is true for empty scrollback + all-blank grid (the PtyHost rehydrated empty snapshot)", () => {
    expect(isBlankTerminalState(state())).toBe(true);
    // empty-char cells (not even spaces) are also blank
    expect(isBlankTerminalState(state({ grid: [[cell(""), cell("")]] }))).toBe(true);
  });

  it("is false when the grid has any visible character", () => {
    expect(isBlankTerminalState(state({ grid: [row("hi"), blankRow(4)] }))).toBe(false);
  });

  it("is false when scrollback has content even if the grid is blank", () => {
    expect(isBlankTerminalState(state({ scrollback: [row("old line")] }))).toBe(false);
  });
});
