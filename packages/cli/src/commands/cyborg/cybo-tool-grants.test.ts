import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture what the CLI would send to the daemon without standing up a real one:
// the create_cybo round-trip itself is proven server-side in
// composio-tool-grants-roundtrip.test.ts. Here we prove the CLI surface — that
// `--tool-grants` reaches the wire (inline JSON + @file), stays absent when the
// flag is omitted, and fails loudly on a typo instead of silently dropping grants.
const requestMock = vi.fn();
const closeMock = vi.fn();

// Fully replace shared.js (not importOriginal) so the real client.js → @getpaseo/server
// import chain never loads — this test exercises only the CLI's tool-grants surface.
vi.mock("./shared.js", () => ({
  connectCyborgClient: vi.fn(async () => ({ request: requestMock, close: closeMock })),
  toCyborgError: (code: string, action: string, err: unknown) => {
    if (err && typeof err === "object" && "code" in err && "message" in err) return err;
    const message = err instanceof Error ? err.message : String(err);
    return { code, message: `Failed to ${action}: ${message}` };
  },
}));

const { runCyboCreateCommand } = await import("./cybo.js");

const FAKE_CYBO = {
  id: "cybo_1",
  slug: "gmailer",
  name: "Gmailer",
  provider: "claude",
  model: null,
  role: null,
  isDefault: false,
};

const GRANTS = {
  composio: [
    {
      toolkit: "gmail",
      binding: "caller",
      allowedActions: ["GMAIL_FETCH_EMAILS"],
      requireApproval: [],
    },
  ],
};

function lastPayload(): Record<string, unknown> {
  expect(requestMock).toHaveBeenCalledWith("cyborg:create_cybo", expect.anything());
  return requestMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
}

describe("cybo:create --tool-grants", () => {
  let dir: string;

  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue({ cybo: FAKE_CYBO });
    closeMock.mockReset();
    dir = mkdtempSync(join(tmpdir(), "cybo-grants-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("threads inline JSON tool grants onto the create_cybo request", async () => {
    await runCyboCreateCommand(
      "ws_1",
      "gmailer",
      "Gmailer",
      { soul: "be helpful", toolGrants: JSON.stringify(GRANTS) },
      {} as Command,
    );
    expect(lastPayload().toolGrants).toEqual(GRANTS);
  });

  it("reads tool grants from an @file path", async () => {
    const file = join(dir, "grants.json");
    writeFileSync(file, JSON.stringify(GRANTS), "utf-8");
    await runCyboCreateCommand(
      "ws_1",
      "gmailer",
      "Gmailer",
      { soul: "be helpful", toolGrants: `@${file}` },
      {} as Command,
    );
    expect(lastPayload().toolGrants).toEqual(GRANTS);
  });

  it("omits toolGrants entirely when the flag is absent (byte-identical create)", async () => {
    await runCyboCreateCommand("ws_1", "gmailer", "Gmailer", { soul: "be helpful" }, {} as Command);
    expect(lastPayload()).not.toHaveProperty("toolGrants");
  });

  it("fails loudly on invalid JSON instead of dropping the grants", async () => {
    await expect(
      runCyboCreateCommand(
        "ws_1",
        "gmailer",
        "Gmailer",
        { soul: "be helpful", toolGrants: "{not json" },
        {} as Command,
      ),
    ).rejects.toMatchObject({ code: "CYBO_CREATE_FAILED" });
    expect(requestMock).not.toHaveBeenCalled();
  });
});
