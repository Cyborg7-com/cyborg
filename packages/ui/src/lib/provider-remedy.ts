// Remedy mapper (cybo provider-setup UX): turns the daemon's classified
// "why a connected provider is still unusable" signal (ProviderInfo.reasonKind
// + unavailableReason) into a concrete, actionable remedy the UI renders the
// same way everywhere — the honest provider status row in DaemonDetail and the
// auto-heal/honest-error path in AgentsPane.
//
// Pure module (no Svelte, no I/O): the consumers own the side effects (open a
// URL, re-check, open the setup terminal). Kept here so the mapping lives in one
// place and is unit-testable.

import type { ProviderReasonKind } from "$lib/plugins/agents/types.js";

// What a remedy button DOES — the consumer decides how to perform each kind:
//   open_url           → open `url` (desktop openExternal bridge, else window.open)
//   reconnect_api_key  → open SetupCyboTerminalDialog with an API-key hint
//   reconnect          → open SetupCyboTerminalDialog (re-run `cybo login`)
//   recheck            → force a provider re-probe (client.refreshProviders)
//   setup              → open SetupCyboTerminalDialog (first-time connect)
export type RemedyActionKind = "open_url" | "reconnect_api_key" | "reconnect" | "recheck" | "setup";

export interface RemedyAction {
  label: string;
  kind: RemedyActionKind;
  // Only set for kind === "open_url".
  url?: string;
}

export interface ProviderRemedy {
  title: string;
  body: string;
  actions: RemedyAction[];
}

// Where Claude users top up their plan when requests are usage-gated.
export const CLAUDE_USAGE_URL = "https://claude.ai/settings/usage";

// Map a classified reason + the provider's display label to a remedy. `reason`
// is ProviderInfo.unavailableReason (the EXACT, user-facing daemon text); when
// absent we fall back to a generic line so the body is never empty.
export function providerRemedy(
  reasonKind: ProviderReasonKind | null | undefined,
  providerLabel: string,
  reason?: string | null,
): ProviderRemedy {
  const label = providerLabel || "this provider";
  const detail = reason?.trim() || null;

  switch (reasonKind) {
    case "usage_gated":
      return {
        title: `${label} is connected but your plan is rejecting requests`,
        body:
          detail ??
          `${label} accepted your sign-in, but the plan or subscription is refusing requests.`,
        actions: [
          { label: "Add usage", kind: "open_url", url: CLAUDE_USAGE_URL },
          { label: "Reconnect with an API key", kind: "reconnect_api_key" },
        ],
      };

    case "auth_invalid":
    case "expired":
      return {
        title: `Reconnect ${label}`,
        body:
          detail ??
          (reasonKind === "expired"
            ? `${label}'s saved credentials expired — reconnect to keep using it.`
            : `${label}'s saved credentials were rejected — reconnect to keep using it.`),
        actions: [
          { label: "Reconnect", kind: "reconnect" },
          { label: "Use an API key", kind: "reconnect_api_key" },
        ],
      };

    case "not_configured":
      return {
        title: `Connect ${label}`,
        body: detail ?? `${label} isn't connected yet on this daemon.`,
        actions: [{ label: "Connect", kind: "setup" }],
      };

    case "rate_limited":
      return {
        title: "Rate-limited — try again shortly",
        body: detail ?? `${label} is temporarily throttled. Wait a moment, then re-check.`,
        actions: [{ label: "Re-check", kind: "recheck" }],
      };

    case "unknown":
    default:
      // We couldn't pin the exact cause (e.g. a usage-gate that only surfaces at
      // inference time isn't visible to the spawn-gate probe). Still give the full
      // escape hatch: re-check, reconnect, OR switch to an API key — the last is
      // the reliable fallback when an OAuth plan is the thing refusing requests.
      return {
        title: detail ?? `${label} is unavailable`,
        body:
          detail ??
          `${label} reported an error we couldn't classify. Re-check, reconnect, or switch to an API key.`,
        actions: [
          { label: "Re-check", kind: "recheck" },
          { label: "Reconnect", kind: "reconnect" },
          { label: "Use an API key", kind: "reconnect_api_key" },
        ],
      };
  }
}
