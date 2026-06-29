// Bootstrap the FIRST superadmin (committed, reusable for prod). A tsx CLI:
//
//   tsx packages/server/src/server/cyborg/db/grant-superadmin.ts <email>
//
// Looks up the user by email and idempotently upserts their admin_users row
// (is_superadmin=true, granted_by=NULL — the SQL bootstrap marker), then prints
// the resulting row. Refuses if the user doesn't exist. This is how the very
// first superadmin is created (per CTO decision: bootstrap via DB, then that user
// grants others from the UI). Uses the same getPool()/drizzle as migrate.
//
// Requires DATABASE_URL. Exits non-zero on any failure so a deploy/ops run fails
// loudly. SAFE + IDEMPOTENT: re-running for an already-granted user re-grants
// (no-op state) and re-prints the row.
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, ilike } from "drizzle-orm";
import { getPool, closePool } from "./connection.js";
import * as schema from "./schema.js";

async function main(): Promise<void> {
  const email = process.argv[2]?.trim();
  if (!email) {
    console.error("Usage: tsx grant-superadmin.ts <email>");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — refusing to run.");
    process.exit(1);
  }

  const db = drizzle(getPool(), { schema });
  try {
    // Case-insensitive lookup so the ops caller needn't match the stored casing.
    // emails are unique, but two rows could differ only by case — refuse on an
    // ambiguous match rather than grant superadmin to an arbitrary one.
    const matches = await db
      .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name })
      .from(schema.users)
      .where(ilike(schema.users.email, email))
      .limit(2);
    if (matches.length === 0) {
      console.error(`No user found with email "${email}". Refusing to grant.`);
      await closePool();
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(
        `Multiple users match "${email}" (case-insensitive): ${matches
          .map((m) => m.email)
          .join(", ")}. Re-run with the exact email. Refusing to grant.`,
      );
      await closePool();
      process.exit(1);
    }
    const user = matches[0]!;

    const now = new Date();
    // Idempotent grant (mirrors PgSync.grantSuperadmin, granted_by=NULL for the
    // bootstrap): a fresh row OR a previously-revoked row both end up active.
    await db
      .insert(schema.adminUsers)
      .values({
        userId: user.id,
        isSuperadmin: true,
        grantedBy: null,
        grantedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.adminUsers.userId,
        set: {
          isSuperadmin: true,
          grantedBy: null,
          grantedAt: now,
          revokedBy: null,
          revokedAt: null,
          updatedAt: now,
        },
      });

    const [row] = await db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.userId, user.id))
      .limit(1);

    console.log(`Granted superadmin to ${user.email} (${user.id}).`);
    console.log(JSON.stringify(row, null, 2));
    await closePool();
    process.exit(0);
  } catch (err) {
    console.error("grant-superadmin FAILED:", err instanceof Error ? err.message : err);
    // intentional: best-effort pool teardown before a non-zero exit.
    await closePool().catch(() => {});
    process.exit(1);
  }
}

void main();
