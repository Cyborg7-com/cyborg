/**
 * Pure helpers for the agent context-window / token-usage / cost meter (#580).
 * Kept separate from the .svelte component so the formatting + threshold logic is
 * unit-testable without a Svelte runtime. Backend-agnostic: every field is
 * optional (providers report different subsets), so the view degrades gracefully.
 */
import type { AgentUsage } from "./types.js";

// A usable numeric field: finite (excludes NaN/±Infinity, which are `typeof
// "number"` and would otherwise propagate to `NaN%` / invalid CSS widths).
function finite(x: number | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

export interface ContextWindowView {
  /** Context occupancy %, 0–100, or null when the provider gives no max. */
  pct: number | null;
  /** Context tokens used (or total in+out as a fallback), or null. */
  usedTokens: number | null;
  /** Context window max, or null. */
  maxTokens: number | null;
  /** Estimated spend in USD, or null. */
  costUsd: number | null;
  /** Pressure level for the %, used to tint the meter. */
  level: "ok" | "high" | "critical";
}

// Build the view model. Returns null when there is NOTHING worth showing (no
// token signal and no cost) — the composer renders nothing in that case.
export function buildContextWindowView(
  usage: AgentUsage | null | undefined,
): ContextWindowView | null {
  if (!usage) return null;

  const maxTokens =
    finite(usage.contextWindowMaxTokens) && usage.contextWindowMaxTokens > 0
      ? usage.contextWindowMaxTokens
      : null;

  // Prefer the provider's reported context occupancy; fall back to in+out tokens
  // so a provider that reports usage but not a context window still shows a count.
  let usedTokens: number | null = null;
  if (finite(usage.contextWindowUsedTokens)) {
    usedTokens = usage.contextWindowUsedTokens;
  } else if (finite(usage.inputTokens) || finite(usage.outputTokens)) {
    usedTokens =
      (finite(usage.inputTokens) ? usage.inputTokens : 0) +
      (finite(usage.outputTokens) ? usage.outputTokens : 0);
  }

  const costUsd = finite(usage.totalCostUsd) ? usage.totalCostUsd : null;

  // Nothing to show.
  if (usedTokens === null && costUsd === null) return null;

  // Clamp 0–100 so a negative or over-budget count can't produce a bad bar width.
  const pct =
    maxTokens !== null && usedTokens !== null
      ? Math.max(0, Math.min(100, Math.round((usedTokens / maxTokens) * 100)))
      : null;

  let level: ContextWindowView["level"] = "ok";
  if (pct !== null) {
    if (pct >= 90) level = "critical";
    else if (pct >= 75) level = "high";
  }

  return { pct, usedTokens, maxTokens, costUsd, level };
}

// Compact token count, e.g. 84_000 → "84k", 1_500_000 → "1.5M", 920 → "920".
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  // Threshold 999_500 (not 1_000_000) so e.g. 999_500 reads "1.0M" not "1000k".
  if (n < 999_500) {
    const k = n / 1000;
    const roundedK = Math.round(k);
    // Check the ROUNDED value so 99_950 → "100k" (not "100.0k").
    return `${roundedK >= 100 || Number.isInteger(k) ? roundedK : k.toFixed(1)}k`;
  }
  const m = n / 1_000_000;
  const roundedM = Math.round(m);
  return `${roundedM >= 100 || Number.isInteger(m) ? roundedM : m.toFixed(1)}M`;
}

// Estimated cost. Small spends keep more precision so an in-progress turn doesn't
// read as "$0.00": <$1 → 3 decimals, else 2.
export function formatCost(usd: number): string {
  return `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

// One-line tooltip with the full breakdown (only the parts the provider gave).
export function contextWindowTooltip(usage: AgentUsage, view: ContextWindowView): string {
  const parts: string[] = [];
  if (view.usedTokens !== null && view.maxTokens !== null) {
    parts.push(
      `Context: ${formatTokens(view.usedTokens)} / ${formatTokens(view.maxTokens)} tokens (${view.pct}%)`,
    );
  } else if (view.usedTokens !== null) {
    parts.push(`Tokens: ${formatTokens(view.usedTokens)}`);
  }
  const hasIn = finite(usage.inputTokens);
  const hasOut = finite(usage.outputTokens);
  if (hasIn || hasOut) {
    // Inline the type-guard (not the hasIn/hasOut vars) so TS narrows the operand
    // to `number` for formatTokens — a stored boolean from a guard call doesn't.
    const inTokens = finite(usage.inputTokens) ? usage.inputTokens : 0;
    const outTokens = finite(usage.outputTokens) ? usage.outputTokens : 0;
    parts.push(`In ${formatTokens(inTokens)} · Out ${formatTokens(outTokens)}`);
  }
  if (view.costUsd !== null) parts.push(`Cost: ${formatCost(view.costUsd)}`);
  return parts.join("\n");
}
