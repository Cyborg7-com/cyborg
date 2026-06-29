// End-to-end persistence round-trip for a cybo's Composio `tool_grants`.
//
// Proves the capability blob survives the full storage path the WS handlers feed
// into — DualStorage.createCybo → SQLite → getCybo → DualStorage.updateCybo (set /
// clear) — and that what comes back out parses cleanly into the structured grants
// the spawn path (parseCyboToolGrants) and the ownership engine (resolveComposioTools)
// consume. If the column/serialization wiring breaks at any layer, this fails.

import { existsSync, mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveComposioTools } from "./composio-binding.js";
import { parseCyboToolGrants } from "./composio-spawn.js";
import type { CyboToolGrants } from "./composio-types.js";
import { DualStorage } from "./dual-storage.js";
import { CyborgStorage } from "./storage.js";

const GRANTS: CyboToolGrants = {
  composio: [
    {
      toolkit: "gmail",
      binding: "caller",
      allowedActions: ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"],
      requireApproval: ["GMAIL_SEND_EMAIL"],
    },
  ],
};

describe("cybo tool_grants persistence round-trip", () => {
  let storage: DualStorage;
  let tmpDir: string;
  let dbPath: string;
  let workspaceId: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cyborg7-toolgrants-"));
    dbPath = path.join(tmpDir, "test.db");
    storage = new DualStorage(new CyborgStorage(dbPath), null);
    const user = storage.upsertUser("alice@test.com", "Alice");
    const ws = storage.createWorkspace("Test WS", user.id);
    workspaceId = ws.id;
  });

  afterEach(() => {
    storage.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(`${dbPath}${suffix}`)) unlinkSync(`${dbPath}${suffix}`);
    }
  });

  function makeCybo(toolGrants?: CyboToolGrants) {
    return storage.createCybo({
      workspaceId,
      slug: "apex",
      name: "Apex",
      soul: "helpful",
      provider: "claude",
      createdBy: "alice",
      toolGrants: toolGrants as unknown as Record<string, unknown> | undefined,
    });
  }

  it("persists tool_grants on create and reads it back as a parseable blob", () => {
    const created = makeCybo(GRANTS);
    // Stored as a JSON string on the SQLite row (same treatment as mcp_servers).
    expect(typeof created.tool_grants).toBe("string");

    const fetched = storage.getCybo(created.id);
    expect(fetched?.tool_grants).toBe(created.tool_grants);

    // The blob the spawn path will read parses back to exactly the grants we set.
    const parsed = parseCyboToolGrants(fetched?.tool_grants ?? null);
    expect(parsed).toEqual(GRANTS);
  });

  it("defaults to no grants when none are provided (byte-identical to a plain cybo)", () => {
    const created = makeCybo();
    expect(created.tool_grants ?? null).toBeNull();
    expect(parseCyboToolGrants(created.tool_grants)).toEqual({ composio: [] });
  });

  it("the round-tripped grant drives the ownership engine end to end", () => {
    const created = makeCybo(GRANTS);
    const parsed = parseCyboToolGrants(storage.getCybo(created.id)?.tool_grants ?? null);

    const resolution = resolveComposioTools(parsed.composio, {
      workspaceId,
      cyboId: created.id,
      invokerUserId: "alice",
      hasConnection: () => true, // alice has connected her Gmail
    });

    expect(resolution.available).toHaveLength(1);
    const gmail = resolution.available[0];
    expect(gmail.toolkit).toBe("gmail");
    // Tier-1 (direct) vs Tier-2 (approval) split survived the persistence round-trip.
    expect(gmail.directActions).toEqual(["GMAIL_FETCH_EMAILS"]);
    expect(gmail.approvalActions).toEqual(["GMAIL_SEND_EMAIL"]);
    // caller binding → minted for alice, scoped to this workspace (D3).
    expect(gmail.entity).toBe(`u:${workspaceId}:alice`);
  });

  it("updateCybo replaces the grants", () => {
    const created = makeCybo(GRANTS);
    const next: CyboToolGrants = {
      composio: [
        {
          toolkit: "slack",
          binding: "service",
          allowedActions: ["SLACK_SEND_MESSAGE"],
          requireApproval: [],
        },
      ],
    };
    storage.updateCybo(created.id, {
      toolGrants: next as unknown as Record<string, unknown>,
    });
    const parsed = parseCyboToolGrants(storage.getCybo(created.id)?.tool_grants ?? null);
    expect(parsed).toEqual(next);
  });

  it("updateCybo with toolGrants:null clears them; an unrelated update leaves them intact", () => {
    const created = makeCybo(GRANTS);

    // An update that does NOT mention toolGrants must preserve the existing blob.
    storage.updateCybo(created.id, { name: "Apex II" });
    expect(parseCyboToolGrants(storage.getCybo(created.id)?.tool_grants ?? null)).toEqual(GRANTS);

    // Explicit null clears them.
    storage.updateCybo(created.id, { toolGrants: null });
    expect(storage.getCybo(created.id)?.tool_grants ?? null).toBeNull();
    expect(parseCyboToolGrants(storage.getCybo(created.id)?.tool_grants)).toEqual({ composio: [] });
  });
});
