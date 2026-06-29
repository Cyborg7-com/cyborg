// Recorded raw model output for the /summarize deterministic replay harness.
//
// WHY: /summarize generates a STRUCTURED summary — the model is asked to return JSON
// matching SUMMARY_SCHEMA ({ summary: string }), and the summarizer extracts/validates
// it via the agent/ parse path (extractJsonFromMarkdown → zod). glm-5.1 (opencode-go)
// is the model the owner runs, and its raw shape (fenced JSON? prose? bullets?) is what
// actually breaks or passes parsing. This file holds the RAW model text so the parse
// path can be replayed deterministically in CI — no provider creds, no daemon, no flake.
//
// ┌─────────────────────────────────────────────────────────────────────────────────┐
// │ TODO(rodrigo): replace `expectValid: null` entries below with the REAL raw glm-5.1 │
// │ output exported from his daemon (the exact string Pi returned for /summarize),    │
// │ and set expectValid:true (parser handles it) or false (documents a parser gap).   │
// │ Until then the SYNTHETIC fixtures below exercise the harness against glm-5.1-      │
// │ SHAPED output; they are clearly marked `synthetic: true` and are NOT a substitute  │
// │ for the real capture.                                                              │
// └─────────────────────────────────────────────────────────────────────────────────┘

export interface GlmReplayFixture {
  name: string;
  // The RAW text the model returned (verbatim), fed to the summarizer parse path.
  raw: string;
  // Expected outcome through the parser: true = a valid summary is produced,
  // false = the parser legitimately can't (documents a known gap). `null` = a
  // placeholder slot awaiting the real capture (skipped by the harness).
  expectValid: boolean | null;
  // true → invented to mirror glm's likely shape; false → a real recorded capture.
  synthetic: boolean;
}

// Synthetic, glm-5.1-SHAPED samples. opencode-go models commonly wrap the JSON in a
// ```json fence and/or precede it with prose — both must parse to a valid summary.
export const GLM_REPLAY_FIXTURES: GlmReplayFixture[] = [
  {
    name: "synthetic: bare JSON object",
    raw: '{"summary": "## Standup\\n- @ana shipped the relay fix\\n- @beto is blocked on auth"}',
    expectValid: true,
    synthetic: true,
  },
  {
    name: "synthetic: ```json fenced (typical glm/opencode wrapping)",
    raw: [
      "Here is the summary you requested:",
      "",
      "```json",
      '{"summary": "## Channel summary\\n- Decision: ship Friday\\n- Open question: who owns QA?"}',
      "```",
    ].join("\n"),
    expectValid: true,
    synthetic: true,
  },
  {
    name: "synthetic: prose preamble + inline JSON object (no fence)",
    raw: 'Sure! {"summary": "- @cy merged #327\\n- action: bump MAP_CONCURRENCY back to 4 after verify"} Let me know if you want more detail.',
    expectValid: true,
    synthetic: true,
  },
  // ── Real capture slot — fill from Rodrigo's daemon (see TODO above) ──
  // {
  //   name: "real: glm-5.1 /summarize 10 (rodrigo daemon, <date>)",
  //   raw: String.raw`<PASTE THE EXACT RAW Pi OUTPUT HERE>`,
  //   expectValid: true, // or false if it documents a parser gap to fix
  //   synthetic: false,
  // },
];
