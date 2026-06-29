import { describe, it, expect } from "vitest";
import { parseAnsi, stripAnsi, hasAnsi, type AnsiSegment } from "./ansi.js";

// #615 — shell/command tool output frequently carries ANSI SGR escapes. The
// renderer must turn those into styled segments (not literal `\x1b[..m` noise),
// leave plain text byte-for-byte intact, and never throw on malformed input.

const E = "\x1b";

/** Concatenate segment text to assert the visible string is preserved. */
const visible = (segs: AnsiSegment[]) => segs.map((s) => s.text).join("");

describe("parseAnsi — plain text", () => {
  it("returns a single intact segment when there are no escapes", () => {
    const segs = parseAnsi("hello world\nsecond line");
    expect(segs).toEqual([{ text: "hello world\nsecond line", style: {} }]);
  });

  it("returns [] for empty string", () => {
    expect(parseAnsi("")).toEqual([]);
  });

  it("preserves whitespace and tabs exactly", () => {
    const segs = parseAnsi("  indented\ttabbed   \n");
    expect(visible(segs)).toBe("  indented\ttabbed   \n");
  });
});

describe("parseAnsi — basic SGR colors", () => {
  it("parses a foreground color and resets", () => {
    const segs = parseAnsi(`${E}[32mgreen${E}[0m plain`);
    expect(segs).toEqual([
      { text: "green", style: { fg: { kind: "named", name: "green" } } },
      { text: " plain", style: {} },
    ]);
  });

  it("the escape codes themselves never appear in the text", () => {
    const segs = parseAnsi(`${E}[31mred${E}[0m`);
    expect(visible(segs)).toBe("red");
    expect(visible(segs)).not.toContain(E);
    expect(visible(segs)).not.toContain("[31m");
  });

  it("maps all 8 standard foreground colors (30-37)", () => {
    const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
    names.forEach((name, idx) => {
      const segs = parseAnsi(`${E}[3${idx}mx`);
      expect(segs[0].style.fg).toEqual({ kind: "named", name });
    });
  });

  it("maps bright foreground colors (90-97)", () => {
    const segs = parseAnsi(`${E}[91mbright-red`);
    expect(segs[0].style.fg).toEqual({ kind: "named", name: "brightRed" });
  });

  it("maps background colors (40-47) and bright bg (100-107)", () => {
    expect(parseAnsi(`${E}[42mx`)[0].style.bg).toEqual({ kind: "named", name: "green" });
    expect(parseAnsi(`${E}[102mx`)[0].style.bg).toEqual({ kind: "named", name: "brightGreen" });
  });

  it("treats an empty `ESC[m` as a reset", () => {
    const segs = parseAnsi(`${E}[31mred${E}[mplain`);
    expect(segs[0].style.fg).toEqual({ kind: "named", name: "red" });
    expect(segs[1].style).toEqual({});
  });
});

describe("parseAnsi — text attributes", () => {
  it("parses bold / dim / italic / underline / strike", () => {
    expect(parseAnsi(`${E}[1mx`)[0].style.bold).toBe(true);
    expect(parseAnsi(`${E}[2mx`)[0].style.dim).toBe(true);
    expect(parseAnsi(`${E}[3mx`)[0].style.italic).toBe(true);
    expect(parseAnsi(`${E}[4mx`)[0].style.underline).toBe(true);
    expect(parseAnsi(`${E}[9mx`)[0].style.strike).toBe(true);
    expect(parseAnsi(`${E}[7mx`)[0].style.inverse).toBe(true);
  });

  it("combines multiple attributes in one sequence", () => {
    const segs = parseAnsi(`${E}[1;4;31mbold-underline-red`);
    expect(segs[0].style).toMatchObject({
      bold: true,
      underline: true,
      fg: { kind: "named", name: "red" },
    });
  });

  it("turns bold off with 22 and underline off with 24", () => {
    const segs = parseAnsi(`${E}[1;4mboth${E}[22mno-bold${E}[24mneither`);
    expect(segs[0].style).toMatchObject({ bold: true, underline: true });
    expect(segs[1].style).toMatchObject({ bold: false, underline: true });
    expect(segs[2].style.underline).toBe(false);
  });

  it("resets fg with 39 / bg with 49 without clearing attributes", () => {
    const segs = parseAnsi(`${E}[1;31;42mx${E}[39my${E}[49mz`);
    expect(segs[0].style).toMatchObject({
      bold: true,
      fg: { kind: "named", name: "red" },
      bg: { kind: "named", name: "green" },
    });
    expect(segs[1].style.fg).toBeUndefined();
    expect(segs[1].style.bold).toBe(true); // attribute survives
    expect(segs[2].style.bg).toBeUndefined();
  });
});

describe("parseAnsi — 256-color and truecolor", () => {
  it("parses 256-color foreground (38;5;n) into an rgb value", () => {
    const segs = parseAnsi(`${E}[38;5;208morange`);
    expect(segs[0].style.fg?.kind).toBe("rgb");
  });

  it("maps the low 16 of the 256 palette back to named colors", () => {
    const segs = parseAnsi(`${E}[38;5;1mx`);
    expect(segs[0].style.fg).toEqual({ kind: "named", name: "red" });
    const bright = parseAnsi(`${E}[38;5;9mx`);
    expect(bright[0].style.fg).toEqual({ kind: "named", name: "brightRed" });
  });

  it("parses truecolor (38;2;r;g;b)", () => {
    const segs = parseAnsi(`${E}[38;2;255;128;0mx`);
    expect(segs[0].style.fg).toEqual({ kind: "rgb", value: "#ff8000" });
  });

  it("parses truecolor background (48;2;r;g;b)", () => {
    const segs = parseAnsi(`${E}[48;2;0;0;0mx`);
    expect(segs[0].style.bg).toEqual({ kind: "rgb", value: "#000000" });
  });

  it("a malformed truecolor selector (38;2 missing g/b) consumes its leftover params", () => {
    // `ESC[38;2;100m` — truecolor mode but only `r` given. The selector must
    // swallow `2` and `100` so they aren't re-read as fresh SGR codes; if `100`
    // leaked it would paint a bright-black background. Output stays default.
    const segs = parseAnsi(`${E}[38;2;100mTEXT`);
    expect(visible(segs)).toBe("TEXT");
    expect(visible(segs)).not.toContain("100");
    expect(visible(segs)).not.toContain("2");
    expect(segs).toEqual([{ text: "TEXT", style: {} }]);
    expect(segs[0].style.fg).toBeUndefined();
    expect(segs[0].style.bg).toBeUndefined();
  });

  it("a malformed 256-color selector (38;5 missing index) consumes its leftover param", () => {
    // `ESC[38;5mTEXT` — 256-color mode with no index. `5` must be consumed, not
    // re-parsed (5 happens to be a no-op SGR, but the principle holds).
    const segs = parseAnsi(`${E}[38;5mTEXT`);
    expect(visible(segs)).toBe("TEXT");
    expect(visible(segs)).not.toContain("5");
    expect(segs).toEqual([{ text: "TEXT", style: {} }]);
    expect(segs[0].style.fg).toBeUndefined();
  });

  it("a malformed extended selector does not corrupt a following valid code", () => {
    // `ESC[38;2;100;31mX` — `38;2` is missing `b`, but `r=100` and `g=31` ARE
    // consumed by the (failed) truecolor read; the trailing `31` here is g, NOT
    // a fg-red code. fg must stay default and no digits leak into the text.
    const segs = parseAnsi(`${E}[38;2;100;31mX`);
    expect(visible(segs)).toBe("X");
    expect(segs[0].style.fg).toBeUndefined();
  });

  it("does not over-advance: a well-formed extended color before another code", () => {
    // `ESC[38;5;9;4mX` — 256-color brightRed followed by underline. The selector
    // must consume exactly `5;9` and leave `4` to apply as underline.
    const segs = parseAnsi(`${E}[38;5;9;4mX`);
    expect(segs[0].style.fg).toEqual({ kind: "named", name: "brightRed" });
    expect(segs[0].style.underline).toBe(true);
  });
});

describe("parseAnsi — malformed / hostile input never throws or corrupts", () => {
  it("a lone trailing ESC is dropped, surrounding text intact", () => {
    expect(visible(parseAnsi(`abc${E}`))).toBe("abc");
  });

  it("a truncated CSI (no final byte) drops the rest but keeps prior text", () => {
    expect(visible(parseAnsi(`keep${E}[31`))).toBe("keep");
  });

  it("ignores out-of-range / NaN numeric params within a valid SGR run", () => {
    // `ESC[1;;31m` — the empty middle param parses to NaN and is skipped; bold
    // and red both apply, and no escape leaks.
    const out = parseAnsi(`${E}[1;;31mtext`);
    expect(visible(out)).toBe("text");
    expect(out[0].style.bold).toBe(true);
    expect(out[0].style.fg).toEqual({ kind: "named", name: "red" });
  });

  it("a CSI sequence ending in a non-`m` final byte is consumed, never printed", () => {
    // Per the CSI grammar the first byte in 0x40-0x7E terminates the sequence,
    // so `ESC[a` is a complete (cursor) CSI and is dropped. The guarantee that
    // matters: the escape bytes never appear as literal characters.
    const out = parseAnsi(`${E}[abc`);
    expect(visible(out)).toBe("bc");
    expect(visible(out)).not.toContain(E);
  });

  it("unknown SGR codes are ignored", () => {
    const segs = parseAnsi(`${E}[99mx`);
    expect(visible(segs)).toBe("x");
  });

  it("strips non-SGR CSI sequences (cursor move, erase line)", () => {
    // ESC[2J = clear screen, ESC[K = erase line, ESC[1;1H = cursor home.
    const raw = `${E}[2J${E}[1;1Hhome${E}[Kend`;
    expect(visible(parseAnsi(raw))).toBe("homeend");
  });

  it("strips an OSC sequence terminated by BEL", () => {
    const raw = `${E}]0;window title\x07visible`;
    expect(visible(parseAnsi(raw))).toBe("visible");
  });

  it("strips an OSC sequence terminated by ST (ESC \\)", () => {
    const raw = `${E}]8;;https://example.com${E}\\link text${E}]8;;${E}\\`;
    // OSC-8 hyperlinks are dropped wholesale here; the visible label remains.
    expect(visible(parseAnsi(raw))).toBe("link text");
  });

  it("does not throw on a large mixed buffer", () => {
    const raw = `${E}[32m✓${E}[0m PASS ${E}[2m(12ms)${E}[0m\n`.repeat(500);
    expect(() => parseAnsi(raw)).not.toThrow();
    expect(visible(parseAnsi(raw))).toContain("PASS");
  });
});

describe("parseAnsi — coalescing", () => {
  it("merges adjacent runs that share the identical style", () => {
    // Two color sets to the same color split by a no-op reset-to-same.
    const segs = parseAnsi(`${E}[31ma${E}[31mb`);
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe("ab");
  });

  it("does not merge runs with differing styles", () => {
    const segs = parseAnsi(`${E}[31ma${E}[32mb`);
    expect(segs).toHaveLength(2);
  });
});

describe("stripAnsi / hasAnsi helpers", () => {
  it("hasAnsi detects escape presence", () => {
    expect(hasAnsi("plain")).toBe(false);
    expect(hasAnsi(`${E}[31mx`)).toBe(true);
  });

  it("stripAnsi returns plain text with all escapes removed", () => {
    expect(stripAnsi("plain")).toBe("plain");
    expect(stripAnsi(`${E}[1;32mgreen bold${E}[0m`)).toBe("green bold");
  });

  it("stripAnsi round-trips a realistic colorized git/test line", () => {
    const raw = `${E}[32m✓${E}[39m  ${E}[1msrc/app.test.ts${E}[22m ${E}[2m(3 tests)${E}[22m`;
    expect(stripAnsi(raw)).toBe("✓  src/app.test.ts (3 tests)");
  });
});
