-- Superadmin dashboard data model — a NEW platform-admin surface. Adds:
--   * admin_users       — the superadmin role (a row with is_superadmin=true =
--                          superadmin). Revoke keeps the row for audit.
--   * admin_audit_log   — GLOBAL audit trail for superadmin actions (the existing
--                          audit_log requires workspace_id, unusable for global ops).
--   * users.suspended_*/deleted_* — moderation columns (suspend + SOFT delete).
--   * subscriptions.purchase_platform — checkout origin, for reporting.
--   * daemons.deployment_mode — the DualStorage mode the daemon reports.
--
-- Additive + backward-compatible + IDEMPOTENT (CREATE TABLE / ADD COLUMN /
-- CREATE INDEX IF NOT EXISTS, guarded ALTER TABLE ... ADD CONSTRAINT), matching
-- the repo's hand-applied-prod convention — see 0012_outgoing_webhooks.sql /
-- 0014_group_dm_channels.sql / RUNBOOK.md. The new nullable columns default to
-- NULL so every existing row stays byte-identical; the OLD relay tolerates them.
-- Safe no-op on a re-run; nothing existing is touched.
--
-- The new 0015 journal `when` is stamped ABOVE the live DB's max applied `when`
-- (0011 = 1782000000000) so the stock migrator never skips it on prod.
CREATE TABLE IF NOT EXISTS "admin_users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"is_superadmin" boolean DEFAULT true NOT NULL,
	"granted_by" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by" text,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_user_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- users moderation columns — all nullable, NULL = active/normal (no regression).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "suspended_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "suspended_by" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deleted_by" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "purchase_platform" text;--> statement-breakpoint
ALTER TABLE "daemons" ADD COLUMN IF NOT EXISTS "deployment_mode" text;--> statement-breakpoint
-- FKs match schema.ts. admin_users.user_id cascade-deletes with the user;
-- granted_by/revoked_by SET NULL so removing the acting admin never breaks the
-- grant record. users.suspended_by/deleted_by SET NULL for the same reason.
-- Guarded so a re-run is a no-op.
DO $$ BEGIN
	ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "users" ADD CONSTRAINT "users_suspended_by_users_id_fk" FOREIGN KEY ("suspended_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "users" ADD CONSTRAINT "users_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Hot lookup ("is X an ACTIVE superadmin") + the small admins list. Partial so
-- the index only covers the (few) active rows, not revoked history.
CREATE INDEX IF NOT EXISTS "idx_admin_users_active" ON "admin_users" USING btree ("is_superadmin") WHERE "admin_users"."is_superadmin" = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_admin_audit_created" ON "admin_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_admin_audit_actor" ON "admin_audit_log" USING btree ("actor_user_id");
