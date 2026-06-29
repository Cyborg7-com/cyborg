import { describe, it, expect } from "vitest";
import { sanitizeToolArgs, stripNonPrintable } from "./server.js";

// Build invisible/control characters from explicit code points so the source
// stays reviewable plain text (no literal control/invisible bytes in the file).
const cp = (n: number): string => String.fromCodePoint(n);
const NUL = cp(0x00);
const BEL = cp(0x07);
const BS = cp(0x08);
const ESC = cp(0x1b);
const US = cp(0x1f);
const DEL = cp(0x7f);
const C1 = cp(0x85); // NEL, a C1 control
const ZWSP = cp(0x200b);
const ZWNJ = cp(0x200c);
const ZWJ = cp(0x200d);
const BOM = cp(0xfeff);
const LRE = cp(0x202a); // bidi override range start
const RLO = cp(0x202e); // bidi override range end
const LRI = cp(0x2066); // bidi isolate range start
const PDI = cp(0x2069); // bidi isolate range end

describe("stripNonPrintable", () => {
  it("passes clean ASCII through unchanged (same reference, no-op)", () => {
    const s = "hello world #general 123 (a-b_c)";
    const out = stripNonPrintable(s);
    expect(out).toBe(s);
  });

  it("preserves tab, newline, and carriage-return whitespace", () => {
    const s = "line1\nline2\tcol\r\nline3";
    expect(stripNonPrintable(s)).toBe(s);
  });

  it("strips C0 control characters except \\t \\n \\r", () => {
    const s = `a${NUL}b${BEL}c${BS}d${ESC}e${US}f`;
    expect(stripNonPrintable(s)).toBe("abcdef");
  });

  it("strips DEL (U+007F) and C1 controls (U+0080-U+009F)", () => {
    const s = `x${DEL}y${C1}z`;
    expect(stripNonPrintable(s)).toBe("xyz");
  });

  it("preserves zero-width joiners (ZWSP, ZWNJ, ZWJ) but strips BOM", () => {
    const s = `a${ZWSP}b${ZWNJ}c${ZWJ}d${BOM}e`;
    expect(stripNonPrintable(s)).toBe(`a${ZWSP}b${ZWNJ}c${ZWJ}de`);
  });

  it("strips bidi overrides and isolates (U+202A-U+202E, U+2066-U+2069)", () => {
    const s = `a${LRE}b${RLO}c${LRI}d${PDI}e`;
    expect(stripNonPrintable(s)).toBe("abcde");
  });

  it("preserves accents, CJK, and emoji (incl. astral / surrogate pairs)", () => {
    const s = "café — 日本語 — 👍🏽 — 𝓗ello — 🎉";
    expect(stripNonPrintable(s)).toBe(s);
  });

  it("strips controls while keeping surrounding emoji and ZWSP intact", () => {
    const s = `👍${ZWSP}🎉${NUL}日本`;
    expect(stripNonPrintable(s)).toBe(`👍${ZWSP}🎉日本`);
  });

  it("returns only preserved characters when mixed with strippable ones", () => {
    expect(stripNonPrintable(`${NUL}${ZWSP}${RLO}`)).toBe(ZWSP);
  });
});

describe("sanitizeToolArgs", () => {
  it("is a no-op on clean ASCII object input", () => {
    const args = { channelId: "ch_1", text: "hello", limit: 20, before: undefined };
    expect(sanitizeToolArgs(args)).toEqual(args);
  });

  it("sanitizes every string value, leaving non-strings untouched", () => {
    const out = sanitizeToolArgs({
      channelId: `ch${ZWSP}_1`,
      text: `hi${NUL} there${RLO}`,
      limit: 20,
      flag: true,
      nothing: null,
      missing: undefined,
    });
    expect(out).toEqual({
      channelId: `ch${ZWSP}_1`,
      text: "hi there",
      limit: 20,
      flag: true,
      nothing: null,
      missing: undefined,
    });
  });

  it("recurses into nested objects and arrays", () => {
    const out = sanitizeToolArgs({
      text: "ab",
      nested: { deep: `x${BOM}y`, n: 1 },
      list: [`p${ZWJ}q`, 5, "ok", { inner: `z${LRE}z` }],
    });
    expect(out).toEqual({
      text: "ab",
      nested: { deep: "xy", n: 1 },
      list: [`p${ZWJ}q`, 5, "ok", { inner: "zz" }],
    });
  });

  it("preserves tab/newline/CR and printable Unicode through the recursion", () => {
    const args = { text: "line1\nline2\tx", name: "café 👍 日本語" };
    expect(sanitizeToolArgs(args)).toEqual(args);
  });

  it("sanitizes a bare string argument", () => {
    expect(sanitizeToolArgs("clean")).toBe("clean");
    expect(sanitizeToolArgs(`dir${NUL}ty`)).toBe("dirty");
  });

  it("leaves primitive non-string arguments untouched", () => {
    expect(sanitizeToolArgs(42)).toBe(42);
    expect(sanitizeToolArgs(true)).toBe(true);
    expect(sanitizeToolArgs(null)).toBeNull();
    expect(sanitizeToolArgs(undefined)).toBeUndefined();
  });
});
