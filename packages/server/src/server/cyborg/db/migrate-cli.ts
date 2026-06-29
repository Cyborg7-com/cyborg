// Standalone entrypoint: apply pending Drizzle migrations, then exit. Used by
// the relay deploy (which runs it ON the EC2 host, where the VPC-private RDS is
// reachable) and exposed as `pnpm db:migrate` for local/dev PostgreSQL.
//
//   tsx packages/server/src/server/cyborg/db/migrate-cli.ts   (or: pnpm db:migrate)
//
// Requires DATABASE_URL. Exits non-zero on failure so the deploy fails loudly.
import { runMigrations } from "./migrate.js";
import { closePool } from "./connection.js";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("[migrate] DATABASE_URL is not set — nothing to do.");
    process.exit(1);
  }
  try {
    await runMigrations();
    console.log("[migrate] migrations applied");
    await closePool();
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[migrate] FAILED:", msg);
    // The classic "first run on an un-baselined prod" failure: the tables already
    // exist (created by the old hand-applied p*.sql) but __drizzle_migrations is
    // empty, so migrate tries 0000_init and hits "relation already exists". The
    // baseline must be seeded FIRST — see ./drizzle/RUNBOOK.md. drizzle wraps the
    // pg error, so check the cause chain (code 42P07 = duplicate_table) too.
    const cause = err instanceof Error ? (err.cause as { code?: string; message?: string }) : null;
    const looksAlreadyApplied =
      /already exists/i.test(msg) ||
      /already exists/i.test(cause?.message ?? "") ||
      cause?.code === "42P07";
    if (looksAlreadyApplied) {
      console.error(
        "[migrate] HINT: prod is likely not baselined. Seed drizzle.__drizzle_migrations " +
          "first (see packages/server/src/server/cyborg/db/drizzle/RUNBOOK.md), then redeploy.",
      );
    }
    // The real failure was already logged above; this teardown is best-effort.
    // intentional: best-effort pool teardown before a non-zero exit.
    await closePool().catch(() => {});
    process.exit(1);
  }
}

void main();
