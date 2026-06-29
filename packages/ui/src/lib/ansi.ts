// Pure ANSI SGR parser for shell/command tool output (issue #615).
//
// Agent shell tools emit raw output that frequently contains ANSI escape
// sequences (`ls --color`, `git`, test runners, build tools). Rendered in a
// raw `<pre>` those show up as literal garbage (`\x1b[32m…`). This module turns
// the byte stream into a flat list of styled text segments that a component can
// render as `<span>`s — colorized, theme-aware, and with the escape noise gone.
//
// Scope: this is intentionally NOT a terminal emulator. It handles SGR (Select
// Graphic Rendition, `ESC[…m`) styling — the only part that carries meaning in
// non-interactive command output — and *strips* every other escape sequence
// (cursor moves, erase, OSC, etc.) so they don't leak as literal characters.
// Full xterm parity (a grid, cursor addressing, scrollback) is overkill for a
// chat bubble; see issue #615 rationale.

/** One of the 16 standard ANSI colors, mapped to a theme CSS variable by the
 *  renderer. Keeping these symbolic (not hex) is what makes output theme-aware:
 *  `--ansi-red` resolves differently in light vs dark. */
export type AnsiNamedColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

/** A resolved color: either one of the 16 named (theme-token) colors, or a
 *  literal CSS color string for 256-color / truecolor (`38;5;n`, `38;2;r;g;b`)
 *  which have no theme token. `null`/absent means "use the default". */
export type AnsiColor = { kind: "named"; name: AnsiNamedColor } | { kind: "rgb"; value: string };

export interface AnsiStyle {
  fg?: AnsiColor;
  bg?: AnsiColor;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** SGR 7 — swap fg/bg. Resolved at render time, kept as a flag here. */
  inverse?: boolean;
  strike?: boolean;
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

const NAMED: readonly AnsiNamedColor[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
];

const BRIGHT_NAMED: readonly AnsiNamedColor[] = [
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

const ESC = "\x1b";

/** Standard xterm 256-color cube → rgb, used only for `38;5;n` / `48;5;n`.
 *  0-15 reuse the named palette (handled by the caller); 16-231 are a 6×6×6
 *  cube; 232-255 are a 24-step grayscale ramp. */
function xterm256ToRgb(n: number): string {
  if (n < 16) {
    // The first 16 map onto the named palette; approximate with standard
    // xterm defaults so a literal value still renders sensibly if used.
    const base = [
      "#000000",
      "#cd0000",
      "#00cd00",
      "#cdcd00",
      "#0000ee",
      "#cd00cd",
      "#00cdcd",
      "#e5e5e5",
      "#7f7f7f",
      "#ff0000",
      "#00ff00",
      "#ffff00",
      "#5c5cff",
      "#ff00ff",
      "#00ffff",
      "#ffffff",
    ];
    return base[n] ?? "#000000";
  }
  if (n >= 232) {
    const level = 8 + (n - 232) * 10;
    return rgbHex(level, level, level);
  }
  const c = n - 16;
  const r = Math.floor(c / 36);
  const g = Math.floor((c % 36) / 6);
  const b = c % 6;
  const step = (v: number) => (v === 0 ? 0 : 55 + v * 40);
  return rgbHex(step(r), step(g), step(b));
}

function rgbHex(r: number, g: number, b: number): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, v | 0))
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Simple (non-color, single-code) SGR attributes → a style mutation. Lookup
 *  table so `applySgr` stays flat; color/range codes are handled separately. */
const ATTR_HANDLERS: Record<number, (s: AnsiStyle) => void> = {
  1: (s) => {
    s.bold = true;
  },
  2: (s) => {
    s.dim = true;
  },
  3: (s) => {
    s.italic = true;
  },
  4: (s) => {
    s.underline = true;
  },
  7: (s) => {
    s.inverse = true;
  },
  9: (s) => {
    s.strike = true;
  },
  22: (s) => {
    s.bold = false;
    s.dim = false;
  },
  23: (s) => {
    s.italic = false;
  },
  24: (s) => {
    s.underline = false;
  },
  27: (s) => {
    s.inverse = false;
  },
  29: (s) => {
    s.strike = false;
  },
  39: (s) => {
    delete s.fg;
  },
  49: (s) => {
    delete s.bg;
  },
};

function resetStyle(style: AnsiStyle): void {
  for (const k of Object.keys(style) as (keyof AnsiStyle)[]) delete style[k];
}

/** Apply a basic (named) color code in the 30-37/40-47/90-97/100-107 ranges.
 *  Returns true if `code` was a color code it handled. */
function applyNamedColor(style: AnsiStyle, code: number): boolean {
  if (code >= 30 && code <= 37) {
    style.fg = { kind: "named", name: NAMED[code - 30] };
  } else if (code >= 40 && code <= 47) {
    style.bg = { kind: "named", name: NAMED[code - 40] };
  } else if (code >= 90 && code <= 97) {
    style.fg = { kind: "named", name: BRIGHT_NAMED[code - 90] };
  } else if (code >= 100 && code <= 107) {
    style.bg = { kind: "named", name: BRIGHT_NAMED[code - 100] };
  } else {
    return false;
  }
  return true;
}

/** Parse a single `ESC[…m` parameter list (already split on `;`) and mutate the
 *  running style. Unknown codes are ignored (forward-compat). `38`/`48` consume
 *  following params (`5;n` or `2;r;g;b`), so the loop can advance the index. */
function applySgr(style: AnsiStyle, params: number[]): void {
  // An empty `ESC[m` is treated as a reset (matches terminals).
  if (params.length === 0) params = [0];

  for (let i = 0; i < params.length; i++) {
    const code = params[i];

    // 38/48 = extended fg/bg color selector; may swallow trailing params.
    if (code === 38 || code === 48) {
      const ext = readExtendedColor(params, i);
      if (ext.color) {
        if (code === 38) style.fg = ext.color;
        else style.bg = ext.color;
      }
      // Always advance past the params the selector consumed (or attempted to,
      // when malformed) so leftover `5`/`2`/`r`/`g`/`b` values are never
      // re-read as fresh SGR codes (which would paint garbage colors).
      i = ext.next;
      continue;
    }

    if (code === 0) {
      resetStyle(style);
      continue;
    }

    const attr = ATTR_HANDLERS[code];
    if (attr) {
      attr(style);
      continue;
    }

    // Named-color ranges; anything else is an unknown/unsupported code and is
    // silently ignored so malformed or exotic sequences never corrupt the run.
    applyNamedColor(style, code);
  }
}

/** Resolve `38;5;n` (256-color) or `38;2;r;g;b` (truecolor) starting at the
 *  index of the `38`/`48` selector. Always returns the index of the last param
 *  this selector consumed (`next`) so the caller can skip the whole sequence;
 *  `color` is `null` when the sequence is malformed (missing/NaN index or rgb
 *  components, or an unknown mode) — the bad params are still consumed, not
 *  left behind to be re-parsed as fresh SGR codes. `next` is clamped to the end
 *  of the param list so a truncated tail doesn't over-advance. */
function readExtendedColor(
  params: number[],
  selectorIndex: number,
): { color: AnsiColor | null; next: number } {
  const clamp = (idx: number) => Math.min(idx, params.length - 1);
  const mode = params[selectorIndex + 1];
  if (mode === 5) {
    const next = clamp(selectorIndex + 2);
    const n = params[selectorIndex + 2];
    if (n == null || Number.isNaN(n)) return { color: null, next };
    if (n >= 0 && n < 16) {
      const name = n < 8 ? NAMED[n] : BRIGHT_NAMED[n - 8];
      return { color: { kind: "named", name }, next };
    }
    return { color: { kind: "rgb", value: xterm256ToRgb(n) }, next };
  }
  if (mode === 2) {
    const next = clamp(selectorIndex + 4);
    const r = params[selectorIndex + 2];
    const g = params[selectorIndex + 3];
    const b = params[selectorIndex + 4];
    if ([r, g, b].some((v) => v == null || Number.isNaN(v))) return { color: null, next };
    return { color: { kind: "rgb", value: rgbHex(r, g, b) }, next };
  }
  // Unknown mode (not 5 or 2): drop just the mode param so it isn't re-read.
  return { color: null, next: clamp(selectorIndex + 1) };
}

function cloneStyle(s: AnsiStyle): AnsiStyle {
  // Flat object of primitives + small color records; a shallow copy is enough
  // because we replace (never mutate) color records.
  return { ...s };
}

function isEmptyStyle(s: AnsiStyle): boolean {
  for (const k in s) {
    const v = s[k as keyof AnsiStyle];
    if (v !== undefined && v !== false) return false;
  }
  return true;
}

/**
 * Parse a string that may contain ANSI escape sequences into styled segments.
 *
 * Guarantees (the unit-test contract):
 *  - Plain text with no escapes → a single segment, text byte-for-byte intact.
 *  - SGR color/attribute codes become per-segment `style`; the escapes vanish.
 *  - Non-SGR escapes (cursor/erase/OSC/etc.) are stripped, never emitted as
 *    literal characters.
 *  - A lone/truncated `ESC` or malformed sequence never throws and never
 *    corrupts the surrounding text.
 *  - Adjacent runs that share the identical style are coalesced.
 */
export function parseAnsi(input: string): AnsiSegment[] {
  if (!input) return [];
  // Fast path: no escape byte at all → one plain segment. This is the common
  // case for tool output that wasn't colorized, and avoids all the scanning.
  if (!input.includes(ESC)) return [{ text: input, style: {} }];

  const segments: AnsiSegment[] = [];
  const style: AnsiStyle = {};
  let buf = "";

  const flush = () => {
    if (buf.length === 0) return;
    const last = segments[segments.length - 1];
    const snapshot = cloneStyle(style);
    // Coalesce with the previous segment when the style is identical.
    if (last && sameStyle(last.style, snapshot)) {
      last.text += buf;
    } else {
      segments.push({ text: buf, style: snapshot });
    }
    buf = "";
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch !== ESC) {
      buf += ch;
      continue;
    }

    const next = input[i + 1];

    // CSI: ESC [ … <final-byte 0x40-0x7E>
    if (next === "[") {
      let j = i + 2;
      // Parameter + intermediate bytes are 0x20-0x3F; final byte is 0x40-0x7E.
      while (j < input.length) {
        const code = input.charCodeAt(j);
        if (code >= 0x40 && code <= 0x7e) break;
        j++;
      }
      const finalByte = input[j];
      if (finalByte === "m") {
        flush();
        const paramStr = input.slice(i + 2, j);
        const params =
          paramStr === "" ? [] : paramStr.split(";").map((p) => Number.parseInt(p, 10));
        applySgr(style, params);
      }
      // Any other CSI (cursor, erase, etc.) is consumed and dropped.
      // If we never found a final byte (truncated), drop the rest entirely.
      i = j < input.length ? j : input.length;
      continue;
    }

    // OSC: ESC ] … terminated by BEL (0x07) or ST (ESC \). Drop it wholesale.
    if (next === "]") {
      let j = i + 2;
      while (j < input.length) {
        if (input.charCodeAt(j) === 0x07) {
          j++;
          break;
        }
        if (input[j] === ESC && input[j + 1] === "\\") {
          j += 2;
          break;
        }
        j++;
      }
      i = j - 1;
      continue;
    }

    // Other two-byte escapes (ESC c, ESC =, charset selection, etc.): skip the
    // ESC and its single following byte. A lone trailing ESC is just dropped.
    if (next != null) {
      i += 1;
    }
  }

  flush();
  return segments;
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  if (isEmptyStyle(a) && isEmptyStyle(b)) return true;
  return (
    sameColor(a.fg, b.fg) &&
    sameColor(a.bg, b.bg) &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.inverse === !!b.inverse &&
    !!a.strike === !!b.strike
  );
}

function sameColor(a?: AnsiColor, b?: AnsiColor): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (a.kind !== b.kind) return false;
  return a.kind === "named" && b.kind === "named"
    ? a.name === b.name
    : (a as { value: string }).value === (b as { value: string }).value;
}

/** True if the input contains any ANSI escape byte. Cheap guard for callers
 *  that want to skip the styled path entirely. */
export function hasAnsi(input: string): boolean {
  return input.includes(ESC);
}

/** Strip every ANSI escape sequence and return plain text. Handy for copy /
 *  search / accessibility where styling isn't wanted. */
export function stripAnsi(input: string): string {
  if (!input.includes(ESC)) return input;
  return parseAnsi(input)
    .map((s) => s.text)
    .join("");
}
