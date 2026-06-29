import { describe, expect, it } from "vitest";
import {
  type DaemonAgentBinding,
  resolveAgentLifecycleFromBindings,
} from "./cross-daemon-lifecycle.js";

// A cross-daemon agent: the responding daemon has no live handle on it, so it
// reports lifecycle "unknown" and daemonLocal:false (dispatcher liveAgentFields).
function remoteAgentRow(agentId: string): Record<string, unknown> {
  return { agentId, provider: "claude", lifecycle: "unknown", daemonLocal: false };
}

describe("resolveAgentLifecycleFromBindings", () => {
  it("resolves a remote 'idle' agent to idle (not 'unknown')", () => {
    const agents = [remoteAgentRow("a1")];
    const bindings: DaemonAgentBinding[] = [
      { daemonId: "daemon-remote", agentId: "a1", status: "idle" },
    ];

    resolveAgentLifecycleFromBindings(agents, bindings);

    expect(agents[0].lifecycle).toBe("idle");
    expect(agents[0].daemonId).toBe("daemon-remote");
  });

  it("resolves a remote 'running' agent to running", () => {
    const agents = [remoteAgentRow("a2")];
    const bindings: DaemonAgentBinding[] = [
      { daemonId: "daemon-remote", agentId: "a2", status: "running" },
    ];

    resolveAgentLifecycleFromBindings(agents, bindings);

    expect(agents[0].lifecycle).toBe("running");
  });

  it("resolves a remote 'error' agent to error", () => {
    const agents = [remoteAgentRow("a3")];
    const bindings: DaemonAgentBinding[] = [
      { daemonId: "daemon-remote", agentId: "a3", status: "error" },
    ];

    resolveAgentLifecycleFromBindings(agents, bindings);

    expect(agents[0].lifecycle).toBe("error");
  });

  it("never downgrades a live local agent's lifecycle", () => {
    // The responder owns this agent: it already reported a real lifecycle and
    // daemonLocal:true. The coarse persisted status must not clobber it.
    const agents = [
      { agentId: "local-1", lifecycle: "running", daemonLocal: true, daemonId: "daemon-local" },
    ];
    const bindings: DaemonAgentBinding[] = [
      { daemonId: "daemon-local", agentId: "local-1", status: "idle" },
    ];

    resolveAgentLifecycleFromBindings(agents, bindings);

    expect(agents[0].lifecycle).toBe("running");
    expect(agents[0].daemonId).toBe("daemon-local");
  });

  it("stamps the owning daemonId so the cross-daemon sidebar can badge the row", () => {
    // daemonId missing on the row (older daemon) — fill it from the binding so
    // remoteDaemonLabel (PR #799) can resolve the daemon name.
    const agents = [{ agentId: "a4", lifecycle: "unknown", daemonLocal: false }];
    const bindings: DaemonAgentBinding[] = [
      { daemonId: "daemon-b", agentId: "a4", status: "idle" },
    ];

    resolveAgentLifecycleFromBindings(agents, bindings);

    expect(agents[0].daemonId).toBe("daemon-b");
    expect(agents[0].daemonLocal).toBe(false); // still flagged remote → badged
  });

  it("leaves an agent with no matching binding untouched ('unknown' stays)", () => {
    const agents = [remoteAgentRow("orphan")];
    const bindings: DaemonAgentBinding[] = [
      { daemonId: "daemon-remote", agentId: "other", status: "idle" },
    ];

    resolveAgentLifecycleFromBindings(agents, bindings);

    expect(agents[0].lifecycle).toBe("unknown");
    expect(agents[0].daemonId).toBeUndefined();
  });

  it("resolves a mixed list: remote idle + remote running, each by its own daemon", () => {
    const agents = [remoteAgentRow("m1"), remoteAgentRow("m2")];
    const bindings: DaemonAgentBinding[] = [
      { daemonId: "daemon-x", agentId: "m1", status: "idle" },
      { daemonId: "daemon-y", agentId: "m2", status: "running" },
    ];

    resolveAgentLifecycleFromBindings(agents, bindings);

    expect(agents[0].lifecycle).toBe("idle");
    expect(agents[0].daemonId).toBe("daemon-x");
    expect(agents[1].lifecycle).toBe("running");
    expect(agents[1].daemonId).toBe("daemon-y");
  });
});
