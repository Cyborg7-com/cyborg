import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Read-only session viewer (#994) contract lock — source scan.
//
// The viewer is a .svelte file (can't be runtime-imported under this package's
// plain-node vitest — no DOM), and its whole reason to exist is a STRUCTURAL
// guarantee: it is attach-free. The prior "live:false view" regressed because
// opening it dropped through to an attach/revive. So we lock the contract at the
// source level: the viewer mounts the transcript renderer but NONE of the
// mutating affordances, and it calls ONLY the two pure-read data paths.

const viewer = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "ReadOnlySessionViewer.svelte"),
  "utf-8",
);

describe("ReadOnlySessionViewer is strictly read-only + attach-free (#994)", () => {
  it("mounts the transcript renderer (AgentStreamView)", () => {
    expect(viewer).toContain("import AgentStreamView from");
    expect(viewer).toContain("<AgentStreamView");
  });

  it("does NOT mount the composer (the sole revive trigger)", () => {
    expect(viewer).not.toContain("AgentComposer");
  });

  it("does NOT pass onRewind and mounts no model/mode/thinking/archive control", () => {
    expect(viewer).not.toContain("onRewind");
    // None of the mutating client RPCs may appear anywhere in the viewer.
    for (const mutating of [
      "sendAgentPrompt",
      "setAgentModel",
      "setAgentMode",
      "setAgentThinking",
      "rewindAgent",
      "archiveAgent",
      "reloadSession",
      "ensureAgentLoaded",
      "resumeAgent",
      "createAgent",
    ]) {
      expect(viewer).not.toContain(mutating);
    }
  });

  it("issues ONLY the two pure-read RPCs to load its data", () => {
    expect(viewer).toContain("fetchAgentTimeline(client, agentId)");
    expect(viewer).toContain("client.fetchSessionContext(workspaceId, agentId)");
  });

  it("renders the three ephemeral context sections (system prompt / tools / received prompt)", () => {
    expect(viewer).toContain('data-testid="context-system-prompt"');
    expect(viewer).toContain('data-testid="context-tools"');
    expect(viewer).toContain('data-testid="context-received-prompt"');
    // The context panel only renders for an ephemeral session (context !== null).
    expect(viewer).toContain("context !== null");
  });
});
