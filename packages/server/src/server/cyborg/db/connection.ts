import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    // Managed Postgres (Neon, RDS) requires TLS. Detect by host or explicit
    // sslmode so the migrator/connection negotiates SSL — without this a Neon URL
    // (no sslmode in the string) connected without TLS and was rejected.
    const needsSsl =
      url.includes("sslmode=require") ||
      url.includes("rds.amazonaws.com") ||
      url.includes("neon.tech");
    pool = new Pool({
      connectionString: url,
      max: 10,
      ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
  }
  return pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
