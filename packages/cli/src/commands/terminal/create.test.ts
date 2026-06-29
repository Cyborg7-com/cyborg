import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Command } from "commander";

// Capture every cyborg:* RPC the create command issues so we can assert it threads
// the workspaceId through to cyborg:start_terminal (terminal CLI-UI unification).
const requests: Array<{ type: string; params?: Record<string, unknown> }> = [];
const closed = { count: 0 };

vi.mock("../cyborg/client.js", () => ({
  connectCyborg: vi.fn(async () => ({
    request: async (type: string, params?: Record<string, unknown>) => {
      requests.push({ type, params });
      if (type === "cyborg:start_terminal") {
        return { ok: true, terminalId: "term-xyz" };
      }
      return {};
    },
    close: () => {
      closed.count += 1;
    },
  })),
}));

// Fully mock ./shared.js — its real module chain pulls in @getpaseo/server (a
// build artifact not present in the unit-test env). The create command only needs
// connectTerminalClient (the Paseo path — made to throw so a regression that routes
// a workspace-bound create through Paseo fails loudly) and toTerminalCommandError
// (preserve the {code,message} shape the command relies on).
vi.mock("./shared.js", () => ({
  connectTerminalClient: vi.fn(async () => {
    throw new Error("Paseo path used for a workspace-bound create");
  }),
  toTerminalCommandError: (code: string, action: string, err: unknown) => {
    if (err && typeof err === "object" && "code" in err && "message" in err) {
      return err;
    }
    const message = err instanceof Error ? err.message : String(err);
    return { code, message: `Failed to ${action}: ${message}` };
  },
}));

import { runCreateCommand } from "./create.js";

const fakeCommand = {} as Command;

beforeEach(() => {
  requests.length = 0;
  closed.count = 0;
});

describe("terminal create --workspace (cyborg path)", () => {
  it("threads the workspaceId through to the cyborg:start_terminal RPC", async () => {
    const result = await runCreateCommand(
      { workspace: "ws-42", cwd: "/home/me/repo", token: "tok", daemon: "d1" },
      fakeCommand,
    );

    const start = requests.find((r) => r.type === "cyborg:start_terminal");
    expect(start).toBeDefined();
    expect(start?.params?.workspaceId).toBe("ws-42");
    expect(start?.params?.cwd).toBe("/home/me/repo");
    expect(start?.params?.daemonId).toBe("d1");
    // The pty geometry is seeded so the daemon can spawn before the UI fit() runs.
    expect(start?.params?.cols).toBe(80);
    expect(start?.params?.rows).toBe(24);

    // Returns the new terminal as a single row, keyed by the daemon-issued id.
    expect(result.type).toBe("single");
    expect(result.data.id).toBe("term-xyz");
    expect(result.data.cwd).toBe("/home/me/repo");

    // The cyborg client is always closed (best-effort teardown).
    expect(closed.count).toBe(1);
  });

  it("surfaces a daemon error as a TERMINAL_CREATE_FAILED command error", async () => {
    // Re-mock the request to fail for this case via a one-off module override.
    const mod = await import("../cyborg/client.js");
    vi.mocked(mod.connectCyborg).mockResolvedValueOnce({
      request: async (type: string) => {
        requests.push({ type });
        return { ok: false, error: "terminal session limit reached on this daemon" };
      },
      close: () => {
        closed.count += 1;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await expect(
      runCreateCommand({ workspace: "ws-42", token: "tok" }, fakeCommand),
    ).rejects.toMatchObject({ code: "TERMINAL_CREATE_FAILED" });
    expect(closed.count).toBe(1);
  });
});
