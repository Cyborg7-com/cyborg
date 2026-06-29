import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { getPool } from "./connection.js";
import * as schema from "./schema.js";

// The generated Drizzle migrations folder (0000_init.sql + meta/). Resolved
// relative to this file so it works both from source (tsx on the relay) and from
// any cwd. This is the SINGLE source of truth for the PostgreSQL schema — there
// are no more hand-applied p*.sql.
const MIGRATIONS_FOLDER = fileURLToPath(new URL("./drizzle", import.meta.url));

// Fixed key for the PG advisory lock that serializes migrators, so two daemons
// (or a daemon + the relay) starting concurrently can't race the same migration.
const MIGRATION_LOCK_KEY = 0x6379_6267; // "cybg"

// Apply any pending Drizzle migrations to the PostgreSQL pointed at by
// DATABASE_URL. A no-op when the DB is already up to date (the common case on an
// already-migrated prod, once baselined — see ./drizzle/RUNBOOK.md). Idempotent
// and safe to call on every boot.
export async function runMigrations(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    // Session-level advisory lock: the second concurrent migrator blocks here
    // until the first finishes, then sees the migrations already applied.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    // The session-level advisory lock is auto-released when the client connection
    // is released/closed below anyway, so a failed explicit unlock is harmless.
    // intentional: best-effort advisory-lock release.
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}
