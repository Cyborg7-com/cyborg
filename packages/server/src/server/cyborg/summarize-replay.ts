// Deterministic replay harness for /summarize structured output.
//
// Feeds a RAW model output (e.g. a recorded glm-5.1 response) through the EXACT
// parse/repair + schema-validation path the summarizer uses — the agent/ structured
// helper getStructuredAgentResponse (extractJsonFromMarkdown → zod) — with NO
// provider, daemon, or network. This is the CLI-first verification gate's
// deterministic half: it answers "does the parser turn THIS raw model output into a
// valid summary?" repeatably in CI. The live half (a real /summarize against an
// opencode-go daemon) is documented in internal docs

import { z } from "zod";
import { getStructuredAgentResponse } from "../agent/agent-response-loop.js";

// The summarizer's `{ summary: string }` shape. Kept LOCAL to the harness (rather
// than importing summarization-runner's schema) so this gate stays fully decoupled
// from that module — it must not break or conflict when the runtime path changes how
// it produces text (e.g. the raw-text refactor that drops the JSON schema). The
// harness only needs the SHAPE to answer "does this raw output yield a valid summary?".
const SUMMARY_SCHEMA = z.object({
  summary: z.string().min(1),
});

export interface SummaryReplayResult {
  ok: boolean;
  summary?: string;
  error?: string;
}

// Replay one raw model output through the summarizer's parser. maxRetries:0 → a single
// shot (mirrors the post-#327 "one prompt per ephemeral session" path), so the verdict
// reflects THIS exact output, not a re-prompt. Returns ok+summary on success, ok:false
// with the parser error otherwise (never throws — callers assert on the result).
export async function replaySummaryThroughParser(
  rawModelOutput: string,
): Promise<SummaryReplayResult> {
  try {
    const parsed = await getStructuredAgentResponse<{ summary: string }>({
      caller: async () => rawModelOutput,
      prompt: "(replay — raw model output is returned verbatim by the caller)",
      schema: SUMMARY_SCHEMA,
      schemaName: "Summary",
      maxRetries: 0,
    });
    return { ok: true, summary: parsed.summary };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
