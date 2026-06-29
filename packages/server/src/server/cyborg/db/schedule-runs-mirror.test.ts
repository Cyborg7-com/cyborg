import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb, closePool } from "./connection.js";
import * as schema from "./schema.js";
import { PgSync } from "./pg-sync.js";

const hasPg = !!process.env.DATABASE_URL;

// PG-gated (#619): proves the schedule_runs mirror + lifecycle columns exist and
// round-trip through PgSync, and that listSchedulesWithStaleness flags a schedule
// whose only daemon is offline. Mirrors db/daemon-label-sticky.test.ts. Run with
// DATABASE_URL tunnelled to the dev DB AFTER applying migration 0004.
describe.skipIf(!hasPg)(
  "PgSync schedule_runs mirror + staleness (#619, requires DATABASE_URL)",
  () => {
    let db: ReturnType<typeof getDb>;
    let pg: PgSync;

    const ownerId = randomUUID();
    const wsId = `ws_${randomUUID()}`;
    const cyboId = `cybo_${randomUUID()}`;
    const daemonId = `dmn_${randomUUID()}`;
    const scheduleIds: string[] = [];

    beforeAll(async () => {
      db = getDb();
      pg = new PgSync();
      // The shared dev DB may predate migration 0004 — these adds are additive +
      // idempotent, so ensuring them here keeps the test self-contained.
      await db.execute(sql`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS max_runs integer`);
      await db.execute(
        sql`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS run_count integer NOT NULL DEFAULT 0`,
      );
      await db.execute(
        sql`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS catch_up boolean NOT NULL DEFAULT true`,
      );
      await db.execute(sql`CREATE TABLE IF NOT EXISTS schedule_runs (
      id text PRIMARY KEY,
      schedule_id text NOT NULL,
      workspace_id text NOT NULL,
      scheduled_for timestamp with time zone,
      started_at timestamp with time zone NOT NULL DEFAULT now(),
      ended_at timestamp with time zone,
      status text NOT NULL,
      skip_reason text,
      agent_id text,
      error text
    )`);

      await db
        .insert(schema.users)
        .values({ id: ownerId, email: `sr-${ownerId}@e2e.dev`, name: "O" });
      await db.insert(schema.workspaces).values({ id: wsId, name: "SR", ownerId });
      await db.insert(schema.cybos).values({
        id: cyboId,
        workspaceId: wsId,
        slug: "c",
        name: "C",
        soul: "s",
        provider: "claude",
        createdBy: ownerId,
      });
    });

    afterAll(async () => {
      for (const id of scheduleIds) {
        await db.delete(schema.scheduleRuns).where(eq(schema.scheduleRuns.scheduleId, id));
        await db.delete(schema.schedules).where(eq(schema.schedules.id, id));
      }
      await db.delete(schema.daemons).where(eq(schema.daemons.id, daemonId));
      await db.delete(schema.cybos).where(eq(schema.cybos.id, cyboId));
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, wsId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerId));
      await closePool();
    });

    async function newSchedule(over: {
      nextRunAt?: number | null;
      maxRuns?: number | null;
      catchUp?: number;
    }): Promise<string> {
      const id = `sched_${randomUUID()}`;
      scheduleIds.push(id);
      await pg.createSchedule({
        id,
        workspace_id: wsId,
        cybo_id: cyboId,
        channel_id: null,
        cron_expr: "0 9 * * *",
        timezone: null,
        prompt: "p",
        enabled: 1,
        next_run_at: over.nextRunAt ?? Date.now(),
        max_runs: over.maxRuns ?? null,
        catch_up: over.catchUp ?? 1,
        created_by: ownerId,
      });
      return id;
    }

    it("createSchedule mirrors the lifecycle columns", async () => {
      const id = await newSchedule({ maxRuns: 1, catchUp: 0 });
      const s = await pg.getSchedule(id);
      expect(s?.max_runs).toBe(1);
      expect(s?.catch_up).toBe(0);
      expect(s?.run_count).toBe(0);
    });

    it("start → finish run rows round-trip, newest first", async () => {
      const id = await newSchedule({});
      const runId = `schrun_${randomUUID()}`;
      const slot = Date.now();
      await pg.startScheduleRun({
        id: runId,
        schedule_id: id,
        workspace_id: wsId,
        scheduled_for: slot,
        started_at: slot,
      });
      let runs = await pg.listScheduleRuns(id);
      expect(runs[0].status).toBe("running");

      await pg.finishScheduleRun({
        id: runId,
        status: "succeeded",
        agentId: "ag_1",
        error: null,
        endedAt: Date.now(),
      });
      runs = await pg.listScheduleRuns(id);
      expect(runs[0].status).toBe("succeeded");
      expect(runs[0].agent_id).toBe("ag_1");
    });

    it("recordSkippedScheduleRun persists the closed-set reason", async () => {
      const id = await newSchedule({});
      await pg.recordSkippedScheduleRun({
        id: `schrun_${randomUUID()}`,
        schedule_id: id,
        workspace_id: wsId,
        scheduled_for: Date.now(),
        skipReason: "overlap",
        at: Date.now(),
      });
      const runs = await pg.listScheduleRuns(id);
      expect(runs[0].status).toBe("skipped");
      expect(runs[0].skip_reason).toBe("overlap");
    });

    it("markScheduleRun(increment) bumps the mirror run_count in lockstep", async () => {
      const id = await newSchedule({});
      await pg.markScheduleRun(id, Date.now(), Date.now() + 60_000, true);
      await pg.markScheduleRun(id, Date.now(), Date.now() + 60_000, true);
      expect((await pg.getSchedule(id))?.run_count).toBe(2);
    });

    it("listSchedulesWithStaleness flags an overdue schedule when the daemon is offline", async () => {
      // An overdue schedule + an OFFLINE daemon subscribed to the workspace.
      const id = await newSchedule({ nextRunAt: Date.now() - 60 * 60_000 });
      await db.insert(schema.daemons).values({
        id: daemonId,
        ownerId,
        label: "d",
        status: "offline",
        lastSeenAt: new Date(Date.now() - 60 * 60_000),
      });
      await db
        .insert(schema.workspaceDaemons)
        .values({ workspaceId: wsId, daemonId })
        .onConflictDoNothing();

      const rows = await pg.listSchedulesWithStaleness(wsId);
      const row = rows.find((r) => r.id === id);
      expect(row?.stale).toBe(true);
    });
  },
);
