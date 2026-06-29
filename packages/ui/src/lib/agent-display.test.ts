import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentDisplayName, agentHandle, PROVIDER_LABELS } from "./agent-display.js";

describe("agentDisplayName", () => {
  // THE regression: a cybo-spawned agent must show its cybo identity, never the
  // provider — even with an ugly provider id and no client-side cybo list.
  it("a cybo agent shows its cybo name, NOT the provider", () => {
    const name = agentDisplayName({
      cyboName: "Apex",
      cyboId: "local:cybo",
      provider: "opencode-go",
      agentId: "agent_abc123",
    });
    expect(name).toBe("Apex");
    expect(name).not.toContain("opencode");
  });

  it("falls back to the caller's cybo list for older daemons without cyboName", () => {
    const name = agentDisplayName({ cyboId: "cybo_1", provider: "opencode-go", agentId: "a1" }, [
      { id: "cybo_1", name: "Researcher" },
    ]);
    expect(name).toBe("Researcher");
  });

  it("pretty-prints known providers and passes unknown ones through", () => {
    expect(agentDisplayName({ provider: "opencode" })).toBe("OpenCode");
    expect(agentDisplayName({ provider: "claude" })).toBe("Claude");
    expect(agentDisplayName({ provider: "opencode-go" })).toBe("opencode-go");
  });

  it("falls back to the agent id prefix, then 'Agent'", () => {
    expect(agentDisplayName({ agentId: "agent_0123456789abcdef" })).toBe("agent_0123");
    expect(agentDisplayName({})).toBe("Agent");
  });

  it("agentHandle derives a mention-safe handle from the resolved name", () => {
    expect(agentHandle({ cyboName: "Client intake & triage" })).toBe("clientintaketriage");
    // Non-latin / emoji names strip to "" — must fall back to the agent id,
    // never an empty handle.
    expect(agentHandle({ cyboName: "智能助手", agentId: "Agent_1234567890" })).toBe("agent12345");
    expect(agentHandle({ cyboName: "🤖🔥" })).toBe("agent");
    expect(agentHandle(null)).toBe("agent");
  });
});

// ─── Anti-recurrence guard ─────────────────────────────────────────
// This bug regressed at least 3 times because each surface kept a LOCAL copy of
// the fallback chain / PROVIDER_LABELS, and new surfaces dropped a step. This
// test fails the suite when a new local resolver appears anywhere in src/,
// pointing the author at the shared helper instead.
describe("single-resolver guard", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(svelte|ts)$/.test(entry) && !entry.endsWith(".test.ts")) out.push(p);
    }
    return out;
  }

  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files = walk(SRC).filter((f) => !f.endsWith("agent-display.ts"));

  it("no file outside agent-display.ts declares PROVIDER_LABELS", () => {
    // Regex, not includes("PROVIDER_LABELS ="): the deleted copies were declared
    // WITH a type annotation (const PROVIDER_LABELS: Record<…> = {), which a
    // plain-string check would miss entirely.
    const offenders = files.filter((f) =>
      /\bPROVIDER_LABELS\s*(?::[^=\n]+)?=/.test(readFileSync(f, "utf8")),
    );
    expect(
      offenders,
      `Local PROVIDER_LABELS copy found — import it from $lib/agent-display.ts instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no file outside agent-display.ts re-implements the cyboName fallback chain", () => {
    // `X.cyboName ?? …` is the signature of a local resolver chain. Wrappers that
    // delegate to agentDisplayName() don't match this.
    const offenders = files.filter((f) => /\.cyboName\s*\?\?/.test(readFileSync(f, "utf8")));
    expect(
      offenders,
      `Local display-name fallback chain found — use agentDisplayName() from $lib/agent-display.ts:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("PROVIDER_LABELS knows every provider the panes reference", () => {
    // Sanity that the merge of the 3 divergent copies lost nothing.
    for (const p of ["claude", "codex", "opencode", "pi", "copilot", "qwen"]) {
      expect(PROVIDER_LABELS[p], `missing label for ${p}`).toBeTruthy();
    }
  });
});
