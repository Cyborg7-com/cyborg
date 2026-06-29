// Single source of truth for an agent's display name.
//
// HISTORY (why this exists): the "cybo agent shows its PROVIDER instead of its
// name" bug regressed repeatedly (0b951ac0, c8418f83, 0dcc1830, …) because every
// surface — AgentsPane, ChannelSidebar, HomePane, the agent page, ProfilePanel,
// DaemonDetail — kept its OWN copy of the fallback chain (and its own
// PROVIDER_LABELS), and each new/redesigned surface silently dropped a step.
// The June-1 fix denormalized `cyboName` into the daemon's list_agents response
// (and the relay aggregates rows verbatim, so it survives cloud mode); what
// kept breaking was the client-side resolution. So: ONE resolver, used by every
// surface. agent-display.test.ts has a guard that fails the build if a new
// local resolver or PROVIDER_LABELS copy appears.
//
// Priority order:
//   1. cyboName  — server-denormalized by the daemon (covers DB + local cybos).
//   2. cyboId looked up in the caller's cybo list — fallback for older daemons.
//   3. PROVIDER_LABELS pretty name, else the raw provider id.
//   4. agentId prefix, else "Agent".

export const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Cybo",
  copilot: "Copilot",
  qwen: "Qwen",
};

export interface AgentNameSource {
  cyboName?: string | null;
  cyboId?: string | null;
  provider?: string | null;
  agentId?: string | null;
}

export function agentDisplayName(
  agent: AgentNameSource | null | undefined,
  cybos?: ReadonlyArray<{ id: string; name: string }>,
): string {
  // Defensive: rows arrive over the wire; a missing agent must never throw.
  if (!agent) return "Agent";
  if (agent.cyboName) return agent.cyboName;
  if (agent.cyboId && cybos) {
    const cybo = cybos.find((c) => c.id === agent.cyboId);
    if (cybo) return cybo.name;
  }
  if (agent.provider) return PROVIDER_LABELS[agent.provider] ?? agent.provider;
  return agent.agentId ? agent.agentId.slice(0, 10) : "Agent";
}

// ─── Provider brand colors ────────────────────────────────────────────────
// Avatar background colors for known provider CLIs, so e.g. Claude reads as its
// signature orange on every surface (roster, home, agent header). Unknown
// providers return undefined — callers fall back to a hashed/neutral color.
export const PROVIDER_BRAND_COLORS: Record<string, string> = {
  claude: "#D97757", // Anthropic coral/orange
  codex: "#10A37F", // OpenAI green
  gemini: "#4285F4", // Google blue
};

export function providerBrandColor(provider: string | null | undefined): string | undefined {
  return provider ? PROVIDER_BRAND_COLORS[provider.toLowerCase()] : undefined;
}

/** Mention-style handle derived from the display name ("Apex" -> "apex"). */
export function agentHandle(
  agent: AgentNameSource | null | undefined,
  cybos?: ReadonlyArray<{ id: string; name: string }>,
): string {
  const handle = agentDisplayName(agent, cybos)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (handle) return handle;
  // A name made entirely of non-latin/emoji characters strips to "" — fall
  // back to the agent id so the mention handle is never empty.
  const id = (agent?.agentId ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return id ? id.slice(0, 10) : "agent";
}
