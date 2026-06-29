// REAL-PROVIDER gate for the raw-text summarizer prompts.
//
// The slash AI completer now captures the model's RAW output and uses it as the
// summary (no JSON, no schema). This runs the actual summarizer system prompt
// (finalSummarySystem) + a transcript through a REAL model (the natively-authed
// `claude` CLI) with NO JSON wrapper, and asserts the output is clean markdown:
// non-empty, not JSON, and not wrapped in preamble or a ``` code fence. This is
// the CLI-first gate — typecheck/units alone let the original prompt bug through.
//
// glm-5.1/opencode-go isn't installed here and no OpenRouter key is set, so this
// uses the provider that IS available (claude) — same prompt + raw-text contract
// end-to-end. Auto-skips when `claude` is unavailable.
import { spawnSync } from "node:child_process";
import { describe, test, expect } from "vitest";
import { finalSummarySystem } from "./summarization.js";

function claudeAvailable(): boolean {
  return spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;
}

function claudeReply(prompt: string): string {
  const r = spawnSync("claude", ["-p"], {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 90_000,
  });
  if (r.status !== 0) throw new Error(`claude failed: ${r.stderr || r.stdout}`);
  return (r.stdout ?? "").trim();
}

const SAMPLE_TRANSCRIPT = [
  "@alice: morning — can we ship the alias DB migration today?",
  "@bob: yes, p13 is idempotent now. I'll deploy after lunch.",
  "@alice: great. one open question: do we cap alias length?",
  "@bob: not yet — let's add an 80-char cap in a follow-up.",
  "@carol: I'll take the follow-up. also the /summarize timeout is raised to 120s.",
  "@alice: decision: ship today, cap is a follow-up owned by @carol.",
].join("\n");

describe("REAL claude — raw-text summarizer prompt yields clean markdown", () => {
  test.runIf(claudeAvailable())(
    "finalSummarySystem + transcript returns markdown, no JSON / preamble / code fence",
    () => {
      const out = claudeReply(`${finalSummarySystem("general", false)}\n\n${SAMPLE_TRANSCRIPT}`);
      // eslint-disable-next-line no-console
      console.log("\n===== REAL claude raw summary =====\n" + out + "\n===================================\n");
      expect(out.length).toBeGreaterThan(0);
      // Raw text, not a JSON blob.
      expect(out.startsWith("{")).toBe(false);
      expect(out).not.toMatch(/^\s*\{?\s*"summary"\s*:/);
      // Not wrapped in a ``` code fence.
      expect(out.startsWith("```")).toBe(false);
      // Actually markdown (a heading or a bullet).
      expect(out).toMatch(/(^|\n)\s*(#{1,6}\s|[-*]\s)/);
    },
    120_000,
  );
});
