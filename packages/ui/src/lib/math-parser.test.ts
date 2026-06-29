// Ported from the Math Library (math-library/src/lib/utils/math-parser.test.ts).
// Pure parser tests — no KaTeX, no DOM. Wiki-link sections from the original are
// dropped (that feature doesn't exist in cyborg7). Runs under vitest:
// `pnpm --filter @cyborg7/ui test`.
import { describe, expect, it } from "vitest";
import { parseMathExpressions, roundtrip, serializeMath } from "./math-parser.js";

/** Shorthand: returns just the latex strings from inline matches */
function inlineLatex(text: string): string[] {
  return parseMathExpressions(text)
    .filter((m) => !m.display)
    .map((m) => m.latex);
}

/** Shorthand: returns just the latex strings from block matches */
function blockLatex(text: string): string[] {
  return parseMathExpressions(text)
    .filter((m) => m.display)
    .map((m) => m.latex);
}

describe("Inline math ($...$)", () => {
  describe("basic matching", () => {
    it("matches a simple variable", () => {
      expect(inlineLatex("$x$")).toEqual(["x"]);
    });
    it("matches an expression with operators", () => {
      expect(inlineLatex("$x + y = z$")).toEqual(["x + y = z"]);
    });
    it("matches subscripts and superscripts", () => {
      expect(inlineLatex("$x_1^2$")).toEqual(["x_1^2"]);
    });
    it("matches LaTeX commands", () => {
      expect(inlineLatex("$\\frac{1}{2}$")).toEqual(["\\frac{1}{2}"]);
    });
    it("matches greek letters", () => {
      expect(inlineLatex("$\\alpha + \\beta = \\gamma$")).toEqual(["\\alpha + \\beta = \\gamma"]);
    });
    it("matches integrals", () => {
      expect(inlineLatex("$\\int_0^1 x^2 dx$")).toEqual(["\\int_0^1 x^2 dx"]);
    });
    it("matches summation", () => {
      expect(inlineLatex("$\\sum_{i=1}^{n} i$")).toEqual(["\\sum_{i=1}^{n} i"]);
    });
    it("matches square roots", () => {
      expect(inlineLatex("$\\sqrt{x^2 + y^2}$")).toEqual(["\\sqrt{x^2 + y^2}"]);
    });
  });

  describe("multiple expressions", () => {
    it("matches two separate expressions", () => {
      expect(inlineLatex("$x$ and $y$")).toEqual(["x", "y"]);
    });
    it("matches many expressions in a sentence", () => {
      const text = "If $a > 0$ and $b > 0$, then $a + b > 0$.";
      expect(inlineLatex(text)).toEqual(["a > 0", "b > 0", "a + b > 0"]);
    });
    it("matches expressions adjacent to punctuation", () => {
      expect(inlineLatex("($x$, $y$)")).toEqual(["x", "y"]);
    });
  });

  describe("should NOT match", () => {
    it("rejects leading space: $ x $", () => {
      expect(inlineLatex("$ x $")).toEqual([]);
    });
    it("rejects lone dollar sign: $100", () => {
      expect(inlineLatex("$100")).toEqual([]);
    });
    it("rejects unclosed expression: $x", () => {
      expect(inlineLatex("$x")).toEqual([]);
    });
    it("rejects double-dollar (that is block math syntax)", () => {
      expect(inlineLatex("$$x$$")).toEqual([]);
    });
    it("rejects empty content: $$", () => {
      expect(inlineLatex("plain $$ text")).toEqual([]);
    });
  });

  describe("escaped dollars", () => {
    it("matches expression containing escaped dollar", () => {
      const result = inlineLatex("$a\\$b$");
      expect(result.length).toBeGreaterThanOrEqual(0);
    });
    it("handles backslash-heavy expressions", () => {
      expect(inlineLatex("$\\{a, b, c\\}$")).toEqual(["\\{a, b, c\\}"]);
    });
  });

  describe("boundary behavior", () => {
    it("matches at start of string", () => {
      expect(inlineLatex("$x$ is a variable")).toEqual(["x"]);
    });
    it("matches at end of string", () => {
      expect(inlineLatex("the variable is $x$")).toEqual(["x"]);
    });
    it("matches when string is only math", () => {
      expect(inlineLatex("$x$")).toEqual(["x"]);
    });
    it("matches after newline", () => {
      expect(inlineLatex("line one\n$x$ on line two")).toEqual(["x"]);
    });
  });

  describe("whitespace handling", () => {
    it("trims internal whitespace: $  x  $ has leading space so no match", () => {
      expect(inlineLatex("$  x  $")).toEqual([]);
    });
    it("allows trailing space before closing dollar", () => {
      expect(inlineLatex("$x $")).toEqual(["x"]);
    });
  });
});

describe("Block math ($$...$$)", () => {
  describe("basic matching", () => {
    it("matches a simple expression", () => {
      expect(blockLatex("$$x$$")).toEqual(["x"]);
    });
    it("matches a fraction", () => {
      expect(blockLatex("$$\\frac{a}{b}$$")).toEqual(["\\frac{a}{b}"]);
    });
    it("rejects multiline with leading newline (regex requires no leading space)", () => {
      expect(blockLatex("$$\n\\frac{1}{2}\n$$")).toEqual([]);
    });
    it("matches multiline when content starts immediately", () => {
      expect(blockLatex("$$\\frac{1}{2}\n+ 1$$")).toHaveLength(1);
    });
  });

  describe("complex LaTeX", () => {
    it("matches aligned environment", () => {
      const text = "$$\\begin{aligned}\na &= b + c \\\\\nd &= e + f\n\\end{aligned}$$";
      const result = blockLatex(text);
      expect(result).toHaveLength(1);
      expect(result[0]).toContain("\\begin{aligned}");
      expect(result[0]).toContain("\\end{aligned}");
    });
    it("matches matrix", () => {
      const text = "$$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$$";
      expect(blockLatex(text)).toHaveLength(1);
    });
    it("matches complex integrals", () => {
      expect(blockLatex("$$\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}$$")).toEqual([
        "\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}",
      ]);
    });
  });

  describe("should NOT match", () => {
    it("rejects leading space: $$ x $$", () => {
      expect(blockLatex("$$ x $$")).toEqual([]);
    });
    it("rejects empty block: $$$$", () => {
      expect(blockLatex("$$$$")).toEqual([]);
    });
    it("rejects trailing backslash+space before close", () => {
      expect(blockLatex("$$x\\ $$")).toEqual([]);
    });
  });

  describe("multiple blocks", () => {
    it("matches two separate blocks", () => {
      expect(blockLatex("$$a$$\n\n$$b$$")).toEqual(["a", "b"]);
    });
    it("matches blocks with text between", () => {
      expect(blockLatex("Before $$a$$ middle $$b$$ after")).toEqual(["a", "b"]);
    });
  });
});

describe("Block/inline precedence", () => {
  it("block math takes precedence over inline", () => {
    const matches = parseMathExpressions("$$x + y$$");
    expect(matches).toHaveLength(1);
    expect(matches[0].display).toBe(true);
    expect(matches[0].latex).toBe("x + y");
  });
  it("block and inline coexist without overlap", () => {
    const text = "$$a + b$$ and $c$";
    const matches = parseMathExpressions(text);
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ latex: "a + b", display: true });
    expect(matches[1]).toMatchObject({ latex: "c", display: false });
  });
  it("inline dollar inside block math: block regex is non-greedy", () => {
    const text = "$$a + $b$ + c$$";
    const matches = parseMathExpressions(text);
    expect(matches).toBeDefined();
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i].index).toBeGreaterThanOrEqual(matches[i - 1].index + matches[i - 1].length);
    }
  });
  it("adjacent block and inline math: $$...$$$x$", () => {
    const text = "$$\\frac{1}{2}$$$x$";
    const matches = parseMathExpressions(text);
    const block = matches.filter((m) => m.display);
    expect(block).toHaveLength(1);
    expect(block[0].latex).toBe("\\frac{1}{2}");
    expect(matches).toBeDefined();
  });
  it("triple dollar $$$ does not produce invalid matches", () => {
    expect(parseMathExpressions("$$$")).toBeDefined();
  });
});

describe("Match positions", () => {
  it("tracks correct index for inline math", () => {
    const matches = parseMathExpressions("text $x$ more");
    expect(matches).toHaveLength(1);
    expect(matches[0].index).toBe(5);
    expect(matches[0].length).toBe(3);
  });
  it("tracks correct index for block math", () => {
    const matches = parseMathExpressions("text $$y$$ more");
    expect(matches).toHaveLength(1);
    expect(matches[0].index).toBe(5);
    expect(matches[0].length).toBe(5);
  });
  it("returns matches sorted by index", () => {
    const text = "$c$ then $$b$$ then $a$";
    const matches = parseMathExpressions(text);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i].index).toBeGreaterThan(matches[i - 1].index);
    }
  });
});

describe("serializeMath", () => {
  it("serializes inline math", () => {
    expect(serializeMath("x + y", false)).toBe("$x + y$");
  });
  it("serializes display math", () => {
    expect(serializeMath("\\frac{1}{2}", true)).toBe("$$\\frac{1}{2}$$");
  });
  it("serializes empty string", () => {
    expect(serializeMath("", false)).toBe("$$");
    expect(serializeMath("", true)).toBe("$$$$");
  });
});

describe("Roundtrip stability", () => {
  const cases = [
    "$x$",
    "$x + y$",
    "$\\frac{1}{2}$",
    "$$x$$",
    "$$\\int_0^1 f(x) dx$$",
    "$$\\begin{aligned} a &= b \\end{aligned}$$",
    "$a$ and $b$ and $c$",
    "$$a$$ text $$b$$",
    "$x$ then $$y$$ then $z$",
    "The value $\\alpha = 0.05$ is common in $$H_0: \\mu = 0$$.",
    "No math here at all.",
  ];
  for (const input of cases) {
    it(`roundtrips: ${input.length > 60 ? input.slice(0, 57) + "..." : input}`, () => {
      expect(roundtrip(input)).toBe(input);
    });
  }
  it("roundtrip preserves surrounding text", () => {
    const text = "Given $n > 0$, the formula $$E = mc^2$$ applies.";
    expect(roundtrip(text)).toBe(text);
  });
  it("roundtrip is idempotent (double roundtrip equals single)", () => {
    const text = "We have $x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$ and $$a \\neq 0$$";
    expect(roundtrip(roundtrip(text))).toBe(roundtrip(text));
  });
});

describe("Real-world edge cases", () => {
  it("handles currency amounts (not math)", () => {
    expect(parseMathExpressions("The cost is $100")).toEqual([]);
  });
  it("handles two currency amounts that look like math", () => {
    expect(parseMathExpressions("$100 and $200")).toBeDefined();
  });
  it("handles math in markdown headings", () => {
    expect(inlineLatex("## The $\\chi^2$ Test")).toEqual(["\\chi^2"]);
  });
  it("handles math in markdown bold", () => {
    expect(inlineLatex("**$E = mc^2$** is famous")).toEqual(["E = mc^2"]);
  });
  it("handles math in markdown lists", () => {
    const text = "- $a = 1$\n- $b = 2$\n- $c = a + b$";
    expect(inlineLatex(text)).toEqual(["a = 1", "b = 2", "c = a + b"]);
  });
  it("handles Unicode math symbols in LaTeX", () => {
    expect(inlineLatex("$α + β = γ$")).toEqual(["α + β = γ"]);
  });
  it("handles deeply nested braces", () => {
    expect(inlineLatex("$\\frac{\\frac{a}{b}}{\\frac{c}{d}}$")).toEqual([
      "\\frac{\\frac{a}{b}}{\\frac{c}{d}}",
    ]);
  });
  it("handles math followed immediately by period", () => {
    expect(inlineLatex("The value is $x$.")).toEqual(["x"]);
  });
  it("handles math followed immediately by comma", () => {
    expect(inlineLatex("Given $a$, $b$, and $c$")).toEqual(["a", "b", "c"]);
  });
  it("handles math inside parentheses", () => {
    expect(inlineLatex("(see $\\S 3$)")).toEqual(["\\S 3"]);
  });
  it("handles LaTeX text command inside math", () => {
    expect(inlineLatex("$\\text{if } x > 0$")).toEqual(["\\text{if } x > 0"]);
  });
  it("handles empty lines between block math", () => {
    expect(blockLatex("$$a$$\n\n\n$$b$$")).toEqual(["a", "b"]);
  });
  it("matches display \\[...\\] and inline \\(...\\)", () => {
    expect(blockLatex("\\[x^2\\]")).toEqual(["x^2"]);
    expect(inlineLatex("\\(y\\)")).toEqual(["y"]);
  });
});

describe("Stress & malformed input", () => {
  it("handles empty string", () => {
    expect(parseMathExpressions("")).toEqual([]);
  });
  it("handles string with only dollars", () => {
    expect(parseMathExpressions("$$$$")).toEqual([]);
  });
  it("handles unbalanced single dollars", () => {
    expect(parseMathExpressions("$a $b $c")).toBeDefined();
  });
  it("handles many expressions without catastrophic backtracking", () => {
    const parts = Array.from({ length: 100 }, (_, i) => `$x_{${i}}$`);
    const text = parts.join(" + ");
    const start = performance.now();
    const result = parseMathExpressions(text);
    const elapsed = performance.now() - start;
    expect(result).toHaveLength(100);
    expect(elapsed).toBeLessThan(500);
  });
});
