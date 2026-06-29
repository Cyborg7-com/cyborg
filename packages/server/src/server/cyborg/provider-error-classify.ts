// Pure classifier for cybo-runtime provider-probe errors (e.g. a failing
// `pi auth list` / model fetch). Turns a raw provider error string into a
// structured, user-actionable reason so the UI shows the EXACT remedy instead of
// a generic "not connected". Single source of truth.
//
// IMPORTANT: keep `ProviderReasonKind` in sync with the UI wire type
// (packages/ui/src/lib/plugins/agents/types.ts).

export type ProviderReasonKind =
  | "usage_gated"
  | "auth_invalid"
  | "not_configured"
  | "expired"
  | "rate_limited"
  | "unknown";

export interface ClassifiedProviderError {
  kind: ProviderReasonKind;
  // Short, safe-to-show reason (never includes secrets — probe output only).
  reason: string;
}

// Ordered most-specific first; the first rule whose substrings appear (lowercased)
// wins. Table-driven so adding a provider quirk is one row, not a new branch.
interface Rule {
  kind: Exclude<ProviderReasonKind, "unknown">;
  reason: string;
  match: readonly string[];
}

const RULES: readonly Rule[] = [
  {
    // Anthropic Pro/Max via a third-party app: refuses requests until the user
    // adds "extra usage" at claude.ai/settings/usage.
    kind: "usage_gated",
    reason: "Your Claude plan is refusing third-party-app requests until you add usage.",
    match: ["extra usage", "settings/usage"],
  },
  {
    kind: "rate_limited",
    reason: "The provider is rate-limiting requests right now.",
    match: ["rate limit", "rate_limit", "429", "overloaded"],
  },
  {
    kind: "expired",
    reason: "The saved credentials expired — reconnect the provider.",
    match: ["expired", "token has expired", "reauthenticate", "re-authenticate"],
  },
  {
    kind: "auth_invalid",
    reason: "The provider rejected the credentials (unauthorized).",
    // "api-key" catches Anthropic's "invalid x-api-key".
    match: [
      "401",
      "unauthorized",
      "api key",
      "api-key",
      "invalid_api_key",
      "authentication_error",
      "permission_error",
    ],
  },
  {
    kind: "not_configured",
    reason: "No credentials are set up for this provider.",
    match: ["no auth", "not configured", "no credentials", "not logged in"],
  },
];

function truncate(text: string, max = 240): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function classifyProviderError(raw: string | null | undefined): ClassifiedProviderError {
  const text = (raw ?? "").trim();
  if (!text) {
    return { kind: "unknown", reason: "The runtime didn't report a reason." };
  }
  const lower = text.toLowerCase();
  // The runtime prints "(empty)" when a provider has no auth at all.
  if (lower === "(empty)") {
    return { kind: "not_configured", reason: "No credentials are set up for this provider." };
  }
  for (const rule of RULES) {
    if (rule.match.some((needle) => lower.includes(needle))) {
      return { kind: rule.kind, reason: rule.reason };
    }
  }
  return { kind: "unknown", reason: truncate(text) };
}
