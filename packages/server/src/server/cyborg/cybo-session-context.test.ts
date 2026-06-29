import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { SqliteAgentTimelineStore } from "./sqlite-timeline-store.js";
import { CyboSessionContext } from "./cybo-session-context.js";

// Owner-scoping proof for the cybo cross-session recall tools. The data layer is the
// daemon's local SQLite (agent_bindings) + the durable timeline store
// (agent_timeline_rows) — no PG needed — so this runs everywhere, in CI.
describe("CyboSessionContext — owner-scoped cross-session recall", () => {
  let tmpDir: string;
  let storage: DualStorage;
  let timeline: SqliteAgentTimelineStore;
  let sc: CyboSessionContext;

  const ws = "ws_sc";
  const cyboA = "cybo_A";
  const cyboB = "cybo_B";
  const owner = "u_owner"; // the human talking to the cybo
  const other = "u_other"; // a DIFFERENT human — their sessions must never leak

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cybo-sc-"));
    const sqlite = new CyborgStorage(path.join(tmpDir, "cache.db"));
    storage = new DualStorage(sqlite, null);
    timeline = new SqliteAgentTimelineStore(path.join(tmpDir, "timeline.db"));
    sc = new CyboSessionContext(storage, timeline);

    sqlite.ensureUser(owner);
    sqlite.ensureUser(other);
    sqlite.createWorkspaceWithId(ws, "WS", owner);
    sqlite.addMember(ws, owner, "member");
    sqlite.addMember(ws, other, "member");
  });

  afterEach(async () => {
    try {
      await storage.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  async function seedSession(opts: {
    agentId: string;
    cyboId: string;
    initiatedBy: string;
    ephemeral?: boolean;
    channelId?: string | null;
    messages: { role: "user" | "assistant"; text: string }[];
  }): Promise<void> {
    storage.createAgentBinding({
      agentId: opts.agentId,
      workspaceId: ws,
      provider: "claude",
      cyboId: opts.cyboId,
      initiatedBy: opts.initiatedBy,
      ephemeral: opts.ephemeral ?? true,
      channelId: opts.channelId ?? null,
    });
    for (const m of opts.messages) {
      await timeline.appendCommitted(opts.agentId, {
        type: m.role === "user" ? "user_message" : "assistant_message",
        text: m.text,
      });
    }
  }

  it("lists only the owner's sessions with the cybo, never another user's", async () => {
    await seedSession({
      agentId: "s_owner_1",
      cyboId: cyboA,
      initiatedBy: owner,
      messages: [{ role: "user", text: "deploy plan v1" }],
    });
    await seedSession({
      agentId: "s_other_1",
      cyboId: cyboA,
      initiatedBy: other,
      messages: [{ role: "user", text: "secret other-user thing" }],
    });

    const ownerLocalId = sc.resolveOwnerLocalId("s_owner_current", undefined) ?? owner;
    const sessions = await sc.listSessions({
      workspaceId: ws,
      cyboId: cyboA,
      ownerLocalId,
      currentAgentId: "s_owner_current",
    });
    const ids = sessions.map((s) => s.sessionId);
    expect(ids).toContain("s_owner_1");
    expect(ids).not.toContain("s_other_1"); // the other user's ephemeral session never leaks
  });

  it("scopes sessions to the SAME cybo (not the owner's sessions with a different cybo)", async () => {
    await seedSession({
      agentId: "s_a",
      cyboId: cyboA,
      initiatedBy: owner,
      messages: [{ role: "assistant", text: "from cybo A" }],
    });
    await seedSession({
      agentId: "s_b",
      cyboId: cyboB,
      initiatedBy: owner,
      messages: [{ role: "assistant", text: "from cybo B" }],
    });

    const sessions = await sc.listSessions({
      workspaceId: ws,
      cyboId: cyboA,
      ownerLocalId: owner,
      currentAgentId: "cur",
    });
    const ids = sessions.map((s) => s.sessionId);
    expect(ids).toEqual(["s_a"]); // only this cybo's sessions
  });

  it("reads an owner's session timeline, but refuses another user's session", async () => {
    await seedSession({
      agentId: "s_owner_2",
      cyboId: cyboA,
      initiatedBy: owner,
      messages: [
        { role: "user", text: "what is the rollback step" },
        { role: "assistant", text: "step 3 is the rollback" },
      ],
    });
    await seedSession({
      agentId: "s_other_2",
      cyboId: cyboA,
      initiatedBy: other,
      messages: [{ role: "user", text: "do not show me" }],
    });

    const mine = await sc.readSession({
      workspaceId: ws,
      cyboId: cyboA,
      ownerLocalId: owner,
      sessionId: "s_owner_2",
    });
    expect(mine).not.toBeNull();
    expect(mine!.map((e) => e.role)).toEqual(["user", "assistant"]);
    expect(mine!.some((e) => e.text.includes("rollback"))).toBe(true);

    // The other user's session is invisible at the data layer → null (not its rows).
    const forbidden = await sc.readSession({
      workspaceId: ws,
      cyboId: cyboA,
      ownerLocalId: owner,
      sessionId: "s_other_2",
    });
    expect(forbidden).toBeNull();
  });

  it("searches across the owner's sessions for recall, excluding the current session and other users", async () => {
    await seedSession({
      agentId: "s_recall",
      cyboId: cyboA,
      initiatedBy: owner,
      messages: [{ role: "user", text: "my favorite color is teal" }],
    });
    await seedSession({
      agentId: "s_current",
      cyboId: cyboA,
      initiatedBy: owner,
      messages: [{ role: "user", text: "favorite color asked again right now" }],
    });
    await seedSession({
      agentId: "s_other_recall",
      cyboId: cyboA,
      initiatedBy: other,
      messages: [{ role: "user", text: "their favorite color is red" }],
    });

    const hits = await sc.searchSessions({
      workspaceId: ws,
      cyboId: cyboA,
      ownerLocalId: owner,
      query: "favorite color",
      currentAgentId: "s_current",
    });
    const ids = hits.map((h) => h.sessionId);
    expect(ids).toContain("s_recall"); // found the recall in the owner's other session
    expect(ids).not.toContain("s_current"); // current session excluded by default
    expect(ids).not.toContain("s_other_recall"); // other user's session never searched
    expect(hits.find((h) => h.sessionId === "s_recall")!.snippet).toContain("teal");
  });

  it("excludes/flags the current session in the list", async () => {
    await seedSession({
      agentId: "cur",
      cyboId: cyboA,
      initiatedBy: owner,
      messages: [{ role: "user", text: "current" }],
    });
    await seedSession({
      agentId: "past",
      cyboId: cyboA,
      initiatedBy: owner,
      messages: [{ role: "user", text: "past" }],
    });

    const all = await sc.listSessions({
      workspaceId: ws,
      cyboId: cyboA,
      ownerLocalId: owner,
      currentAgentId: "cur",
    });
    expect(all.find((s) => s.sessionId === "cur")!.isCurrent).toBe(true);
    expect(all.find((s) => s.sessionId === "past")!.isCurrent).toBe(false);
  });
});
