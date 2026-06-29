import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// #519: the typing-indicator dots use a dedicated subtle keyframe (opacity + a
// small lift), staggered per dot, and gated by prefers-reduced-motion — NOT
// Tailwind's large `animate-bounce` hop. Animation is pure CSS (no DOM harness
// in this plain-node vitest), so this is a contract guard over app.css + the
// component markup.

// This test lives in src/lib; app.css is one level up in src/, components are
// under src/lib/components.
const lib = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(lib, rel), "utf8");

describe("typing-dot animation (app.css contract)", () => {
  const css = read("../app.css");

  it("defines a dedicated subtle keyframe (opacity dip + small translateY)", () => {
    const kf = css.slice(css.indexOf("@keyframes typing-dot"));
    expect(kf).toMatch(/@keyframes typing-dot\s*\{/);
    expect(kf).toMatch(/opacity:\s*0\.3/); // resting/dim
    expect(kf).toMatch(/opacity:\s*1/); // peak
    expect(kf).toMatch(/translateY\(-2px\)/); // small lift, not a big hop
  });

  it("exposes .animate-typing-dot looping, with a per-dot --dot-delay stagger", () => {
    const rule = css.slice(css.indexOf(".animate-typing-dot {"));
    expect(rule).toMatch(/animation:\s*typing-dot[^;]*infinite/);
    expect(rule).toMatch(/animation-delay:\s*var\(--dot-delay/);
  });

  it("disables the dot animation INSIDE a prefers-reduced-motion block", () => {
    // Parse each reduced-motion @media block (brace-matched) and require one to
    // actually turn .animate-typing-dot off — a file-wide regex would pass even
    // if the rule sat outside the media query.
    const blocks = css.split("@media (prefers-reduced-motion: reduce)");
    const hasDisabledDot = blocks.slice(1).some((block) => {
      let braceCount = 0;
      let endIdx = 0;
      for (let i = 0; i < block.length; i++) {
        if (block[i] === "{") braceCount++;
        else if (block[i] === "}") {
          braceCount--;
          if (braceCount === 0) {
            endIdx = i;
            break;
          }
        }
      }
      const blockContent = block.slice(0, endIdx);
      // Regex .test (not two .includes on one string) to sidestep oxlint's
      // prefer-set-has false positive, while still requiring BOTH in the block.
      return /\.animate-typing-dot/.test(blockContent) && /animation:\s*none/.test(blockContent);
    });
    expect(hasDisabledDot).toBe(true);
  });
});

describe("TypingIndicator uses the staggered dedicated animation", () => {
  const src = read("components/message/TypingIndicator.svelte");

  it("no longer uses Tailwind animate-bounce", () => {
    expect(src).not.toContain("animate-bounce");
  });

  it("renders three dots with animate-typing-dot and staggered --dot-delay", () => {
    expect(src.match(/animate-typing-dot/g)?.length).toBe(3);
    expect(src).toContain("--dot-delay: 0ms");
    expect(src).toContain("--dot-delay: 200ms");
    expect(src).toContain("--dot-delay: 400ms");
  });
});
