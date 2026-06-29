// One-time PROD BASELINE for the Drizzle migration consolidation.
//
// Prod's tables were created by the old hand-applied p*.sql (and an early manual
// drizzle apply), so they predate Drizzle's `drizzle.__drizzle_migrations`
// tracking table. Without a baseline, the first migrate would try to run
// 0000_init and fail with "relation already exists".
//
// This seeds __drizzle_migrations with the baseline migration's
// (hash, created_at) — computed EXACTLY as drizzle-orm's migrator does (it skips
// any migration whose journal `when` <= the latest recorded created_at) — so the
// baseline is treated as already applied and future migrations apply normally.
//
// SAFE + IDEMPOTENT: only INSERTs when __drizzle_migrations is empty; never
// touches data or schema. Run ONCE, AFTER a drift check confirms schema.ts
// matches prod (see ./drizzle/RUNBOOK.md), with DATABASE_URL pointing at prod:
//
//   pnpm db:baseline
//   # or on the relay host (VPC-private RDS), mirroring the relay's tsx runner:
//   #   cd <deploy-root>/deploy && NODE_PATH=<deploy-root>/deploy/node_modules \
//   #   ./node_modules/.bin/tsx <deploy-root>/packages/server/src/server/cyborg/db/seed-baseline.ts
//
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePool } from "./connection.js";

const DRIZZLE_DIR = fileURLToPath(new URL("./drizzle", import.meta.url));

function loadBaseline(): { tag: string; hash: string; createdAt: number } {
  const journal = JSON.parse(readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ tag: string; when: number }>;
  };
  const first = journal.entries?.[0];
  if (!first) throw new Error("no migrations in journal");
  // Baseline = the FIRST (oldest) migration; marking its created_at as applied
  // covers every migration up to and including it.
  const sql = readFileSync(join(DRIZZLE_DIR, `${first.tag}.sql`), "utf8");
  const hash = createHash("sha256").update(sql).digest("hex");
  return { tag: first.tag, hash, createdAt: first.when };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — refusing to run.");
    process.exit(1);
  }
  const { tag, hash, createdAt } = loadBaseline();
  console.log(`Baseline migration: ${tag}`);
  console.log(`  hash       = ${hash}`);
  console.log(`  created_at = ${createdAt}`);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
    await client.query(
      'CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" ' +
        "(id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)",
    );
    const { rows } = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations"',
    );
    if (rows[0].n > 0) {
      console.log(
        `\n__drizzle_migrations already has ${rows[0].n} row(s) — already baselined. No change.`,
      );
      await client.query("ROLLBACK");
    } else {
      await client.query(
        'INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)',
        [hash, createdAt],
      );
      await client.query("COMMIT");
      console.log("\n✅ Baseline seeded. The next migrate run will SKIP 0000_init and is a no-op.");
    }
  } catch (err) {
    // The original error below is what surfaces; an open tx is rolled back on
    // release anyway, so a failed explicit ROLLBACK here is harmless.
    // intentional: best-effort transaction rollback.
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((err: unknown) => {
  console.error("seed-baseline FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
