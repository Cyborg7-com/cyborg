// Pure override-merge for restoring an archived session with config overrides
// (#593). Kept dependency-free so the merge shape is unit-testable in isolation
// (CLI-first), and so both the dispatcher (local restore) and any future caller
// build the SAME Partial<AgentSessionConfig> handed to Paseo's
// resumeAgentFromPersistence — which merges `handle.metadata ⊕ overrides` and
// re-applies model/mode on resume.
//
// The contract is "least surprise": only fields the caller actually set are
// forwarded, and `cwd` is always pinned so the resumed session lands in the
// archived working directory (matching importProviderSession's behavior). An
// empty/omitted override object yields ONLY the cwd pin (or nothing), i.e. the
// exact legacy resume.

import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";

// The wire shape the client/protocol carries (a subset of AgentSessionConfig).
// thinkingOptionId is nullable on the wire (null = "disable thinking").
export interface RestoreSessionOverrides {
  model?: string;
  modeId?: string;
  thinkingOptionId?: string | null;
}

export interface BuildResumeOverridesInput {
  /** Archived working directory (always pinned when present). */
  cwd?: string;
  /** Caller-supplied model/mode/thinking overrides (all optional). */
  overrides?: RestoreSessionOverrides;
}

// True when the caller asked to change at least one config field that the resume
// will ACTUALLY apply (model / mode / a non-null thinking id) — i.e. this restore
// is NOT a plain resume-as-archived. The cwd pin alone does NOT count
// (importProviderSession always pins cwd too). A null thinkingOptionId is treated
// as "no change": AgentSessionConfig types thinkingOptionId as `string | undefined`
// (no null), so we can't forward an explicit "off" through resume — buildResumeOverrides
// drops it — and this predicate stays in lockstep with what's actually forwarded,
// so it answers "should we take the override-aware resume path?".
export function hasResumeConfigOverrides(overrides?: RestoreSessionOverrides): boolean {
  if (!overrides) return false;
  return (
    overrides.model !== undefined ||
    overrides.modeId !== undefined ||
    (overrides.thinkingOptionId !== undefined && overrides.thinkingOptionId !== null)
  );
}

// Build the Partial<AgentSessionConfig> to hand to resumeAgentFromPersistence.
// Only set fields are copied. An explicit `null` thinkingOptionId is dropped to
// `undefined` so the result stays assignable to AgentSessionConfig (which types
// thinkingOptionId as `string | undefined`) — a null means "no thinking", which
// is the resume default, so omitting it is equivalent.
export function buildResumeOverrides(
  input: BuildResumeOverridesInput,
): Partial<AgentSessionConfig> {
  const out: Partial<AgentSessionConfig> = {};
  if (input.cwd !== undefined) out.cwd = input.cwd;
  const o = input.overrides;
  if (o?.model !== undefined) out.model = o.model;
  if (o?.modeId !== undefined) out.modeId = o.modeId;
  if (o?.thinkingOptionId) out.thinkingOptionId = o.thinkingOptionId;
  return out;
}
