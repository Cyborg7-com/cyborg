import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb, closePool } from "./connection.js";
import * as schema from "./schema.js";
import { PgSync } from "./pg-sync.js";

const hasPg = !!process.env.DATABASE_URL;

// The first-writer + weekly-aggregate contract for agent_sessions (Home stats).
// Proves: cumulative-OVERWRITE token semantics (not additive), the 7-day
// workspace window, top-agents grouping/ordering, the per-day token DELTA ledger
// (token_usage_daily) that powers the heatmap — including multi-day history
// persistence and reset-aware crediting — and archive. Skips without DATABASE_URL.
describe.skipIf(!hasPg)("PgSync agent-session home stats (requires DATABASE_URL)", () => {
  let db: ReturnType<typeof getDb>;
  let pg: PgSync;

  const owner = randomUUID();
  const wsId = randomUUID();
  const a1 = randomUUID();
  const a2 = randomUUID();
  const a3 = randomUUID();
  const aOld = randomUUID();

  function start(agentId: string, provider: string) {
    return pg.upsertAgentSession({
      agentId,
      workspaceId: wsId,
      channelId: null,
      userId: owner,
      provider,
      cyboId: null,
      sessionType: "session",
      cwd: null,
    });
  }

  beforeAll(async () => {
    db = getDb();
    pg = new PgSync();
    await db
      .insert(schema.users)
      .values({ id: owner, email: `stats-${owner}@e2e.dev`, name: "Owner" });
    await db.insert(schema.workspaces).values({ id: wsId, name: "Stats WS", ownerId: owner });
  });

  afterAll(async () => {
    await db.delete(schema.agentSessions).where(eq(schema.agentSessions.workspaceId, wsId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, wsId));
    await db.delete(schema.users).where(eq(schema.users.id, owner));
    await closePool();
  });

  it("aggregates weekly tokens, sessions, top agents, and daily activity", async () => {
    await start(a1, "claude");
    await start(a2, "claude");
    await start(a3, "codex");
    await pg.recordAgentSessionUsage(a1, { inputTokens: 1000, outputTokens: 500 });
    await pg.recordAgentSessionUsage(a2, { inputTokens: 2000, outputTokens: 1000 });
    await pg.recordAgentSessionUsage(a3, { inputTokens: 300, outputTokens: 200 });

    const stats = await pg.getWorkspaceHomeStats(wsId);
    expect(stats.sessionsThisWeek).toBe(3);
    expect(stats.tokensThisWeek).toBe(5000);
    // claude (2 sessions) ranks above codex (1).
    expect(stats.topAgents[0].provider).toBe("claude");
    expect(stats.topAgents[0].sessions).toBe(2);
    expect(stats.topAgents[0].tokens).toBe(4500);
    // Daily heatmap = per-day token DELTAS. All three sessions were fresh (prior
    // total 0), so today's bucket is the sum of their first deltas: 1500+3000+500.
    expect(stats.dailyActivity.reduce((n, d) => n + d.count, 0)).toBe(5000);
  });

  it("OVERWRITES cumulative usage (never adds successive snapshots)", async () => {
    await pg.recordAgentSessionUsage(a1, { inputTokens: 9999, outputTokens: 1 });
    const stats = await pg.getWorkspaceHomeStats(wsId);
    // a1 -> 10000, a2 -> 3000, a3 -> 500.
    expect(stats.tokensThisWeek).toBe(13500);
    // The ledger credits only the DELTA: a1 went 1500 -> 10000 (+8500), so today's
    // bucket is the earlier 5000 + 8500 = 13500 (it ADDS deltas across turns).
    expect(stats.dailyActivity.reduce((n, d) => n + d.count, 0)).toBe(13500);
  });

  it("excludes sessions older than 7 days from the weekly window", async () => {
    await start(aOld, "claude");
    await pg.recordAgentSessionUsage(aOld, { inputTokens: 1_000_000, outputTokens: 0 });
    await db
      .update(schema.agentSessions)
      .set({ createdAt: sql`now() - interval '30 days'` })
      .where(eq(schema.agentSessions.id, aOld));

    const stats = await pg.getWorkspaceHomeStats(wsId);
    expect(stats.sessionsThisWeek).toBe(3); // aOld excluded
    expect(stats.tokensThisWeek).toBe(13500); // its 1M excluded
  });

  it("daily ledger keeps PER-DAY history (doesn't collapse onto one day)", async () => {
    // The recorder always credits the current day; backdate a ledger row to prove
    // the heatmap RETAINS prior days instead of losing them (the reported bug).
    await db.execute(sql`
      INSERT INTO token_usage_daily (workspace_id, day, tokens)
      VALUES (${wsId}, (now() AT TIME ZONE 'UTC')::date - 1, 7777)
    `);
    const stats = await pg.getWorkspaceHomeStats(wsId);
    expect(stats.dailyActivity.length).toBeGreaterThanOrEqual(2); // yesterday + today
    expect(stats.dailyActivity.some((d) => d.count === 7777)).toBe(true); // yesterday survives
  });

  it("credits the FULL new total when a reused session's cumulative resets", async () => {
    const aReset = randomUUID();
    await start(aReset, "claude");
    const sumDaily = (s: Awaited<ReturnType<typeof pg.getWorkspaceHomeStats>>) =>
      s.dailyActivity.reduce((n, d) => n + d.count, 0);
    await pg.recordAgentSessionUsage(aReset, { inputTokens: 5000, outputTokens: 0 }); // +5000
    const before = sumDaily(await pg.getWorkspaceHomeStats(wsId));
    // A fresh process for the same id reports a LOWER cumulative (restarted at 0).
    await pg.recordAgentSessionUsage(aReset, { inputTokens: 800, outputTokens: 0 });
    const after = sumDaily(await pg.getWorkspaceHomeStats(wsId));
    expect(after - before).toBe(800); // full new total, not a negative delta
  });

  it("archives a session row", async () => {
    await pg.archiveAgentSession(a3);
    const [row] = await db
      .select()
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, a3));
    expect(row?.status).toBe("archived");
    expect(row?.archivedAt).not.toBeNull();
  });
});
