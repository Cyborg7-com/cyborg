-- Workspace disable (superadmin moderation) — adds the moderation columns that
-- let a superadmin DISABLE an organization. A set disabled_at removes the org
-- from every member's listing and blocks (re)subscribing to its broadcasts.
--   * workspaces.disabled_at/disabled_reason/disabled_by — disable state +
--     reason + the acting admin (FK SET NULL).
--
-- Additive + backward-compatible + IDEMPOTENT (ADD COLUMN IF NOT EXISTS, guarded
-- ALTER TABLE ... ADD CONSTRAINT), matching the repo's hand-applied-prod
-- convention — see 0015_superadmin.sql. The new nullable columns default to NULL
-- so every existing workspace stays byte-identical (NULL = active, today's
-- behavior); the OLD relay tolerates them. Safe no-op on a re-run.
--
-- The new 0016 journal `when` is stamped ABOVE the live DB's max applied `when`
-- (0015 = 1782300000000) so the stock migrator never skips it on prod.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "disabled_reason" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "disabled_by" text;--> statement-breakpoint
-- FK matches schema.ts: disabled_by SET NULL so removing the acting admin's row
-- never breaks the disable record (the actor id stays in admin_audit_log).
-- Guarded so a re-run is a no-op.
DO $$ BEGIN
	ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_disabled_by_users_id_fk" FOREIGN KEY ("disabled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
