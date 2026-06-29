import { describe, it, expect } from "vitest";

import { GLM_REPLAY_FIXTURES } from "./summarize-glm-output.fixture.js";
import { replaySummaryThroughParser } from "./summarize-replay.js";

// Deterministic, creds-free gate for /summarize: replay recorded raw model output
// through the REAL parser/repair + schema path and assert it yields a valid summary.
// The bug family here ("Agent is already processing" / empty or invalid summaries)
// ultimately surfaces as "did the model's raw output parse into SUMMARY_SCHEMA?".
// This file replays glm-5.1-shaped output; swap in Rodrigo's real capture via
// summarize-glm-output.fixture.ts (see its TODO) and the same assertions apply.
describe("/summarize glm-5.1 deterministic replay (parser/repair gate)", () => {
  // A non-empty fixture set is itself part of the gate — a broken import that
  // emptied the array would otherwise make the suite vacuously "pass".
  it("has at least one replay fixture", () => {
    expect(GLM_REPLAY_FIXTURES.length).toBeGreaterThan(0);
  });

  for (const fx of GLM_REPLAY_FIXTURES) {
    if (fx.expectValid === null) {
      // Placeholder slot awaiting the real capture — visible as skipped, not green.
      it.skip(`${fx.name} (placeholder — awaiting real glm-5.1 capture)`, () => {});
      continue;
    }

    const expectation = fx.expectValid ? "produces a valid summary" : "documents a parser gap";
    it(`${fx.name} → ${expectation}`, async () => {
      const result = await replaySummaryThroughParser(fx.raw);
      if (fx.expectValid) {
        expect(result.ok).toBe(true);
        expect((result.summary ?? "").length).toBeGreaterThan(0);
      } else {
        // A legitimately-unparseable output: the gate records the gap (so a future
        // parser/repair improvement flips this fixture to expectValid:true).
        expect(result.ok).toBe(false);
      }
    });
  }
});
